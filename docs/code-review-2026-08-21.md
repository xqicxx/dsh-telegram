# dsh-telegram 代码审查报告（只读，未改动任何代码）

- 日期：2026-08-21
- 范围：`src/` 全部 47 个文件（约 14,000 行 TS）+ 横切面扫描（常量/console/promise/catch/env）
- 方法：4 路并行深审（index.ts 巨石 / adapters 大文件 / adapters 小文件+bridge / config+extensions+横切）+ 主审独立精读与逐条抽查验证。下述 🔴 级结论全部经主审在源码中二次确认。
- 基线健康：`tsc --noEmit` 通过；`npm test` 395/395 通过；工作树干净（c84db7f）。
- 约束遵守：本报告只给结论与建议，不执行任何修改；所有建议均不删除现有功能（死代码除外——它们无任何调用方，删除不影响任何行为）。

## 问题总览

| 级别 | 含义 | 数量 |
|---|---|---|
| 🔴 | 确认的逻辑 bug（用户可感知或造成泄漏/卡死） | 8 |
| 🟠 | 边界/竞态/安全风险（特定序列可触发） | 18 |
| 🟡 | 冗余、耦合、可精简点（解耦与瘦身目标） | 20+ |
| 🔵 | 性能改进点 | 12 |

---

## 一、🔴 确认的 bug（按危害排序）

### 1. 冷会话（非驻留内存）的 /history、轨迹、搜索永远为空
- 位置：`src/harness/adapters/sessions.ts:528-529`（readHistory）、`:585-586`（readTrajectory）、`:502`（searchSessions 持久化分支）
- 事实链：同文件 `:69-72` 接口注释明确写着真实 `SessionPersistence.readRaw` 返回 `{ meta, filename, content }`（JSONL 文本），只有旧测试桩直接给 `events`；`listSessionDetails`（`:403`）做了正确回退 `raw.events ?? parseRawEvents(raw.content)`，而上述三处只写 `raw?.events ?? []`。
- 后果：生产环境对任何未驻留内存的会话，历史/轨迹分页/子代理历史/冷日志搜索全部静默返回空。测试全绿是因为测试桩走 `events` 形态——典型的测试替身漂移。
- 建议：抽唯一入口 `loadSessionEvents(ctx, sessionId)`（live → readRaw → content 回退），四处调用点收敛；补一条用 `content` 形态桩的回归测试。

### 2. 审批/提问卡投递失败被吞 → agent 永久等待
- 位置：`src/harness/adapters/interactive.ts:401-411`（askViaTelegram）、`:477-484`（approval 监听器）
- 事实链：`broadcastForSession(...).then(delivered => { 零投递则 settle/reject }).catch(() => {})`。broadcast **reject**（网络错误）时 `.then` 不执行，零投递保护（注释声称防住 LOOP_AUDIT #4）被绕过：pending 留在 map 里，工具执行的 promise 永不落定，agent 在一张从未发出的卡上无限等待。
- 建议：改 `.then(onOk, onFail)`，失败分支与零投递分支走同一条 `settle("cancelled")` / `reject` 路径。

### 3. opencodeGo 路由探测的单例 promise 一旦 reject 永久卡死
- 位置：`src/harness/adapters/opencodeGo.ts:136-157`（`void provisioning.then(() => { provisioning = undefined })` 只清成功态）；`:82` `settings.describe(...)` 在 try/catch 之外
- 后果：settings 服务一旦抛错，`provisioning` 永远是那个已 reject 的 promise——此后所有模型选择都拿到同一个 rejection（且是 unhandled rejection）。路由功能永久失效直到重启。
- 建议：改 `.finally(() => { provisioning = undefined })`，并把 `describe` 纳入 try/catch。

### 4. overlayConfig 深层节整体替换：一条配置命令可静默清掉同级配置并持久化
- 位置：`src/config.ts:484-491`（overlay 循环）+ `:361-367`（media 归一化从默认重建）+ 持久化点 `src/index.ts:375`
- 事实链：`for (const key of Object.keys(rawSection)) out[key] = normalizedSection[key]`。一级键本身是对象时（现仅 `media.transcribe`），`normalized` 是「默认值 + 本次 patch」重建的产物，current 里的同级叶子全丢。实际触发：`/config set media.transcribe.apiKey sk-x` → 磁盘与运行态的 `baseUrl`、自定义 `model` 被清空。与同函数对一级叶子的部分更新语义自相矛盾（`:479-480` 注释宣称"只动出现的键"）。
- 伴生问题：未知键会写入 `undefined` 且虚报 "applied live + persisted"（`:490` + `index.ts:4171`），如 `{outbound:{typoKey:1}}`。
- 建议：对值为纯对象的子键递归做一层 per-key overlay（深度 2 即可覆盖现有 schema）；归一化后不存在的键跳过；补回归测试。

### 5. Bar 按钮的 Abort/Stop 不清理后台循环（三路 abort 不一致，#48 修复不完整）
- 位置：`src/index.ts:2835-2846`（dispatchBarButton）缺 `abortChatLoops(chatId)`；对照 callback 路径 `:2600-2601` 与命令路径 `:2949` 都有
- 后果：从 Bar 中止后 typing keepalive / live-feed 定时器继续运行。
- 建议：三处收敛为一个 `abortChat(chatId, opts)` 辅助函数——这也是"改了两处漏一处"类缺陷的根治法（见 🟡-1 动作注册表）。

### 6. compaction「ask」策略在未绑定聊天的会话上永久卡死询问
- 位置：`src/harness/adapters/compaction-watch.ts:186-192`
- 事实链：`state.pendingApproval = true`（188 行）先设置，之后才判 `chatId !== undefined` 才发卡。无绑定时卡片永不发出，但 `pendingApproval` 保持 true 挡住后续所有 step/end；`lastTriggerAt = now`（185 行）也在知道能否投递前就消耗了冷却窗口。
- 建议：拿到 chatId 并实际发起询问后才置位/计时。

### 7. SessionLifecycle.close 不清理模型选择 → `selections` Map 泄漏
- 位置：`src/harness/adapters/sessions.ts:1156-1174`（close 无清理）；对照 create-replace 路径 `:1132` 和 deleteSession `:1018` 都调了 `releaseModelSelection`
- 后果：对某会话 `/model` 切换过再 `/stop` 关闭 → 条目泄漏、dispose 闭包永不执行。每次"切换+关闭"稳定累积。
- 建议：把 `releaseModelSelection(agentId)` 收进 `close()` 本体，删除两处散落调用（销毁路径收敛为一条主干，见 🟡-8）。

### 8. teardown/eject 漏清 `typingRearms` + 扩展刷新会"复活"已关闭的菜单卡
- 位置：`src/index.ts:251-253`（teardownMount 清了 typingLoops/runningTurns，漏 `typingRearms.clear()`）；`ejectChat`（`:286-301`）同样漏；`refreshExtensionUi`（`:407-412`）遍历 `menuPageIndex` 重开菜单，而 close 路径（`:2563-2567`）与 `ejectChat` 都不清 `menuPageIndex`
- 后果：热重载后旧重臂预算残留（同名 chat 首个长 turn 约 10 分钟即被误杀 typing）；用户已关掉菜单的聊天在扩展热插拔时凭空弹出菜单卡；`menuPageIndex` 按 chat 无界增长。
- 建议：`ejectChat` 复用 `abortChatLoops`；卡片关闭路径同步删 `menuPageIndex`（或 refresh 只刷 `activeCardRenderers`）。

---

## 二、🟠 风险（边界 / 竞态 / 安全）

### 安全与多聊天隔离
1. **`m:allowthis` 白名单可自授权**（`src/telegram/router.ts:91` 硬编码绕过 whitelist 检查；`src/index.ts:2652-2665` 把任意聊天写进 `allowedChatIds` 并持久化）。任何能搜到 bot 的陌生人：发任意消息 → 点"Allow this chat" → 获得整台 harness 的会话/文件/命令控制权。单人自用是刻意的 bootstrap 通道，但建议加配置门（如 `security.selfAllow`，默认关）或 `/start <配对码>` 机制，并在 README 明示信任模型。
2. **未绑定聊天可经 legacy 回退"偷走"其他聊天的 agent**（`bridge.ts:134-147` resolveAgent 对从未绑定的 chat 回落 `currentAgentId`/`agents[0]`；`:272` `touch()` 没有 `bindAgent:192-201` 的一对一排他清扫 → 两个 chat 映射同一 agent，事件按插入序只路由给旧 chat）。当前 index.ts 主入口先建会话再 deliver，恰好打不出来；但 `deliver` 是公开 API。建议：`touch()` 纳入排他驱逐，或 `deliver` 对未绑定 chat 返回明确错误。
3. **`inboundForAgent` 的 legacy 兜底可消费别的聊天的 quote 目标**（`bridge.ts:244-248` 查无 chat 时返回 `this.inbound`）。
4. **7 个单槽 `pending*` 输入变量跨 chat 互相覆盖**（`src/index.ts:2297-2301, 2710-2711`）：两个聊天同时进入 Steer/Search/Rename 等提示态时后者覆盖前者（chatId 守卫防住了交叉消费，但先来者的流程被静默丢弃）；且多数无取消途径——放弃 Steer 后下一条普通消息会被劫持。建议 `Map<chatId, PendingIntent>` + 过期时间 + `/cancel` 统一清理。
5. **`goal-clear-confirm` 忽略 mint 时携带的 `agentId`**（`index.ts:2020-2029` 用 `currentAgent(chatId)` 重解析；对照 `subagent-interrupt-confirm:2065-2068` 正确用了 payload）——确认前切换会话会清错 goal。
6. **interactive 模块级单例状态跨挂载累积**（`interactive.ts:186-194`）：`attachInteractive` 把 `allowedTools` 累加进 `grantedTools` 不清空，热重载后陈旧的永久放行授权残留，安全语义漂移。
7. **host/workspace 浏览无根目录约束**（`host.ts:75-100,126-134`、`workspace.ts:65-74` 接受任意绝对路径）：信任模型是"allowlist 内的 chat = 全盘管理员"（含 ~/.ssh）。单人可接受；多 chat 场景建议加可选根目录白名单配置。

### 生命周期与热重载
8. **核心 re-apply 后扩展缝失效**：`stopLiveFeed` 不在 `buildExtensionHost()` 字面量里（`index.ts:3714-3746` 每次 spread 重建新对象），依赖 openclaw 对旧实例动态赋值（`openclaw.ts:376-387`）——core 单独热重载后 `stopLiveFeed === undefined`，#48 的 Abort 清理静默失效；新 Bridge 也不再持有 assistant consumer，可能双份投递或误发 NO_REPLY 提醒。建议：把缝提升为 ExtensionHost 正式方法 + 显式注册 API，service 重建时可重放。
9. **`host.applyConfig` 先改内存后写盘**（`index.ts:370-377`）：writeConfig 抛错（只读盘/权限）时运行态已生效而磁盘未变（重启回滚），且异常裸抛进扩展回调。建议先写盘成功再提交内存，或失败回滚并告知。
10. **模块加载期副作用**（`index.ts:204-208`）：顶层 `readConfig()`——坏 JSON 会让插件 import 直接失败而非可诊断降级；`findWorkspaceRoot(cwd)` 连算 3 次。建议全部惰性化/挪入 apply()。
11. **re-apply 时新旧 transport 短暂并行轮询**（`index.ts:232-234` fire-and-forget stop + 同步重建）：存在 Telegram 409 Conflict 窗口。建议 apply 在重建前 await 旧 stop。
12. **openclaw 占位符孤儿窗口**（`openclaw.ts:528-557,572-611,388-393`）：`draft.sending` 在途时新 turn/start 或 teardown 会弃草稿，旧 send 落地后 messageId 被守卫丢弃 → 永久的 "⚙️ Working…" 残骸（placeholder storm 家族残留形态）。建议 turn/start 移交 `previous.sending` 或记入孤儿列表在 turn/end 统一删除。
13. **turn/end 最终答案投递失败无降级**（`openclaw.ts:678,694-707`）：answers 已删、inbound 未答、提醒通道已被 consumer 抑制 → 用户零产出且无提示。建议 catch 里发一次性降级通知并保留 inbound pending。
14. **teardownMount 时序**（`index.ts:233-239`）：用正在停止的 transport 删 bar-carrier，失败仅入日志 → 热重载后可能残留带回复键盘的空载体消息；模块级 `telegramService` 从不复位。

### 其他边界
15. **typing keepalive 长回合误杀**（`index.ts:583-590`）：`rearmCount > rearmLimit` 先于 `agentRunning` 判断，预算只在 turn 边界重置——单一 turn 超过约 30-40 分钟后，即使 agent 仍在跑 typing 也会停。注释自称"live agent 状态是权威的"，实现与之矛盾。建议 `turnStillRunning` 为真时清零预算。
16. **`model-select` 悬空绑定被当成功并持久化模型**（`index.ts:1952-1968` 对照 `:804-810`）：绑定存在但 agent 已释放时 `onlyIfUnbound` 短路返回 ok，随后无条件写 `state.config.model`——模型实际未应用到任何会话。
17. **`resumeSession`/`stop` 缺省取 `agents[0]`**（`sessions.ts:734,1181`）：多聊天下可能拿到/误杀别的聊天的回合；`presets.ts:129` 中段切换继承同题。建议缺省时 fail。
18. **无超时边界的 await 三处**（`compact.ts:18-19` AbortController 从不 abort；`commands.ts:42` 同；`llm.ts:144` discoverModels 无 signal）：卡死即挂起 Telegram 命令处理。统一用 `host.ts:16-30 withFsTimeout` 模式。
- 其余已确认的小风险：`watchtoggle` check-then-act 竞态（`index.ts:2664`）；`selectAgentPreset` 对畸形 agent 同步抛（`presets.ts:72`）；中段切换失败留孤儿 fork 会话（`presets.ts:146-154`）；`dispatchPhotos` 部分失败不释放已存附件（`index.ts:3471-3479`）；`deleteSession` 绕过 SessionLifecycle 记账、句柄残留（`sessions.ts:1013-1041`）；增量缓存"同长度换数组"盲区（`todos.ts:50-51`、`status.ts:228`）；`DSH_HOME` 未设时导出缝探测跳过默认 home（`downloads.ts:33-44`，与 `mode.ts:19-20` 的 `dshHome()` 不一致）；`history-older` 的 `beforeSeq` 缺失被 `Number("")===0` 当有效游标（`index.ts:2215`，当前 mint 恒带该键，属防御缺口）；`cardLoad` 超时后底层 load 继续空跑无去重（`index.ts:660-680`）。

---

## 三、🟡 冗余 / 解耦 / 精简（本次目标的主战场）

### 1. index.ts 巨石（4323 行）——最大的结构性问题
- 现状：装配 + 卡片库（约 30 个 openXxxCard）+ 三个 dispatcher（161 个 `case`，仅 dispatchCallback 就 ~406 行）+ 命令实现 + 媒体 + 工具注册 + 事件接线；模块级可变容器约 25 个（todoSnapshots、typingLoops、runningTurns、typingRearms、statusSubagentCounts、sessionCreateChains、activeCardRenderers、menuPageIndex、cardOrigins、pendingStartAfterAllow、5 个 pending*、state 内 8 个 Map…）。
- 直接恶果：`teardownMount()`（`:226-285`）靠手工逐一枚举复位——已经实际漏了 2 个（🔴-8）；`ejectChat` 同样靠手工记忆。每加一份状态都要"记得改两处"。
- 拆分方案（保持 `telegram/ 不 import dsh、harness/ 不 import grammy` 的现有边界）：

| 新模块 | 内容（现行号） | 职责 | 约行数 |
|---|---|---|---|
| `core/chat-hub.ts` | typing/bar/menu/pending/todoSnapshots 的 per-chat 状态（570-640、3602-3691、880-883、194-198） | per-chat 生命周期唯一属主：`disposeChat/disposeAll` | ~300 |
| `core/cards.ts` | openCard/activeCardRenderers/cardLoad/widenCard/askConfirm（852-878,655-680,873-878） | CardRegistry：打开/替换/刷新/超时 | ~150 |
| `cards/{sessions,models,presets,workspaces,host,goals,queue,misc}.ts` | 945-1901 按域切开，各域带走对应 case 段 | 每域导出 `openXxx` + `registerActions(registry)` | ~1100 |
| `core/dispatch.ts` | 1903-2708、2770-2832 路由骨架 + 统一动作注册表 | token/callback/bar 三入口共享一张 action→handler 表 | ~300 |
| `core/commands.ts` | 2834-3439 + TELEGRAM_COMMANDS + /help | 纯命令实现 | ~650 |
| `media/attachments.ts` | 459-539、3457-3521 | 出站附件 + 入站媒体 | ~180 |
| `core/tools.ts` / `core/events.ts` | 4180-4320 / 3862-3964 | 工具注册 / 事件订阅 | ~330 |
| `index.ts` | apply() 装配段 | 退化为纯装配 | ~250 |

### 2. 三个 dispatcher 重复实现同一批动作（约 400 行，最大冗余源）
- `new` 三处（2639/2781/2912）、`compact` 三处（2647/2789/2918）、`abort/stop` 三处（2576/2818/2927）各抄一遍——🔴-5 正是复制漂移的直接产物；纯开卡片的 case 在三处重复。
- 建议：`const actions: Record<string, Handler>` 统一注册表，三个 dispatcher 退化成薄路由。

### 3. bridge.ts 双状态收敛（~80 行改造，不动外部契约）
- 现状：`chatStates` Map（事实源）+ legacy 四件套 `currentAgentId/activeChat/inbound/reminded`，写点分散 5 处、读点全做"`chatId ?? activeChat` 双查"舞蹈；`this.reminded` 只写不读（死镜像）；`markNoReply` 先置 `noReply=true` 又立刻清空 inbound（双重簿记取其一）；`detach` 不清 `assistantConsumer`。
- 收敛方案：① `chatStates` 唯一事实源，删四件套；② 加反向索引 `chatByAgent: Map<string, number>`（touch/bindAgent/detach 同步维护）——`chatIdForAgent` 变 O(1)，一对一排他成为索引层天然约束，同时喂饱 bridge/openclaw/goal-progress/compaction-watch/index 共 10+ 个线性扫描调用点；③ 兼容视图改推导（`lastTouch` 指针）；④ `deliver`/`deliverImageContent` 合并为 `deliverContent`（现约 20 行近似重复）；⑤ 事件监听器里裸调 `consumer(...)` 包 try/catch（对照 notifyStateChange 有保护）。

### 4. sessions.ts（1196 行）god-module 拆分 + 公共抽取
- 拆：`session-read.ts`（list/search/history/trajectory 只读查询）/ `session-lifecycle.ts`（create/resume/close/stop/delete + selections 注册表）/ `session-render.ts`（标题/分组/排序）。
- 抽：`loadSessionEvents`（根治 🔴-1 类）、`toErrorText(err)`（消灭 ~20 处 `instanceof Error` 三元）、`formatToolCall`（snippetOf 与 trajectory 内联逐字重复）、`lastEventSeqOfType`（titleFor/forkSession/lastTurnEndSeq/三处 blank 判定同一模式手写 5 遍）。
- 销毁主干唯一化：`selections`、`savedAttachments`、approvals/questions、watcher states 都暴露 `release(sessionId)`，只由 close/deleteSession 调用（🔴-7、🟠-14、🟠-6 的共同根因）。

### 5. CardSession 抽象（interactive 三套平行卡片流）
- `interactive.ts:213-241 / 382-412 / 457-485` + index.ts compaction 询问卡 = 四套"mint → 广播带键盘 → messageIds → settle 就地编辑"的平行实现；🔴-2 的投递失败兜底漏洞正是复制粘贴各自为政的产物。抽 `CardSession { deliver/settle/dispose }` 一处收敛"零投递/投递失败/abort 监听清理"。

### 6. 小型重复（可直接精简）
- `withTimeout` 双写（`transport.ts:16`、`index.ts:670`）；serialize-per-key 链 4 份（queue/ephemeral/status-panel/router + sessionCreateChains）+ `noop` 3 份 → 一个 `serializePerKey` 助手。
- transport 四个媒体方法 `sendDocument/sendPhoto/sendVoice/sendAudio` 逐字相同（transport.ts:322-359）→ `sendMedia(method, ...)`。
- settings.ts update/replace/mutate 三胞胎（113-152）→ `withSettingsWrite(fn, label)`；credentials 单条/批量渲染重复（37 vs 62-64）。
- models.ts 与 llm.ts 两套目录构建器、两种 `ModelEntry` 形状 → 收敛 llm.ts 一套。
- 分页样板：`Number(payload["page"] ?? "0")` + 守卫 ≥10 处、`uiSend(res.ok ? plain(res.text) : "❌…")` ≥20 处、卡片内 totalPages/safe/pageItems/prev-next 四件套 6 处 → `pageOf(payload)` / `report(chatId, res)` / `paginate(items, page, size)`。
- 常量重复：`LIVENESS_HEARTBEAT_MS=30_000` 双定义（openclaw.ts:41 ≡ goal-progress.ts:91）；`baseDelayMs:500` 双写（index.ts:308,3786 + queue 默认第三份）；`whisper-1` 双处；`'medium'` 三处（`REASONING_DEFAULT` 导出无人用）；4096/60_000/30_000 多处裸字面量；`DSH_HOME` 解析三种写法（`dshHome()` 已存在未被复用）。
- capabilities.ts `CAPABILITY_LABELS` 是恒等映射（label===key），且文件头注释"Every adapter consults this first"与实际（各适配器自行 ctx.get，矩阵仅 /capabilities 展示用）文档漂移。

### 7. 死代码清单（无任何调用方，删除不影响任何功能）
- `pendingWorkspaceCreate`（index.ts:2711）：全文件无赋值点，`/cancel` 分支（2918）与 onUserText 分支（4045）永不可达。
- `ephemeral.ts` 的 `lastText/lastMarkup`（19-20 行）：只写不读的整套簿记（~15 行）。
- 死导出 6 个：`goals.completeGoal`、`sessions.listSessions`、`sessions.imagePrompt`、`keyboard.buildCoreMenu/buildJobsKeyboard/buildFeedbackKeyboard`；再导出 2 个：`interactive.ts:651 export { randomUUID }`、`downloads.ts:127 export { SessionId }`。
- 残迹：`bridge.ts` `this.reminded` 死镜像；`sessions.ts` `this.handle` 单句柄字段（已被 handles Map 取代）；`plugins.togglePlugin` 持久化失败分支与成功分支逐字相同（224-226）；`status.ts:243-245` 三元第三分支不可达；`subagents.ts:110` 造一个永不可达的 AbortSignal；`reasoning.ts:38` `LABEL[effort] ?? effort` 死兜底；`sessions.ts:532` `void live`（算了又扔）。
- `index.ts:642-643` 文件中部 import + re-export → 移头部/独立 barrel。

### 8. 设计取舍值得复议的点（不拆功能，只建议收口）
- `opencodeGo.ts`：把特定网关的兼容修补（硬编码模型清单、上游 URL）编译进通用插件，本质是声明式 settings 数据——至少应抽配置 + 写明移除路径（检测不到 opencode-go 时已正确 no-op）。
- `dynamicCordis.ts` 的 `[key: string]: unknown` 透传 → 白名单化到已声明字段。
- `assertValidRequest`（interactive.ts:135-165）是服务端校验的手抄副本，注释自认——规则漂移风险。
- `encodeSegment`（sessions.ts:987-1008）手工镜像 dsh 私有编码器 → 至少加对照真实后端输出的回归测试。
- 未知命令靠错误文案嗅探（index.ts:3427-3436 `res.text.includes("unknown or malformed…")`）→ 让 executeCommand 返回结构化 `{handled}`。
- `log()` 全走 `console.error`（info/error 不分）；openclaw 5 处直连 console（扩展无 logger 通道，:317 每个成功回合都打统计属常态噪音）。
- `attachFeedback` 死缝（types.ts:57-58 契约 vs index.ts:392-395 恒空实现 vs openclaw 仍按有效语义调用）。
- openclaw reasoning 流缓冲"保头弃尾"（openclaw.ts:753-756 `slice(0, 600)`）：长思考冻结在开场 600 字符，最新思考永远不可见——若意图是流式观感应保尾。
- `applyConfigLive` 语义缺口：workspace.activePath 清空不回落 boot 目录（:321-326）；watch.autoStart 置 false 不停轮询（:312-314，开关不对称）。

---

## 四、🔵 性能

1. **刷新风暴（最高收益）**：bridge 对 tool/call、tool/result、step/start、step/end、assistant/message、turn/start 每事件调 `notifyStateChange` → `refreshAllPanels`（index.ts:3553-3571）遍历所有 chat 做 `renderStatus`（内含 listJobs+statusSnapshot+listTodos）+ editMessage + scheduleBarSync，另有 15 个转发/host 事件打进同一通道。子代理计数有 5s latch、StatusPanel 有同文本跳过，但**渲染前段与合并窗口都没有节流**。建议 300-500ms 尾触防抖 + 脏标记；tool/result 这类高频低价值事件可剔除。
2. **`chatIdForAgent` 多点线性扫描**：bridge.ts:435 在事件类型过滤之前调用（高频流式事件逐个全扫 Map），同样的扫描独立存在于 index.ts:3866/3913、goal-progress.ts:110、compaction-watch.ts:161/189、openclaw.ts:565 等 10+ 处。反向索引一次解决（见 🟡-3）。
3. **`listSessionDetails` 串行读全部冷日志**（sessions.ts:393-421）：每次 Sessions 卡打开 + 每次面板刷新都付 N 次顺序文件读+全量 JSONL parse。建议有界并发 + 按 mtime 缓存。
4. **`searchSessions`**：`liveSessions(ctx)` 双调（487/490）；live 循环缺 `hits.length >= limit` 的 break（479-486，限额检查在循环外）——100 个匹配会话、limit=20 时仍全量倒扫所有会话。
5. **`readTrajectory` 每回合 O(n) 找 endSeq**（sessions.ts:636）：`rawTurns` 已存结束下标，直接取即可；`forkSession:719` 整表 `[...events].reverse()` 同类。
6. **llm.ts 目录构建全串行**（74-97）：provider 逐个 await + provider 内 model 串行；对照 models.ts:28-38 已并行。两层 Promise.all。
7. **downloads**：export seam 每次重新 readdirSync+resolve+动态 import 且不记负缓存（33-61）→ 模块级缓存；`Buffer.concat(chunks.map(Buffer.from))` 双重复制最多 100MB 峰值（120）→ 直接 concat。
8. **`sendWorkspaceAttachments`**（index.ts:474-542）：最多 10×50MB 全量读入内存、串行发送。建议流式/有界并行，发送前已校验大小时可省一次全量读。
9. **splitText 重解析**（html.ts:150-190）：每个分片从 0 重扫标签栈，超长输出 O(parts×len)。增量维护标签栈可解（典型消息无感，大输出有感）。
10. **`renderStatus` 重复计算**（index.ts:717-720）：`progressFor(chatId)` 调 4 次；`openMenuAt` 每次翻页重建两页菜单+完整 renderStatus（894-939）。
11. **openclaw teardown 不清定时器**（388-393 直接 chats.clear()）：throttle/retry 定时器最久存活 30s 且未 unref（heartbeat 已 unref），热重载后短暂拖住事件循环——effect 里遍历 draft 调 clearTimers。
12. **markdown 表格宽度双算**（markdown.ts:164,172）：cellDisplayWidth 每格算两遍 → 一次算好存矩阵。另 `syncBar` 未变更也打日志（index.ts:3684，每 chat 每 1.5s 一条）；apply 时向所有 allowedChatIds 广播新 bar carrier（3969-3973）。

---

## 五、做得好的地方（重构时不要丢）

- 分层边界清晰：`telegram/` 不依赖 dsh、`harness/` 不依赖 grammy，适配器无对 index 的反向依赖（已验证）。
- `queue.ts` 速率限制/重试分类（429 retry_after、5xx、AbortError 不重试）严谨且可注入测试。
- `status.ts` 的 WeakMap 事件扫描缓存已根治过 O(n²)；`tokens.ts` 双台账有界；`ephemeral.ts` 的"message is not modified 即成功"分类正确。
- 适配器统一 `xxxOf(ctx)` 结构化子集 + `AdapterResult`；compaction-watch 全依赖注入；`disposeWithin` 超时兜底；`parseRawEvents` 对撕裂尾行容忍。
- 395 个测试、无字面空 catch、无 unhandledRejection 隐患的 fire-and-forget 纪律（`void safeWrap` / `run.then(noop, noop)` 存尾）。

## 附录 A：审查期间工作树出现并行改动（issue #50）

审查进行期间，工作树进入了一组并行功能改动（未提交，基于 c84db7f）：`dynamicCordis.ts`（+190 行，动态插件 define/run/stop/undefine 生命周期）、`index.ts`（+101 行，plugin-* 卡片与 case）、`keyboard.ts`（+18）、`transport.ts`（±21）、package.json。本报告主体基于 HEAD c84db7f 的行号；经在**当前工作树**复验：

- 全部 🔴 头条结论仍然成立；index.ts 内的行号整体偏移约 **+76**（如 Bar abort 现位于 ~2911、pendingWorkspaceCreate 声明现于 2802、teardownMount 现于 ~302 起）。
- 复验确认仍存在：Bar Abort 无 `abortChatLoops`（现三处调用点 2478/2676/3036，bar 分支仍无）；`pendingWorkspaceCreate` 仍无任何真值赋值点；teardownMount 仍不清 `typingRearms`；`m:allowthis` 白名单绕过仍在。
- 未被该改动触碰的文件（sessions/interactive/bridge/config/opencodeGo/compaction-watch/queue/ephemeral 等）行号不受影响。

对新增 #50 代码的两点快评（顺带记录）：
1. `plugin-run/plugin-stop/plugin-remove-confirm` 都用 `currentAgent(chatId)` 现解析会话，而不是把渲染卡片时的 agentId 铸进 token——与本报告 🟠-5（goal-clear-confirm 忽略 payload agentId）同族：卡片渲染到点击之间若聊天重绑了新会话，操作会落到新会话的作用域上。建议统一"confirm/token 携带 agentId 并优先使用"。
2. `defineDynamicCordis` 把用户提供的 JS 源码交给 runner.define，走标准 approval 通道——信任模型与 web 面板一致，可接受；但 Telegram 消息里贴大段 JS 容易被 4096 限长截断成语法错误的半截程序，建议在错误提示里明确"源码可能被截断"。

## 六、建议修复顺序（供决策，不执行）

1. 🔴-1 冷会话历史恒空（抽 `loadSessionEvents` + content 形态回归测试）——用户可感知的功能性 bug。
2. 🔴-4 overlayConfig 数据丢失（递归 overlay + 未知键跳过 + 回归测试）。
3. 🔴-2 / 🔴-3 两个"永久卡死"类（CardSession 抽象顺带解决前者）。
4. 🔴-5/6/7/8 生命周期清理类（动作注册表 + 销毁主干唯一化顺带解决大半）。
5. 🟡-1/2/3 三大结构性收敛（index 拆分、动作注册表、bridge 收敛）——建议分三个独立 PR，每步跑全量 395 测试。
6. 🔵-1/2 两个事件路径优化（防抖 + 反向索引）。
7. 死代码与常量清理随手提交。

—— 完 ——
