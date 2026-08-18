# dsh-telegram 发现记录

## 2026-08-16 Round 1

- 基线 `npm run check` 在 `src/harness/adapters/sessions.ts(84,10)` 报 TS2352：
  `AgentRegistry` 转成自定义 `AgentLike[]` 时，`Agent` 类型没有 `dispose` 属性，而
  `AgentLike` 要求 `dispose(): Promise<void>`，两类型「不够重叠」。
  → 真实 `Agent` 的释放走 `AgentHandle.dispose()`，`ctx.agents.get()` 拿到的 Agent 本身没有 dispose。
  → 已修：接口只保留稳定结构子集（id/session/options），释放路径运行时 cast。
- 仓库已有大量未提交工作（index +451、bridge +274 等），TESTING.md 说 147/147，
  但当前工作区实际 build 失败 → 计划记录不可完全采信，本轮必须以本地实测为准。
- TESTING.md 已覆盖到 14 节：安全/热重载/transport 竞态/顺手化 8 项修复后 147 测试。
- 依赖版本锁定：dsh-agent 0.1.0-rc.6；`AgentRegistry.create/resume` 返回 `AgentHandle`。

## Round 1 代码审查发现（已修复）

1. 基线 TS2352（见上）。
2. `SessionLifecycle.create` 语义从「继承任意 live agent」改为 profile default；原单测还是旧断言。
3. `NEW_BTN`/`/new` 直接 create 不复用 `createSessionForChat` → 本 chat 旧 agent 不被替换（泄漏）。
4. `Bridge.bindAgent` 同 chat 换绑不清旧 inbound → 新会话回复会引用旧消息 id；`resolveAgent` 在绑定 agent 已死时 fallback 到其他 chat 的 live agent → 多 chat 串台。
5. `assistant/message` 事件缺结构守卫，畸形事件会让监听器抛错。
6. 回调 chat id 提取顺序为 `callback.chat ?? message.chat`，与 Bot API 真实形状（chat 在 message 上）不符。
7. openclaw 新回合开始不清上一回合的 throttle timer → 旧草稿 edit 打进新回合。
8. router 无 per-chat 串行 → 快速连发两条首条消息可能并发创建两个 session。
9. approval/question 仍全 roster 广播（会话 A 的审批推给 B 聊天）。
10. `/telegram disallow` 与 security 热更新只从 roster 移除，不解除 bridge 绑定 → 已解绑会话仍可能通过 bridge 发消息。
11. `/use` 恢复会话后不 adopt `AgentHandle` → teardown 不跟踪。
12. `telegram_reply`/`telegram_mark_no_reply` 只看「最近触碰」inbound，两个会话并发时可能回错聊天。

## Round 2 发现与修复

- `outbound.liveFeed` 是死配置：openclaw 只认「是否挂载」。修复为 core 侧按配置忽略 consumer + 扩展逐事件检查，热切换生效。
- web `events.host`/remote 事件完全未订阅，导致其他面板改设置/插件后 Telegram 卡片陈旧。
- 危险操作中 workspace delete、preset remove、subagent interrupt 无确认；session delete 有确认但走「新消息 + 残留确认卡」旧路径。
- `/credentialset` 的 secret 明文会永久留在聊天历史。
- grammY `InlineKeyboard.row()` 陷阱再次出现：新 confirm 键盘若以 `.row()` 开头会多一个空行，以 `.row()` 结尾会多一个空尾行；正确写法是两个 `.text()` 不加 `.row()`。

## Round 3 发现与修复

- Sessions 卡只显示 15 条且无序，不符合 web `updatedAt desc` 语义；改为 adapter 排序 + UI 分页。
- History 详情没有「看更早」入口，`beforeSeq` 参数实际是死能力；接上 `Load older` token 流。
- `/goaledit` 丢掉 web 的 maxGoalRounds 能力；按 `/goalcreate` 同款解析补齐并加单测。
- Preset Copy 固定 `<id>-copy` 不符合人类操作；改为「点 Copy → 回复自定义 id」，`/cancel` 可中止。

## Round 4 发现与修复

- Models provider 卡一次只显示前 20 且无翻页；改为 12/页 token 分页。
- Plugins 卡截断 30 条且键盘没有翻页；新增通用 `buildPagingKeyboard`，20/页。
- `telegram_send`/`telegram_broadcast` 可由 agent 发给任意 chatId，绕过安全白名单；两个工具现在只接受 roster 内 chat。
- host/commands/jobs/dynamic 长期无单测；补齐 8 个用例（含 mkdir 递归失败语义）。

## Round 5 发现与修复

- `/ls` 只能发一大段文本，不符合手机逐级浏览习惯；Host 卡新增 `Browse cwd` 逐级点按浏览器，路径全部 token 化。
- 旧客户端残留 `h:ls` 按钮需兼容；路由统一映射到新浏览卡。
- Jobs 卡截断 20 条且无翻页；改为 20/页 + `buildPagingKeyboard`。
- Search 卡误用 Sessions 键盘（New/Stop/Search 与搜索结果混在一起）；新增专用 `buildSearchKeyboard`。

## Round 6 发现与修复

- `listSkills` 从不传 sessionId，违背 web skill.list 的「按会话项目根解析」契约；补 session 选项并兼容无 session 调用。
- Skills 卡把 model-only 技能和 user-invocable 混在一起；改为只展示 user-invocable 并显示隐藏数量。
- Search 取 20 条但 UI 只显示 10 条且无法翻页；改为取 100、10/页、token 翻页。

## Round 7 发现与修复

- `listSubagents` 只取 `{kind,id}`，丢失 web `SubagentListEntry` 的 mode/label/hasChildren/reason；补齐投影并兼容 legacy。
- one-shot/diagnostic 子代理详情仍显示 Prompt/Interrupt 按钮，点击会失败；改为只有 continuable 显示并在回调前二次校验。
- Subagent 列表 activity 与 web 的「存储快照」语义不一致；现在优先透传 `entry.activity`，旧服务回退 live status。

## Round 8 发现与修复

- document/voice/video 到达 getUpdates 后被静默丢弃；现在提取 metadata、白名单检查并回明确指引。
- 未授权 photo/document 同样静默；router 改为与文本一致地发 allow 提示。
- downloads 动态 seam 缺失路径没有测试；补 50MB 常量与 fail-closed 指引测试。
- 明确平台限制：web session.prompt 只接受 text/image（权威 schema 证据），文档/语音/视频不做假附件。

## Round 9 发现与修复

- web `credentials.describe` 是批量 `refs[]` 契约，TG 只能查一个；新增批量适配（≤64/去重/校验）。
- Host 卡 version 写死 0.0.1，误导用户；改为传入插件真实 version（0.2.0）。
- 权威确认：credentials 无枚举 seam，web 也不列出 ref 列表；卡片保持命令指引是正确的。

## Round 10 发现与修复

- `readImageAttachment` 用伪造的零字段 ref 读图，真实 `ctx.attachments.readImage` 会校验 bytes 与 ref 失败——这是死代码级 bug；改为记录真实 durable ref，并新增 `/attachment` UI 闭环。
- Host provider/model 取第一个 live agent，不符合 web `host.describe` 的 `agentDefaultModel` seam；已对齐并测试。
- 发布前 smoke import 验证三个 ESM 入口均可加载。

## Round 11 发现与修复

- agentPreset.list 缺 web `hasDocument` deployment fact；补透传并在 Presets 卡显示。
- 发布物缺 CHANGELOG；新增并把其纳入 package files。
- 版本号长期停在 0.2.0，与大量新功能不匹配；升至 0.3.0（package.json + lock）。

## Round 12 发现与修复

- host.createDirectory 没有浏览器内的 parent+name 按钮流，只能背路径；新增 New folder 单段回复流。
- 审计中 agentPreset.remove 仍标「无确认」，实际 Round 2 已实现；状态修正。

## Round 13 发现与修复

- `modelCatalog` 缺 web `SessionModels.routable`；按 web routeServed 语义补上（无 llm 时 true），Models 卡显示。
- provider 卡的 Thinking 行是死能力（builder 支持但从未传参）；接入 per-session 五档 picker 与 `selectSessionModel(effort)`。
- settings.describe 审计描述曾称 web 只暴露部分 namespace；权威源码显示 web 列出全部注册 namespace，修正审计。

## Round 14 发现与修复

- `ctx.settings.describe` 的 schema envelope 被 adapter 丢弃；补透传并在 namespace 卡展示。
- settings.describe 审计状态进一步收敛（web 同语义：全部 namespace + schema）。

## Round 15 发现与修复

- settings update/replace/mutate 未透传 web expectedRevision（并发编辑保护缺失）；命令支持尾随 revision，且 parser 保证 JSON 字符串内部空白不破坏。

## Round 16 发现与修复

- 权威源码显示 web api-proxy 将 subagent child 的 activity 重映射为 live agent status；此前透传持久化快照是语义错误。
- subagent.prompt 缺 clientTimeZone 与 AbortSignal；已按 web MessageSource 契约补上。

## Round 17 发现与验证

- `npm publish --dry-run` 通过（registry public access，真实发布需登录）。
- 自动化发布门槛已过；创建本地 tag `v0.3.0-rc.1`（推送/发布待实机验收）。

## Round 18 独立审计 + 实机冒烟

- 独立审计确认 2 个 P1（telegram_reply 失败吞、stop/start 竞态）与 5 个 P2；全部修复并加回归测试。
- npm audit --omit=dev：0 漏洞。
- 实机冒烟：真实 bot @XosEvolvesbot 长轮询启动、openclaw 挂载、getMe 正确、bar sync 已向 chat 8753447694 投递。

## Round 20 发现与修复

- 实机 bug：Bridge.notifyStateChange 方法体被此前改名操作误替换为自递归（`this.notifyStateChange()`），每次状态变更栈溢出，且日志只输出 `[object Error]`。
- 修复：改回调 `this.onStateChange()`；异常日志输出 `message + stack`；新增「回调恰好一次」与「异常含堆栈且只记录一次」两个回归测试。
- 实机复验通过：web 49733 派发两次 `/telegram status` 无任何 state-change 错误。

### Round 20 追加

- 主 profile 已配置的 `DEEPSEEK_API_KEY` 对 deepseek-official 返回 401（`****2dbe` invalid）；live profile 仅路由 deepseek-official。需用户更新有效 key。

## Round 21 独立审计 + 修复

- 独立审计确认 3 个发布阻断：版本导出漂移 0.2.0；HTML 长文本拆坏标签；SendQueue 对永久 4xx 全部重试。
- 另修复 3 个非阻塞：mo/set 回调 URI 编码、telegram_* 工具 HTML 契约、typing 循环 10 分钟自毁。
- `npm run check` 222/222；实机 opencode-go 全链路 LLM turn 完成（turn/end completed）。

## Round 22 发现与修复

- 审计遗留的展示串台：未绑定 chat 的 `boundAgentId` 回退最近 agent；已改为 chat 作用域 fail-closed，`statusSnapshot(fallbackToFirst=false)` 支撑。
- 卡片交互不符合 Telegram 习惯：approval/question 结算另发消息、旧按钮仍可点；改为原地编辑并移除 inline keyboard。

## Round 23 发现与修复

- token 注册表不是 single-use：确认按钮可重复执行副作用；抽为 TokenRegistry，单次消费 + 双账本有界 + 单测。
- /credentialset 删除命令消息依赖 500ms timer：改为队列序删除（先删密钥、再发回执）。

### Round 23 追加：实机首消息竞态

- 真实 Telegram 出现同一 chat 双会话：onUserText 首消息路径未 await，router FIFO 对会话创建窗口无效。
- 修复 + apply-race 集成回归（假 agents.create 延迟 30ms），227/227。

## Round 24 发现与修复

- 审计遗留 UX：未授权 /start 放行后不会自动进入欢迎流程；已改为 allow 后重放 /start。

## Round 25 实机验收证据

- 快速连发 1/2：仅一个 telegram 会话，第二条进同一 inbox（竞态修复实机通过）。
- Menu/Models/Queue/approval 回调全部真实走通；menucheck 等价探测 0 ❌。

## Round 25 发布动作

- main + v0.3.0-rc.1 tag 已推送 GitHub；pre-release 已创建并附 tgz。
- 真实 npm publish 未执行：本机无 npm 登录凭据；用户选择暂不发布 npm。

## Round 25 追加：用户实机 UX 反馈

- Workspaces 卡缺字段防抖、Project 增加 Menu 返回、Queue 条目编号+预览、移除 Sessions Search 按钮。

## Round 25 追加：workspace/preset/status 对齐

- Workspaces 全卡防死；Presets/Workspaces/Sessions 卡片在 web 侧事件后原地重读；Status 增加 router/subagents/jobs 计数。

## 交互逻辑迭代 Round 1

- router 对 command/bar/callback/photo 的 dispatch 未 await（fire-and-forget），已修复为真正 FIFO。
- Queue 编辑改为删除+ForceReply 重发；所有回复式输入用 ForceReply；/start 设置官方 MenuButtonCommands。

## 交互逻辑 Round 2

- buildMenuPage 的 m:page 页数按钮是无动作按钮，点击只有 spinner；已移除。
- m:back 固定回第 0 页不符合直觉；改为回到 menuPageIndex 记录的上一页。

## Round 2 追加：删除/归档修复

- deleteSession 目录名错配（encodeSegment `--~id--` vs 实际原始 id），改为双候选删除。
- archive 后回详情卡显示 archived；workspace create 后端验证通过。

## Round 2 追加

- Session 标题来自 session/title 事件，已补齐扫描；Cold session 也有名字。
- Workspace Create 改为目录浏览选择器，去掉抽象路径输入。

## Round 2 追加

- listJobs 用 SessionId 修正 caller；loadExportSeam 多根解析 profile 依赖；tool/call 片断渲染补齐。

## Sessions 按项目分组（web 对齐）

- 调研 web 工作区：标题链是 `session/title` 最新事件 → cwd 基名 → id；“继续”来自首条消息
  fallback + first-prompt LLM；workspace 分组权威是 `workspace.sessionIds`。
- Telegram 差距：标题兜底用首条用户消息（与 web 不一致）、冷会话丢 cwd、`running`
  误用“agent 已挂载”、Sessions 卡无项目维度。
- 修复：`displayTitleFor` 三级回退；冷 cwd 透传；running 用 `agent.status`；
  `groupSessionsByProject/orderProjectGroups/sortProjectSessions` 分组与排序；
  Sessions 卡默认活跃项目 + `🔀 项目` 切换 + `🌐 全部会话` 兼容；详情返回原项目。

## Round 26 发现与修复（issues 7-13）

- bar 收起慢的真凶不只是 router 通道：卡片/Bar 载体的发送仍走 assistant 同一条 per-chat SendQueue，流式编辑会把 UI 排到后面。修复为 transport 增加 `control:<chat>` 独立 lane，openCard/statusPanel/command ack/bar/typing 全走控制 lane；收起改 fire-and-forget。
- Goal 删除能力缺失：goals adapter 已有 clearGoal 但 UI 从未接线；补齐卡片按钮 + `/goalclear` + 确认卡，并明确 Goal 点击只读、绝不触碰 session。
- issue 11 的“kind=ok 但无消息”：sendText 只在 reply_markup 存在时打日志、失败路径缺 log 与用户兜底。修复为所有 send/edit/delete/chatAction 成功/失败全日志，关键命令 ack 失败后 raw Bot API 兜底一次，dispatch 异常向用户发可见失败。
- issue 12 的 typing/openclaw 静默：startTyping 空 catch、openclaw send/edit 空 catch。safeWrap 统一带标签记录，openclaw turn/start 立即发占位并在流失败时发用户可见 fallback。
- issue 8 无 `context_tokens` 服务：用权威持久事件（request/context + assistant/chunk usage）计算压力；ask 每轮压力段只问一次，compaction/summary+end 驱动完成通知。
- issue 9 的媒体组：getUpdates 批次内按 media_group_id 聚合为一次 onPhotos，Bridge.deliverImages 生成单条多图 user message；语音/文档落盘而非伪造 web attachment。

## Round 27 发现与修复（GitHub issues #14/#15）

- #14 的「m: 分支不存在」假设不成立：`CALLBACK_RE` 会匹配 `m:todos` 并进入 case "todos"；真正的卡死链路是旧版本占位风暴占满 content lane（Round 26 已把 openCard 移到 control lane）。
- `openCard` 已经走 `uiOps()`（control lane），所以 #14 的 Fix B 实际上已完成；本轮补的是实时刷新与生命周期。
- #15 的 4 个 bug 都真实存在：无 diff、120ms 节流、失败清 messageId、单字符占位。修复后测试从 220ms sleep 全部改为 1100ms（新节流语义）。
- Telegram 400/429 错误经 SendQueue 处理后到 openclaw 只剩 boolean，无法区分「消息没了」和「限流耗尽」；因此用「保留同消息 + 指数退避 + 5 次上限」策略兜底。
- Todo 卡 auto-refresh 若文本未变，Ephemeral 的 lastText 去重会跳过 edit；集成测试必须推入新的 `todo/write` 事件才能断言刷新真实发生。
- 新测试文件：`test/todos-card.test.mjs`、`test/todos-card-refresh.integration.test.mjs`；集成测试用 patched TelegramTransport 验证 5s tick 与 Close 停表。

## Round 28 审计：死锁/卡死/无限递归/循环

### 已确认并本轮修复（见代码）
1. **Todos 定时器“复活”卡（真 bug）**：`Status` 按钮/命令走 `ephemeral.open + statusPanel.refresh`，不经过 `openCard`，因此不会替换 `activeCardRenderers`；Todo 卡 5s 定时器认为仍是当前卡，会在 Status 卡上重新 `ephemeral.replace` 回 Todo 卡。→ 状态卡与 Todo 卡互相覆盖。
2. **`refreshStatusSubagents` 共享闩锁可永久卡住**：`statusSubagentSync` 只有在所有 `listSubagents()` settle 后才清空；一个永远不返回的服务调用会让后续所有 `refreshAllPanels()` 都挂在同一个 promise 上，状态面板/bar 停止刷新。→ 每个 agent 查询加超时，保证 finally 必达。
3. **`transcribeVoice` / `downloadFile` / `sendTextFallback` 的 fetch 无超时**：Node fetch 可无限挂起；语音转写/图片下载会永久卡住该 chat 的 user lane，fallback 会卡住关键 ack。→ AbortSignal.timeout。
4. **`setCommands` 无 withTimeout**：/start 路径 await 一个可能挂起的 setMyCommands。→ 与其他 Bot API 调用一致加 20s。
5. **`SendQueue.takeSlot` 在 maxPerWindow<=0 时数学上无限循环**（`stamps.length < 0` 永远 false）；配置层已挡 1..30，但 SendQueue 是公共类。→ 构造/configure 时 clamp 到 >=1。
6. **`markdownToHtml` 的 `renderInline` 无递归深度上限**：嵌套 `**a**`/`[..](..)` 超过调用栈可 RangeError；超长同前缀内容也 O(n²)。→ 增加深度上限，超限直接转义剩余内容（正常消息零影响）。

### 中风险（已写修复方案，待后续轮次实施）
7. **`statusSnapshot.eventStatsFor` 每次全量扫 session.events**：Bridge 对每个 tool/step 事件调 refreshAllPanels → statusSnapshot → 全扫；长会话 O(n²)，是“事件多时 UI 越来越卡/像死锁”的主要来源。方案：仿 listTodos 做 WeakMap<agent,{scannedEnd,stats}> 增量累加 + preset 反向缓存。
8. **UI lane 的卡片数据调用无统一超时**：`modelCatalog/listSkills/listSubagents/listSessionDetails/describeSettings/...` await 外部服务；任一挂起会永久卡住该 chat 的 uiChains，后续所有按钮无响应。方案：新增 `withDeadline(ms, fn)` 包卡片数据加载，失败发“加载失败”卡片而不是静默挂起。
9. **`listDirectory`/`readdir+stat` 无 AbortSignal**：NFS/坏盘挂起会卡住 Host/Workspace 卡。方案：fs.promises 调用加 `AbortSignal.timeout(10s)`，超时降级为错误提示。
10. **interactive 零投递挂起**：approval/question `broadcastForSession` 若没有任何 chat 收到卡，promise 永不 settle（等 signal）。方案：delivered.length===0 时对 question reject、对 approval settle("cancelled") 并记日志。
11. **`exportSessionLog` 读流无超时**：reader.read() 永不 done 会卡住 `/sessionlog`。方案：复用 AbortSignal.timeout(120s)（50MB 上限，给足余量）并 cancel reader。
12. **`SessionLifecycle.create` await 旧 agent dispose**：dispose 永不 settle 会让 sessionCreateChains 卡死（新会话点不了）。方案：dispose 加 10s 超时竞速，失败只记日志不阻塞创建返回。
13. **`ensureOpencodeGoResponsesRoute` 单例闩锁**：settings.update 挂起时同 promise 永久复用。方案：provisionOnce 外层加 15s 超时且无论成败清 `provisioning`。
14. **低风险内存增长**：`CompactionWatcher.states`（无 compaction/end 时不删）、`toolCallCounts`（session 删除不清）、`Bridge.droppedEvents`（unbound agent 累计）。方案：session/disposed、deleteSession、turn/end 分别清理。
15. **`encodedCallback` O(n²)**：长路径/长 id 截断循环每字符 UTF-16 截断。方案：二分/按字节逐步截断。

## Round 29 实施（issues #16-#21）

- #16：`cardOrigins` 记录 `menu`/`bar`；`m:back` 按来源关闭或回菜单；bar 全入口统一在 `dispatchBarButton` 标记。集成测试覆盖两条路径。
- #17：persistent reply keyboard 只能被新键盘替代——收起时删旧 carrier 后发 `buildCollapsedBarKeyboard()` 新 carrier；`runningTurns` 集合 + `turnStillRunning()`（agent.status 兜底）让 10 分钟 typing guard 在 turn 仍在跑时续轮。
- #18：openclaw 与 GoalProgressFeed 30s heartbeat（`.unref()` 防撑测试/空闲进程）；openclaw 正常帧标题保持 `⚙️ Working…` diff-stable，只有 heartbeat 帧加 `⏱️ Ns`，因此 #15 的 diff 抑制不回退；goal turn 完成 push 新 receipt（响铃）。新增 `notify.onComplete/onLongTask` 配置（默认 true）。
- #19：GFM 表格转 `<pre>` 等宽对齐；assistant 送达路径复核（bridge 即时转发 / openclaw 最终答案 / turn error 均已走 `markdownToHtml`）。
- #20：LOOP_AUDIT 中风险 8 项全部落地（见 TESTING §67）；`encodedCallback` 低风险 O(n²) 不在 issue #20 的 8 项清单内，保持观察。
- #21：receipt 单行 5 metrics；token/性能/editText 命中率全部内部化（editText 命中率保留在 openclaw 日志）。
- 测试新增 19 例：markdown 表格、receipt、status 增量扫描、goal/openclaw heartbeat 与通知开关、session dispose deadline、opencode latch deadline、interactive 零投递、config notify、UI lane 集成（#16/#17/#20）。
- `npm run check`：**340/340 pass**。
- 提交 `040bbd2` 已推 main；GitHub open issues 已清空（#16-#21 全部关闭并附修复说明）。

## Round 30 发现与修复（GitHub issues #22-#26）

- #22：`session?.session?.header?.agentPreset` 是永不存在的路径；真实 header 在
  events 首个 `type:"session"` 事件上。兼容 `data.agentPreset` 与 envelope
  平铺两种投影；headerPreset 独立进增量缓存，append 不再重扫。
- #23：placeholder storm v2 的两条逃逸路径都在 openclaw.ts：
  MAX_EDIT_FAILURES 后清 messageId 并 ensureMessage（5 连败即新占位）与
  turn/start 丢 messageId/placeholderFailed。已改为保留同消息 + 每 turn 一次
  stall fallback + turn 重启复用 messageId/失败闩锁。
- #24：EDIT_THROTTLE_MS=1000 是 #15 的过度防御；diff 检查 + 同消息指数退避
  已足够。改回 200ms。
- #25：底层 sendDocument/sendPhoto 能力完整但无 agent 工具；新增
  telegram_attach + telegram_send_file 别名（1-10 文件、workspace 白名单、
  50MB、roster、按扩展名分流）。dsh-tools rc.6 的 array schema 不支持
  minItems/maxItems，数量上限在 execute 内手动校验。
- #26：最终答案路径 #19 已覆盖；缺 openclaw reasoning 路径。新增
  `markdownTablePreBlock`（任意位置首个 GFM 表）并接入 reasoningLineHtml。
- 提交 `be550f3` 已 push main，issues #22-#26 已关闭。

## Round 31 发现与修复（GitHub issues #27-#30）

- #30 根因确认：Telegram HTML 仅对 `<pre><code>` 保证 monospace；本仓库与
  openclaw/表格路径全部使用裸 `<pre>`。修复集中在 `markdown.ts` 两处输出 +
  `isFence` 语言解析；表格 `<pre><code>` 与 splitter 的嵌套 tag 重平衡天然兼容。
- #28：`^0.1.0-rc.6` 虽能满足 rc.7，但 devDep 精确 pin 会让本地编译停留在
  rc.6 类型面；同步到 rc.7 后 typecheck 0 error，无行为变化。
- #27 的实现注意点：
  - 不能把 `allowed-session`/`allowed-always` 直接 resolve 给 approval
    协议——协议只认 allowed-once/rejected/cancelled；两个新档位记录授权后
    仍 resolve `allowed-once`，结算文案显示真实档位。
  - forever 持久化走本插件自己的 `.pi/telegram.json`（`/config set` 体系），
    而不是 issue 建议的 `settings.update("approval", …)`：本插件未注册
    approval settings namespace，硬写会依赖不存在的 namespace。
  - `persistToolAllow` 同步写入 config 并 `applyConfigLive`，失败只记日志、
    授权仍在本插件挂载期内存生效。
- #29 属外部仓库 `hi-wenw/dsh-telegram-channel`（fork 6 个、本账号无 push
  权限），走 fork PR 修复；上游 merge 前 issue 保持 open 并在 #29 下附 PR。
