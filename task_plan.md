# dsh-telegram 上线冲刺任务计划

> 目标：把 dsh-telegram 迭代到可上线状态；测试并消除全部 bug；做好测试记录；
> 顺手优化 Telegram 人类使用习惯（解耦、不引入新 bug）；尽量完成项目最终目标。

## Phase 状态

- [x] Round 1：基线修复 + 多 chat 收口（160/160，commit `577a820`）
- [x] Round 2：liveFeed 真开关 + 15 个转发事件订阅 + 危险操作确认 + credential 隐私（163/163）
- [x] Round 3：Sessions/History 分页 + goal edit maxRounds + preset copy 自定义（173/173）
- [x] Round 4：Models/Plugins 分页 + 工具白名单 + host/commands/jobs/dynamic 单测（183/183）
- [x] Round 5：Host 目录逐级浏览 + Jobs/Search 卡片顺手化（184/184）
- [x] Round 6：Skills 按 session 查询 + Search 结果分页（187/187）
- [x] Round 7：Subagents 对齐 web 目录语义（190/190）
- [x] Round 8：非图片媒体明确指引 + downloads 单测（194/194）
- [x] Round 9：credentials 批量 + Host 版本真实化（198/198）
- [x] Round 10：session.attachment 读回 + Host 默认模型对齐（201/201）
- [x] Round 11：v0.3.0 release candidate（版本/CHANGELOG/preset hasDocument/202 tests）
- [x] Round 12：Host 浏览卡 New folder + 审计状态修正（203/203）
- [x] Round 13：Models routable + per-session thinking（206/206）
- [x] Round 14：Settings schema envelope（207/207）
- [x] Round 15：settings expectedRevision（208/208）
- [x] Round 16：Subagent activity/时区/信号对齐 web（208/208）
- [x] Round 17：Release gate（npm publish dry-run + v0.3.0-rc.1 tag）
- [x] Round 18：独立审计修复 + 实机冒烟（211/211）
- [x] Round 27：修复 GitHub issues #14/#15（Todos 卡实时性 + openclaw placeholder storm）
- [ ] Round 19+：Telegram 客户端完整 §25 checklist + 最终发布决策（见下）
- [ ] 最终：`npm run check` + `npm pack --dry-run` + 提交

## Round 2 已完成

- `outbound.liveFeed` 动态生效（core 忽略禁用 consumer；openclaw 逐事件检查；免重启热切换）。
- 15 个转发/host 事件订阅 → `refreshAllPanels()`，disposer 随 teardown 回收。
- 危险操作确认卡：session/workspace delete、preset remove、subagent interrupt；`buildConfirmKeyboard` 纯函数。
- `/credentialset` 原消息 500ms 后自动删除。

## 剩余候选（按性价比排序）

1. Telegram 实机回归 + 最终上线复测记录（TESTING §25 checklist）。
2. 审计剩余 🟡 收敛（history tool view、settings 边界等）。
3. 实机通过后决定 tag/publish。

## 错误记录

| 错误 | 尝试 | 处理 |
| --- | --- | --- |
| TS2352 AgentRegistry → AgentLike[] | 1 | 接口只保留结构子集 + `as unknown as` |
| npm pack EPERM（~/.npm root-owned） | 1 | `--cache /tmp/dsh-telegram-npm-cache` |
| telegram_mark_no_reply 返回类型不匹配 | 2 | 返回 JSON.stringify；删残留 return |
| confirm 键盘空行（`.row()` 语义） | 2 | 两个 `.text()` 不加 `.row()`；加单测锁定 |

## Round 3 已完成

- Sessions 卡：`lastPromptAt desc` 排序 + 10 条/页 `‹ Prev`/`More ›`。
- History：`Load older` 窗口分页（20 条/窗口 + hasMore）。
- `/goaledit <objective> [maxRounds]`。
- Preset Copy：回复自定义新 id；`/cancel` 中止。
- 新增 goals.test.mjs（5 例）与 sessions/history/presets 键盘适配器测试。

## Round 4 已完成

- Models provider 卡 12/页分页；Plugins 卡 20/页分页 + `buildPagingKeyboard`。
- `telegram_send`/`telegram_broadcast` 目标限白名单 roster（security 测试锁定）。
- 新增 `test/host.test.mjs`（4 例）与 `test/commands-jobs-dynamic.test.mjs`（4 例）。

## Round 5 已完成

- Host 卡 `Browse cwd`：目录两列、Up/~//、20/页、文件只计数、旧 `h:ls` 兼容。
- Jobs 卡 20/页分页。
- Search 卡专用 `buildSearchKeyboard`（命中会话 + New search/Sessions）。

## Round 6 已完成

- Skills 卡传 sessionId + 只显示 user-invocable；`test/skills.test.mjs` 3 例。
- Search 结果 100 取回 / 10 每页 / `‹ Prev`/`More ›`；search keyboard 支持 paging。

## Round 7 已完成

- `listSubagents` 完整投影 mode/label/hasChildren/reason/activity；legacy 回退。
- 详情仅 continuable 显示 Prompt/Interrupt，并在回调前校验。
- 新增 subagents 投影/降级与 keyboard 按钮裁剪测试。

## Round 8 已完成

- document/voice/video 路由到明确指引；未授权 photo/media 也发 allow 提示。
- downloads 单测：50MB 常量 + seam 缺失降级。
- README 平台限制同步。

## Round 9 已完成

- `describeCredentials` 批量 ≤64 refs（去重 + POSIX 校验）；/credential 与文案同步。
- `describeHost` version 参数：Host 卡显示插件 0.2.0。
- 新增 credentials.test.mjs（3 例）+ host 版本断言。

## Round 10 已完成

- `/attachment <id>` 读回真实 durable ref 并 sendPhoto 发回；发图回执附 attachment id。
- `describeHost` 优先 agentDefaultModel；ESM 三入口 smoke import。
- 新增附件读回、sendPhoto、host 默认模型测试。

## Round 11 已完成

- 版本升至 0.3.0；新增 CHANGELOG.md 并纳入 npm files。
- agentPreset.list 补 hasDocument；Presets 卡显示 document yes/no。
- 202/202 tests；上线前人工 checklist 写入 TESTING §25。

## Round 12 已完成

- Host 浏览卡 New folder（parent+name、单段校验、/cancel、原地刷新）。
- buildProjectKeyboard newFolder 动作 + 单测；审计状态修正。

## Round 13 已完成

- `modelCatalog.routable` + llm.test.mjs（3 例）。
- provider 卡 Thinking 行接入五档 per-session picker。
- settings.describe 审计修正。

## Round 14 已完成

- settings schema 透传与卡片展示；settings 单测 +1。

## Round 15 已完成

- parseJsonWithRevision + settings 三命令 expectedRevision。

## Round 16 已完成

- subagent.activity 按 web 重映射 live agent status。
- promptSubagent 携带 clientTimeZone + AbortSignal。

## Round 18 已完成

- 独立审计 7 项修复（replied 时序、跨 chat fallback、stop/start 竞态、分片 quote、listener 异常、carrier 清理、selection 泄漏）。
- 实机冒烟：真实 bot 长轮询 + openclaw + bar sync 投递成功。

## Round 27 任务计划（GitHub issues #14/#15）

### 目标
修复 open 的 GitHub issues：
- #14: Todos 按钮在 agent 执行中必须立即可点、每 5s 自动刷新、完成态可见。
- #15: openclaw 编辑风暴（400/429 后不断发「…」占位消息）。

### 步骤
1. [x] #15 openclaw：编辑 diff 检查、节流 120→1000ms、失败保留 messageId + 指数退避重试、5 次失败才换占位、占位文案用完整标题。
2. [x] #15 openclaw：turn-receipt 增加 editText 命中率行（issue 中的用户附加需求）。
3. [x] #14 listTodos 增量缓存（WeakMap<agent, {scannedEnd, todos}>），避免每次 O(n) 反扫。
4. [x] #14 openTodosCard：入口/耗时日志、失败兜底；卡片每 5s 自动 refresh、关卡/换卡清理定时器、全完成显示完成态；turn/end 立即刷新活跃卡片。
5. [x] 补回归测试（openclaw 失败不换占位、diff 抑制 400、重试退避、todos 缓存、todos 卡渲染/生命周期）。
6. [x] `npm run check` 全绿：**317/317 pass**。
7. [x] 更新 CHANGELOG（README 无配置变化）。
8. [x] commit `29669fd` 已推送 main；issues #14/#15 已关闭。

### 关键约束
- 卡片/占位继续走 control lane（openCard 已用 uiOps）。
- 不引入新的 per-chat 编辑风暴：编辑仍经 SendQueue 全局限速 + 429 retry_after。
- 保持现有 305 测试全绿，新增测试不依赖真实 Telegram。


## Round 28 任务计划（死锁/卡死/循环审计）

### 目标
全项目审计死锁、卡死、无限递归/循环，记录并给出不影响功能的修复计划；本轮落地高危安全修复。

### 步骤
1. [x] 全量静态扫描 + 逐模块审计（while/for(;;)/setInterval/递归/await 无超时）。
2. [x] 风险清单写入 findings.md（高 6 项、中 8 项、低 1 项）。
3. [x] 修复高风险项：Todo 定时器复活卡、statusSubagentSync 闩锁、fetch 超时、SendQueue clamp、markdown 递归深度。
4. [x] 补回归测试（状态卡切换停 Todo 定时器、fetch 超时信号、clamp、嵌套 markdown）。
5. [x] `npm run check` 全绿：**319/319 pass**。
6. [ ] 提交；中风险项留待后续轮次（plan 已列在 findings.md 与 docs/LOOP_AUDIT.md）。

### 约束
- 只做防御性修复：正常路径行为不变；超时只影响“本来就永久挂起”的场景。
- 不改变外部服务契约，不重写 UI 数据加载。

## Round 29 任务计划（修复全部 open issues #16-#21）

1. [x] #16 cardOrigin：dispatchBarButton 统一标 `bar`，openMenuAt/command 标 `menu`；back 按来源关闭/回菜单。
2. [x] #17 收起：删 carrier 后发 `buildCollapsedBarKeyboard()` 的 collapsed carrier；typing 10 分钟到点若 turn 仍在跑则续一轮。
3. [x] #18 GoalProgressFeed/openclaw 增加 30s heartbeat（标题带 elapsed），goal 自主 turn 完成时 push 一条新 receipt 消息；`notify.onComplete/onLongTask` 可配置（默认 true）。
4. [x] #19 markdownToHtml 增加 GFM 表格块 → `<pre>` 等宽对齐；校验所有 assistant 送达路径走 markdownToHtml。
5. [x] #20 LOOP_AUDIT 8 项全部落地（eventStats 缓存 / UI lane deadline / listDirectory timeout / interactive 零投递 / sessionlog 超时 / dispose 超时 / opencode-go 闩锁 / 内存清理）。
6. [x] #21 renderTurnReceipt 单行 5 metrics；移除 token/editText/性能段；openclaw editText 命中率改为日志。
7. [x] 回归测试 + `npm run check` 全绿：**340/340 pass**。
8. [x] 提交推送 + 关闭 issues #16-#21（commit `040bbd2` 已 push main；open issues 已清空）。

## Round 30 任务计划（修复 open issues #22-#26）

> 基于 GitHub open issues（2026-08-18）：#22 preset fallback、#23 placeholder storm v2、
> #24 reasoning 1s 节流、#25 agent 发文件工具、#26 表格 pre/code 渲染。

### 步骤
1. [x] #22 status.ts：session header preset fallback 改为扫 events 首个 `type:"session"` 的 `data.agentPreset`（现状读不存在的 `session.header`）。
2. [x] #23 openclaw.ts：MAX_EDIT_FAILURES 后不再清 messageId/不再发新占位，仅发一次 stall fallback；turn/start 复用上一条 placeholder 的 messageId（含 placeholderFailed 闩锁）。
3. [x] #24 openclaw.ts：EDIT_THROTTLE_MS 1000 → 200（diff 检查 + 退避仍在，恢复流式感）。
4. [x] #25 新增 `telegram_attach`（+ `telegram_send_file` 别名）：workspace 路径白名单、1-10 文件、50MB 上限、chatId roster 校验、按扩展名自动分流 photo/voice/audio/document；transport 补 sendVoice/sendAudio。
5. [x] #26 markdown.ts 导出表格→pre 助手并接入 openclaw reasoning 路径（最终答案路径 #19 已覆盖，补回归测试锁定）。
6. [x] 补回归测试（status preset、openclaw 风暴/节流/表格、attach 安全与分流）。
7. [x] `npm run check` 全绿 + CHANGELOG/README 同步。
8. [x] 提交推送 + 关闭 issues #22-#26（commit `be550f3` 已 push main；open issues 已清空）。

### 约束
- 不破坏 #15/#19 已收敛行为：编辑仍走 diff 检查、失败仍指数退避、同消息重试。
- 新工具只允许白名单 chat + workspace root 内文件；文件发送仍走 SendQueue 全局限速。
- 测试不依赖真实 Telegram。

## Round 31 任务计划（修复 open issues #27-#30）

### 目标
修复 GitHub open issues：#27 审批卡 session/forever 档位、#28 dsh 0.1.0-rc.7
依赖同步、#29 dsh-telegram-channel peer 范围（外部仓库，所有者决定关闭）、#30 代码块
`<pre><code>` 渲染。

### 步骤
1. [x] #30 markdown：fenced/表格全部 `<pre><code>`；fence 语言白名单
   `class="language-*"`；回归测试 3 例。
2. [x] #28 package.json + lock：6 个 dsh 包 dev pin `0.1.0-rc.7`、peer
   `^0.1.0-rc.7`；npm install 后 rc.7 typecheck 0 error。
3. [x] #27 interactive：session / forever(by tool) 按钮 + 回调解析；
   `interactive.allowByTool` 配置持久化与热更新；高风险工具 ⚠️；
   回归测试 interactive 4 例 + config 1 例。
4. [x] #29 按仓库所有者决定关闭（外部仓库不在本仓库范围）；此前验证性
   fork PR https://github.com/hi-wenw/dsh-telegram-channel/pull/6 已撤回。
5. [x] 文档同步（CHANGELOG/README/README.zh/TESTING §69）。
6. [x] `npm run check` 全绿：**356/356 pass**；`npm pack --dry-run` 149 files。
7. [x] commit/push（`f1559da`）+ 关闭 #27/#28/#30；#29 按所有者决定直接
   关闭，外部 PR 已撤回，不再打扰上游仓库。

### 约束
- goal 档语义不回退（仍允许整个 goal）；session 档按「同 session 同工具」；
  forever 只持久化工具名，不写 settings 服务（本插件配置在
  `.pi/telegram.json`，`/config set` 可撤销）。
- 编辑风暴防线（#15/#24）不因表格 `<code>` 包裹变化。
