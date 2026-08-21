# Web 接口复刻审计与 Telegram 顺手化计划

> 审计基准：本仓库 `dsh-telegram` 工作区（HEAD `91b6b6d`，含未提交改动）；
> web 权威源码：`/Users/cx/deepseek-harness` @ `47f943859b`（master）。
>
> 结论一句话：**适配器层基本铺满，但 UI 路由和运行语义仍有多处“没做到”。**
> 真正把 web 暴露面“在 Telegram 里用顺手”还差一轮 P0/P1 交互补课。

---

## 1. Web 到底暴露了什么（权威清点）

### 1.1 ApiProxy HTTP RPC：52 个 client-request 方法 + 4 个载体能力 = 56

清点文件：`packages/host/apiproxy/src/api/rpc-map.ts`、`src/api/index.ts`。

- `rpc-map.ts` 中的 52 个 unary 方法：session 12、subagent 4、host 5、workspace 7、
  skill 1、agentPreset 6、goal 6、settings 5、credentials 3、llm 3。
- 另有 4 个非普通 RPC 的 web 能力：
  1. `events.mux`（SSE 会话事件流）
  2. `events.host`（SSE 宿主事件流）
  3. `respond`（approval/question 应答）
  4. `downloads.sessionLog`（GET 下载 ZIP）

### 1.2 Typert Remote：24 个直接 Remote + 16 个 agent-scope 变体

清点文件：`packages/*/lib/typert.remote-client.d.ts`（共 5 个包）。

| namespace | 直接 Remote |
| --- | --- |
| `commands` | execute, list（2） |
| `pluginInventory` | list（1） |
| `messageFeedback` | put, list, delete（3） |
| `goals` | create, edit, pause, resume, complete, clear（6） |
| `dynamicCordisRunner` | inventory + 11 个写/控制方法（12） |

Web 端组装文件 `packages/api/remotes/src/client/index.ts` 只 mount 这 24 个直接 Remote；
`agent:...` 的 16 个变体是 agent 内工具/子上下文使用，本桥不需要逐一对齐。

### 1.3 转发事件：11 个

清点文件：`packages/api/remotes/src/remote-events.ts`。

`agent-preset/selected`、`commands/change`、`credentials/updated`、
`cordis/request-run`、`cordis/request-run-resolved`、`cordis/dynamic-package`、
`cordis/dynamic-retract`、`cordis/inspect-query`、`cordis/inspect-query-resolved`、
`llm/adapters-updated`、`settings/document-updated`。

---

## 2. 当前实现逐项体检

图例：

- ✅ = 有可用入口，语义与 web 基本一致
- 🟡 = 有入口但只是子集/降级
- ❌ = 适配器存在但 UI 无路由，或 UI 声称有但实际没有触发路径
- ➖ = Telegram 平台限制，按计划只给指引

### 2.1 ApiProxy 56 项

| web 接口 | 当前入口 | 状态 | 没做到的部分 |
| --- | --- | --- | --- |
| session.list | Sessions 卡、/sessions | 🟡 | 已按 `lastPromptAt desc` 排序并 10 条/页翻页；blank/lastPromptAt 仍是内存事件近似，不是 projection 语义；无 cursor |
| session.search | Sessions 卡 Search 按钮（回复查询）、/search | 🟡 | 入口已通；仍只扫 live/persisted 事件，不是 web 的 sqlite/索引路径；无 `hasMore` |
| session.create | /new、✨ New、无 agent 时自动建 | 🟡 | 不支持 web 的 `agentPreset` / `sessionId` 幂等 / `workspaceId`；只有 cwd + telegram 自有默认模型 |
| session.history | /history、详情 History 按钮 | 🟡 | 已加 `Load older` 分页；仍是原始事件窗口，不是 web 的“整消息边界分页”；无 `projections`、tool view |
| session.models | Models 卡 | 🟡 | 已显示 `routable` 与 failures；仍缺完整 schema/每个模型的 reasoning 元数据展示 |
| session.selectModel | Models 卡模型行 + Thinking 行 | 🟡 | 已暴露 per-session `reasoningEffort` 五档选择；无 agent 时自动建会话（手机更顺手，非严格复刻） |
| session.rename | 详情按钮、/rename | ✅ | |
| session.fork | 详情 Fork、/fork [atSeq] | ✅ | fork 后未一键绑定/恢复，需再点 Use |
| session.prompt | 普通文本、Steer 按钮、/steer、queue-only 入站规则 | 🟡 | 只支持纯文本/图片 caption；对非当前会话的 prompt 只有 steer/queue，没有独立 followup 路由 |
| session.attachment | 发图片自动 `saveImage` → 进 agent；`/attachment <id>` 读回 | 🟡 | 只处理当前 agent；无 web 图片限制预检；读回仅限本 bridge 保存的 ref（web 校验同语义） |
| session.updateQueue | Queue 卡编辑/删除/立即执行、/queueedit | ✅ | |
| session.cancel | /stop、Stop 键 | ✅ | |
| subagent.list | Subagents 卡 | 🟡 | activity 已按 web 重映射为 live agent status；mode/label/hasChildren/reason 齐；parentAvailable 仍隐式 |
| subagent.history | 详情 History | 🟡 | 复用通用 history，缺分页/projections/tool view |
| subagent.prompt | 详情 Prompt → 回复文本 | ✅ | continuable 校验 + clientTimeZone + AbortSignal 已随 source/options 传递 |
| subagent.interrupt | 详情 Interrupt | ✅ | 仅 continuable 显示；二次确认；错误纯文本 |
| host.describe | Host 卡 | 🟡 | `version` 显示 dsh-telegram 0.3.0（与 package.json 一致，测试锁定）；provider/model 已改读 `agentDefaultModel`（与 web 同 seam），fallback live agent；canOpenPath 平台限制为 false |
| host.pickDirectory | /pickdir、Project 选择器 | ✅ | 平台限制下用路径式选择代替原生对话框；无参数时给提示并打开 Project 卡 |
| host.listDirectory | /ls（文本）、Host 卡 `Browse cwd` 逐级浏览 | ✅ | 点击文件夹进入、Up/~// 导航、目录 20/页、文件只计数；`/ls` 保留文本形式 |
| host.createDirectory | /mkdir + Host 浏览卡 `New folder` | 🟡 | 浏览卡按钮走 parent+name（web 语义）；/mkdir 保留完整路径快速通道 |
| host.openPath | /openpath [path] | ✅ | 返回宿主路径指引，符合平台限制设计 |
| workspace.list | Workspaces 卡 | ✅ | |
| workspace.create | /workspacecreate | ✅ | |
| workspace.rename | 详情 Rename、/workspacerename | ✅ | |
| workspace.delete | 详情 Delete | ✅ | 无二次确认 |
| workspace.insertBefore | 详情 Move up/down | ✅ | |
| workspace.insertSessionBefore | /workspacepin | ✅ | 命令对手机不友好，见计划 |
| workspace.archiveSession | /archive、详情 Archive | ✅ | 归档后 UI 只显示 `Archived`，无 unarchive（web 同样没有） |
| skill.list | Skills 卡 | ✅ | 传入当前 sessionId（web 契约）；卡片只显示 user-invocable 技能并标注 model-only 隐藏数 |
| agentPreset.list | Presets 卡 | ✅ | 已显示 `authorable`/`hasDocument` 两个 deployment facts；presets/trust/isDefault/broken 与 web 一致 |
| agentPreset.select | 详情 Select；已开始会话自动 fork 切换 | ✅ | 比 web 更顺手（web 会拒绝） |
| agentPreset.read | 详情 Read | ✅ | 只切前 3800 字符 |
| agentPreset.copy | 详情 Copy → 回复新 id | ✅ | 点击后回复新 preset id 完成复制；`/cancel` 可中止 |
| agentPreset.openDocument | 详情 Open document | 🟡 | 只给文字指引，没有目录/路径 |
| agentPreset.remove | 详情 Remove | ✅ | 确认卡 + 独立回执，已实现 |
| goal.create | Goals 卡、/goalcreate | ✅ | |
| goal.edit | Goals 卡、/goaledit | ✅ | `/goaledit <objective> [maxRounds]` 同时支持 maxGoalRounds |
| goal.pause/resume/complete/clear | Goals 卡按钮 | ✅ | |
| settings.describe | Host settings 卡、/settingsdescribe | 🟡 | 已展示 schema envelope；缺按钮表单与 expectedRevision 流程（命令仍可用） |
| settings.openDocument | 卡片显示 documentPath | ➖ | 只显示路径（可接受） |
| settings.update | /settingsupdate `<ns> <json> [expectedRevision]` | 🟡 | expectedRevision 已支持；仍无按钮表单流 |
| settings.replace | /settingsreplace `<ns> <json section> [expectedRevision]` | ✅ | expectedRevision 已支持；仍无按钮表单流 |
| settings.mutate | /settingsmutate `<ns> <json ops> [expectedRevision]` | ✅ | expectedRevision 已支持；仍无按钮表单流 |
| credentials.describe | /credential `<REF> [REF...]` | ✅ | 批量查询（≤64 ref、去重、校验）与 web `refs[]` 语义一致；无枚举 seam，所以卡上仍无 ref 列表（web 同样不枚举） |
| credentials.set | /credentialset `<REF> <value>` | 🟡 | 命令原消息在 500ms 后自动删除，值不回显；Telegram 服务端短期缓存仍非本项目可控 |
| credentials.unset | /credentialunset `<REF>` | ✅ | |
| llm.providers | Models 卡（间接） | 🟡 | 缺 `settingsNs` / `settingsPath` / `active` / `declared` 展示；没有单独 Providers 卡 |
| llm.models | Models 卡 | ✅ | 每 provider 12 个/页，`‹ Prev`/`More ›` 翻页 |
| llm.discoverModels | /discover `<settingsNs> [baseURL]` | 🟡 | web 还支持 `provider` / `api` / `apiKey`；TG 只透出两个参数 |
| events.mux | bridge 订阅 `session/event`；approval/question 内联 | 🟡 | 只转发最终 assistant text；无 `session/subscribed`、`session/queue` 推送、`session/jobs` 推送、`session/projection`、tool view、`stream/error` 全量 |
| events.host | `session/created|disposed`、`agent/status|error`、`domain/changed` + 打开卡片时重读 | ✅ | 订阅后只刷新已打开的卡片/status panel，不向聊天推送（无 open card 不打扰） |
| respond | approval 按钮；question 选项按钮；自由文本 `/answer <id> <n> <text>` | 🟡 | `/answer` 已接线；approval/question 有 chat 绑定时只发绑定 chat，settle/answered 也回原 chat；无绑定时才广播 |
| downloads.sessionLog | 详情 Log、/sessionlog | ✅ | 50 MB 内直传，超过给 web 指引 |

### 2.2 Typert Remote 24 项

| web 接口 | 当前入口 | 状态 | 没做到的部分 |
| --- | --- | --- | --- |
| commands/list | /commands | ✅ | 无 card，长文本消息 |
| commands/execute | 未知斜杠命令转发 `ctx.commands.execute` | ✅ | 已知 Telegram 斜杠会先被本桥截获 |
| pluginInventory/list | Plugins 卡 | ✅ | 与 web 投影一致 |
| messageFeedback/put | `attachFeedbackKeyboard` → 最终回复 `editReplyMarkup` 加 👍/👎 | ✅ | 无 `messageFeedback` seam 时干净降级（不挂死按钮） |
| messageFeedback/list | 最终回复 `📋` 按钮 → `openFeedbackListCard` | ✅ | 只列前 20 条 |
| messageFeedback/delete | 反馈列表逐项 Delete → `deleteFeedback` | ✅ | |
| goals/*（6） | Goals 卡 + 命令 | ✅ | |
| dynamicCordisRunner/inventory | Dynamic 卡 | ✅ | |
| dynamicCordisRunner 其余 11 | 卡片给“去 web 面板”指引 | ➖ | 按计划不实现 |

### 2.3 转发事件 11 项

| 事件 | 状态 | 证据 |
| --- | --- | --- |
| agent-preset/selected | ✅ | 已订阅，触发打开卡片/status panel 刷新 |
| commands/change | ✅ | 已订阅，触发刷新 |
| credentials/updated | ✅ | 已订阅，触发刷新 |
| settings/document-updated | ✅ | 已订阅，触发刷新 |
| llm/adapters-updated | ✅ | 已订阅，触发刷新 |
| cordis/request-run | ✅ | 已订阅，触发刷新 |
| cordis/request-run-resolved | ✅ | 已订阅，触发刷新 |
| cordis/dynamic-package | ✅ | 已订阅，触发刷新 |
| cordis/dynamic-retract | ✅ | 已订阅，触发刷新 |
| cordis/inspect-query | ✅ | 已订阅，触发刷新 |
| cordis/inspect-query-resolved | ✅ | 已订阅，触发刷新 |

`bridge.attach()` 目前只订阅 `session/event` 和 `agent/status`。

### 2.4 不属于 web 暴露面、但影响“顺手”的缺口

1. **多 chat 路由已基本完成**。`Bridge` 的 `chatStates` 按 agent 反查 chat；Models/Queue/Goals/
   New/Stop/Compact/Status 等卡片和命令已把 `chatId` 传进 `currentAgent()`/`boundAgentId()`；
   router 增加 per-chat FIFO 串行（首条消息并发不会建出两个 session）；死绑定不会 fallback 串台。
2. ~~自动创建会话只对文本生效~~ 已修复：首条图片没有 agent 时也会自动建会话。文档/语音/视频仍按平台限制暂不接纳。
3. **Telegram 命令自动补全已补到 39 条**。`TELEGRAM_COMMANDS` 模块级数组覆盖高频+长尾命令；审计中修复了它被误放进函数作用域导致的编译错误，并补上 4 条新命令。
4. **`outbound.liveFeed` 是死配置**。配置读取、README 都有它，但 `openclaw` 扩展只要挂载就流式，
   不读该开关；不挂载时也永远不流式。
5. **最终回复已带原生 reply 与反馈键盘**。`Bridge.onAssistantDelivered` + `openclaw` 最终投递会
   给 assistant 消息挂 👍/👎/📋；该能力当前工作区已接线，不再是死代码。
6. **`/help` 与命令自动补全已覆盖全部已实现命令**：`/settingsreplace`、`/settingsmutate`、
   `/pickdir`、`/openpath`、`/answer` 均已写入 `TELEGRAM_COMMANDS` 与 `/help`。
7. **自由文本 question 的 `/answer` 已接通**；question/approval 已改为按 session→chat 绑定路由（见 8）。
8. ~~approval/question 全 chat 广播~~ 已修复：`InteractiveDelivery.chatForSession` + index 侧 `state.chats` 过滤，卡片与 settle 只达绑定 chat，无绑定才回退广播。
9. **credential 值会留在聊天记录**。应优先走“发送后删除/隐私模式/仅提示在 dsh 侧设置”。
10. **图片、文档、语音、视频**：photo 走附件入站；document/voice/video 现在会收到「web seam 仅支持图片附件」的指引回复（不再静默忽略）。
11. **测试覆盖断层**：host/commands/jobs/downloads/dynamic/events-forwarding 仍无单测；
    feedback、settings、subagents 已有单测，当前总计 147 tests。

---

## 3. 没做到清单（按优先级）

### P0：先把“用得了”补齐（web 方法必须有 TG 入口）

- [x] `messageFeedback/put`：已接线（当前工作区完成）。
- [x] `messageFeedback/list`：已接线（当前工作区完成）。
- [x] `messageFeedback/delete`：已接线（当前工作区完成）。
- [x] `settings.replace`：`/settingsreplace <ns> <json>` 已接线（当前工作区完成）。
- [x] `settings.mutate`：`/settingsmutate <ns> <json ops>` 已接线（当前工作区完成）。
- [x] `host.pickDirectory`：`/pickdir` + Project 选择器已接线（当前工作区完成）。
- [x] `host.openPath`：`/openpath <path>` 已接线（当前工作区完成）。
- [x] 自由文本 question：`/answer <id> <question-number> <text>` 已接线（当前工作区完成）。
- [x] `session.search`：Sessions 卡 Search 按钮 → 回复查询已接线（当前工作区完成）。
- [ ] `session.create` 的 `agentPreset`：New 时支持“用当前默认 preset”或弹 preset 选择。
- [x] 把 `/settingsreplace`、`/settingsmutate`、`/pickdir`、`/openpath` 补进 `/help` 与 `TELEGRAM_COMMANDS`（当前 39 条）。

### P1：把“用着对”补齐（web 语义对齐）

- [x] **把每 chat 会话绑定从 bridge 层做完到 UI 层**：`chatStates` 路由已有，`chatId` 已传入
      `currentAgent()` / `boundAgentId()`，`/new`、`/use`、Stop、Queue、Models、Status、Goals 均按本 chat 作用域；
      router 入站按 chat FIFO。
- [x] session.list 按 `lastPromptAt desc` 排序并 10 条/页翻页（无 projection 依赖）。
- [x] session.history 给 `Load older` 按钮和窗口分页（message 边界分页仍未实现）。
- [x] skill.list 传入当前 session 的 `cwd` + `scope: "user"`，卡片只显示 user-invocable。
- [x] llm.providers 展示 `settingsNs/settingsPath/active/declared`；Models 卡新增 Providers 按钮 + 独立 Providers 卡。
- [x] selectModel 暴露 `reasoningEffort`（模型行 → Thinking 行 → 五档 picker，`model-effort` 回调）。
- [x] subagent.list 展示 `mode/label/hasChildren/diagnostic` 和 `parentAvailable`（父会话无 live agent 时标 `parent:unavailable`）。
- [x] subagent.prompt 适配器层校验子代理在目录中且为 continuable（否则 `subagent-prompt-locked`），clientTimeZone + AbortSignal 随 options 传递。
- [x] credentials.describe 支持批量（≤64、去重）；Credential 卡经可选 `list()` seam 列出可用 ref，点按即 describe。
- [x] host.describe 不写死版本：`hostVersionOf()` 依次读 `hostInfo` seam 与 `DSH_VERSION`，都没有则显示 unknown；model/provider 走 `agentDefaultModel` seam。
- [x] host.listDirectory 浏览卡带 breadcrumb：`breadcrumbSegments()` 逐级祖先一键跳转 + Up/Home/Root。
- [x] settings.describe 过滤 `exposed: false` 的 namespace，并在卡片标注"Outside the web boundary"清单。
- [x] goal.edit 支持 maxGoalRounds（`/goaledit <objective> [maxRounds]`）。
- [x] agentPreset.copy 支持回复自定义新 id（`/cancel` 中止）。
- [x] downloads 超过 50 MB 时给出 web UI 路径（Sessions → 会话 → Log）与宿主 `$DSH_HOME/sessions` 路径指引（`oversizeGuidance()`）。

### P2：让 Telegram 真正“顺手”（体验增强）

- [x] 订阅 11 个转发事件 + host 源事件（session/created、session/disposed、agent/error、domain/changed），按 chat 刷新受影响卡片和 status panel（无 open card 时不打扰）。
- [ ] `events.host` 投影为轻量通知：session added/removed、workspace changed/order、agent error。
- [x] `setMyCommands` 已注册 39 条已实现命令。
- [x] 首条图片在无 agent 时自动建会话；文档/语音/视频按平台限制返回明确指引（web seam 只有图片附件 API）。
- [x] credential 写入命令原消息 500ms 后自动删除，避免 secret 留在聊天历史。
- [x] 审批/提问按会话 chat 路由（只有当前绑定 chat 收到），无绑定时才广播。
- [x] `outbound.liveFeed` 真正控制 openclaw 草稿开关（core 忽略 consumer + 扩展逐事件检查，热切换免重启）。
- [x] 危险操作统一二次确认：Delete session、Workspace delete、Preset remove、Subagent interrupt 全部走同一张 confirm 卡。
- [x] 卡片分页：Sessions/Models/Plugins/History/Jobs 已支持翻页；Search 改为专用命中卡（New search/Sessions 按钮）。
- [ ] 补 adapter 单测：feedback/host/settings/commands/jobs/downloads/dynamic/events forwarding。

---

## 4. Telegram 顺手化交互计划

目标不是把 Web 的密集面板搬进手机，而是让每个 Web 动作在 Telegram 里
**最多 2 次点击或 1 条命令可达**，且高频操作放在键盘/菜单第一屏。

### 4.1 信息架构（建议）

常驻键盘（第一屏即高频）：

```text
☰ Menu        ✨ New        🧩 Models
🧭 Sessions    📊 Status     ⌛ Queue
🎭 Presets     🧹 Compact    ⏹ Stop
```

- `☰ Menu` P1：New / Project / Reasoning / Goals / Workspaces / Skills / Subagents / Jobs / Dynamic / Host / Capabilities / Watch
- `☰ Menu` P2：低频与只读卡片。
- 每张卡片保持一个原则：**状态是消息正文，动作是内联按钮，危险动作要确认，失败给下一步指引。**

### 4.2 聊天绑定（P0 核心体验）

每个 whitelist chat 维护：

```ts
Map<chatId, {
  agentId: SessionId
  lastMessageId?: number
  pendingRename? / pendingSteer? / pendingQueueEdit?
}>
```

规则：

1. chat 第一条文本：若该 chat 无绑定 agent，自动建 session（当前 Project + 该 chat 默认 preset）。
2. chat A 和 chat B 完全隔离；`/new` 只替换自己 chat 的绑定，并归档旧 session。
3. `Sessions` 卡显示“本 chat 的会话”加“全部会话”两个 tab（或先本 chat）。
4. 审批/提问只发到产生它的 session 的绑定 chat；没有绑定时才广播。
5. 多 chat 的 Queue 计数、Status、Typing 都按 chat 自己的 agent 计算。

### 4.3 高频动作的人性化顺序

1. **说话即工作**：文本默认 followup；图片默认附件 prompt；`queue-only`/`muted` 规则仍然先匹配。
2. **看不顺眼就停下**：Stop 键在键盘右下，turn 中立即 cancel；Queue 卡每项可直接编辑/删除。
3. **选模型像聊天**：Models 卡 provider 行 → 模型行 →（有 reasoning 时）Thinking 行，选中即回执。
4. **会话找回**：Sessions 卡显示 `▸ 当前 / 标题 / live·running·archived`，点开是 Use/History/Rename/Fork/Archive/Model/Queue/Log；`/search` 支持自然语言短句。
5. **反馈随手**：最终回复下方常驻 `👍 👎 📋`，一次点按即 `messageFeedback/put`；列表可删。
6. **配置用表单化流**：`/settingsupdate` 保留给高级用户，卡片上 namespace → `Set/Unset/Replace/Mutate` 提示 JSON；凭据用“发完即删”。
7. **项目切换**：保留 Codex 式 `/project` 逐级目录选择；把它做成所有“新建”动作的默认作用域。

### 4.4 实时性分级（避免刷屏）

| 信息 | Telegram 呈现 | 刷新策略 |
| --- | --- | --- |
| 最终回复 | 正常消息 | turn/end 后发 |
| 思考/工具进度 | openclaw 草稿单条 edit | 250-400ms 防抖，超过 N 行裁剪 |
| Queue 数量 | 键盘 `⌛ Queue · N` | 1.5s 防抖替换小载体 |
| Status 统计 | 打开中的 status 卡 | session/event 时原地 edit；没开就不发 |
| host/forwarded 事件 | 只刷新已打开的相关卡片 | 不主动轰炸 |
| approval/question | 内联按钮卡 | 只发绑定 chat；settle 后原地改文案 |

### 4.5 命令与自动补全

- `/start` 时当前注册 **39 条** 命令，覆盖全部已实现命令；以后新增命令必须同步补进 `TELEGRAM_COMMANDS` 与 `/help`。
- 每条命令失败时都回“下一步可点什么/发什么”，而不是只有错误字符串。

### 4.6 分阶段实施顺序

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| R1（本轮） | 审计 + 本清单 + subagent prompt ContentBlock 修复与测试 | 本文件存在；`npm run build` 绿；node --test 147/147 通过 |
| R2 | P0 最后一项：session.create `agentPreset` + Host settings/Host 卡按钮化 | 每个 web 方法至少一条 TG 路径；新会话可选 preset |
| R3 | P1 会话隔离 + 语义对齐 | 两个 chat 并发不串话；history/skills/session create 对齐 web |
| R4 | P2 实时事件 + 命令补全 + 附件/语音 + 安全确认 | 11 个转发事件触发刷新；危险操作有确认；secret 不留痕 |
| R5 | 全量测试 + 实测清单更新 | `npm run check` 全绿；TESTING.md 逐项通过 |

---

## 5. 本轮已落地的修复

- [x] P0 `session.create` agentPreset：`✨ New` 改为 preset 选择卡（默认 preset 一键新建 + 逐 preset 选择）；`/new` 命令保留默认 preset 直建。
- [x] P1 全部 10 项落地（skill.list cwd+scope、Providers 卡、reasoningEffort、subagent parentAvailable + continuable 校验、credentials ref 枚举、host 版本不写死 + breadcrumb、settings web 边界过滤、downloads 超限指引）；测试 357/357 全绿。

- [x] 修复 `subagent.prompt`：原来把 `UserMessage` 对象当作 `ContentBlock[]` 传给
      `ctx.subagents.followup`（会触发 web 契约外的错误）；现改为 `[{ type: 'text', text }]`。
- [x] 新增 `test/subagents.test.mjs`：验证 payload、降级路径、interrupt authority。
- [x] 修复既有未完成改动导致的编译错误：把 `TELEGRAM_COMMANDS` 移到模块作用域；`npm run build` 与 `node --test`（147 tests）全绿。
- [x] 复核当前工作区已接线的 messageFeedback 全链路（👍/👎/📋 → put/list/delete）与 39 条命令自动补全，修正审计表。
- [x] 最终回复改为 Telegram 原生 `reply_parameters` 引用入站消息（bridge/telegram_reply/Openclaw 三路径）。
- [x] `/settingsreplace`、`/settingsmutate`、`/openpath`、`/pickdir`、`/answer` 与 Sessions 卡 Search 流程已接线；`openSearchCard` 不再是死代码。
- [x] 多 chat 冲刺：router per-chat FIFO；Bridge 死绑定不 fallback、换绑清旧 inbound、畸形 assistant 事件防抛、detach 清态；`/new` 与 `✨ New` 统一走 `createSessionForChat` 并只替换本 chat 会话；`/use` 恢复后 adopt handle。
- [x] approval/question 按 session→chat 路由（无绑定才广播）；`telegram_reply`/`telegram_mark_no_reply` 按执行 agent 反查 inbound，不再依赖「最近触碰」。
- [x] `ejectChat`：dsh `/telegram disallow` 与 security 热更新同步解除 bridge 绑定、typing 与 bar 残留。
- [x] openclaw 新回合取消旧 throttle timer，避免上一回合草稿 edit 打入新回合。
- [x] `outbound.liveFeed` 动态生效：core 忽略禁用状态的 consumer，openclaw 逐事件检查 `host.liveFeedEnabled()`，`/config set outbound.liveFeed true|false` 免重启切换。
- [x] 15 个 web 转发/host 事件（11 remote + session/created、session/disposed、agent/error、domain/changed）全部订阅并触发 `refreshAllPanels()`；disposer 随 teardown 回收。
- [x] 危险操作统一确认卡：session delete、workspace delete、preset remove、subagent interrupt；`buildConfirmKeyboard` 纯函数 + 单测。
- [x] `/credentialset` 原消息 500ms 后自动删除，secret 不留聊天历史。
- [x] Sessions 卡 10 条/页（`lastPromptAt desc`）、History `Load older`、`/goaledit <objective> [maxRounds]`、Preset copy 自定义 id。
- [x] Models provider 卡 12 个/页、Plugins 卡 20 个/页；`telegram_send/broadcast` 只允许白名单 roster。
- [x] host/commands/jobs/dynamic 适配器补单测（`test/host.test.mjs`、`test/commands-jobs-dynamic.test.mjs`）。
- [x] Host 卡 `Browse cwd`：可点目录逐级浏览（Up/~//、20/页），`h:ls` 旧卡片兼容映射；Jobs 卡 20/页；Search 卡专用键盘。
- [x] Skills 卡按 session 查询（传 `sessionId` option）并只显示 user-invocable；Search 结果 10/页分页。
- [x] Subagents 卡/详情补 web 字段（mode/label/hasChildren/reason）；Prompt/Interrupt 只对 continuable 子代理开放。
- [x] document/voice/video 入站不再静默丢弃：transport/router 提取并白名单检查后回明确指引；未授权媒体也会收到 allow 提示。
- [x] downloads 单测（50MB 常量 + seam 缺失降级指引）。
- [x] credentials.describe 支持批量 refs（≤64、去重、POSIX 校验）；Host 卡显示真实 bridge version。
- [x] `session.attachment` 读回闭环：`/attachment <id>` 用真实 durable ref 读回并以图片发回；Host provider/model 改读 `agentDefaultModel`。
- [x] agentPreset.list 补 `hasDocument` deployment fact。
- [x] ESM smoke import 三入口全通。
- [x] 版本升至 0.3.0，新增 CHANGELOG.md 并纳入 npm 包 files。
- [x] Host 浏览卡新增 `New folder`：回复单段目录名在当前目录创建并原地刷新（/cancel 可中止）；/mkdir 快速通道保留。
- [x] `session.models.routable` 接入 Models 卡；per-session reasoningEffort 五档选择（Thinking 行 → picker → selectSessionModel）。
- [x] settings namespace 卡透出 serialized schema envelope。
- [x] `/settingsupdate|replace|mutate` 支持尾随 `expectedRevision`（安全解析，不破坏 JSON 字符串内空白）。
- [x] subagent activity 按 web api-proxy 语义重映射 live agent status；prompt 补 clientTimeZone + AbortSignal。
- [x] 本审计文件。

> 注：状态表以当前工作区代码为准。修复/接线后应回到第 2 节更新对应勾选。
