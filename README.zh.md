# dsh-telegram

<p align="center">
  <strong>在 Telegram 上重现 <a href="https://www.npmjs.com/package/@deepseek-ai/dsh">DeepSeek Harness</a> Web 端的控制体验。</strong><br/>
  🤖 手机上直接和 dsh agent 对话 · 🗂️ 用按钮管理会话/模型/预设/工作区 · 🔧 实时状态与队列计数 · 🛡️ 多聊天隔离、未绑定即拒绝
</p>

<p align="center">
  <b><a href="README.md">English</a></b> |
  <b>简体中文</b>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.3.9-2ea44f" />
  <img alt="License" src="https://img.shields.io/github/license/xqicxx/dsh-telegram?color=blue" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-244%2F244%20green-2ea44f" />
  <img alt="dsh" src="https://img.shields.io/badge/dsh-0.1.0--rc.6-8A2BE2" />
</p>

<p align="center">
  <a href="#为什么">为什么</a> &bull;
  <a href="#特性">特性</a> &bull;
  <a href="#快速开始">快速开始</a> &bull;
  <a href="#配置">配置</a> &bull;
  <a href="#架构">架构</a> &bull;
  <a href="#命令">命令</a> &bull;
  <a href="#工作原理">工作原理</a> &bull;
  <a href="#测试">测试</a> &bull;
  <a href="#文档">文档</a> &bull;
  <a href="#安全">安全</a>
</p>

---

## 为什么？

DeepSeek Harness 的 Web UI 是 agent 控制面的金标准：会话、模型、工作区、目标、预设、审批一应俱全。这个插件把同一套能力搬到 Telegram，并补齐手机上真正顺手的人类习惯：

| 维度 | 普通 Telegram bot | dsh-telegram |
|---|---|---|
| 🤖 对话 | 单一全局会话、隐式状态 | 每个 chat 一个 agent、会话绑定、未绑定即拒绝 |
| 🧭 导航 | 一长串 slash 命令 | 常驻键盘栏 + 分页内联卡片 |
| 🧩 模型 | 文本配置或靠猜 | Provider 卡片 12/页翻页、每会话五档 reasoning 选择器 |
| 📬 队列 | 队列不可见 | 栏上 `⌛ Queue · N` 实时内嵌计数 |
| 🛡️ 审批 | 手机端无入口 | 内联 Allow/Reject 卡，结算原地改卡并移除按钮 |
| 📎 附件 | 静默丢弃 | 图片进入会话；文档/语音/视频给出明确指引 |
| 💬 回复 | 平铺消息 | 原生引用回复触发消息（不附带反馈按钮） |
| 📈 流式 | 一次全发 | Openclaw 风格实时草稿（思考/工具行/打字机回复） |

## 特性

- **🔀 多聊天隔离** — 每 chat 独立绑定 agent；每 chat FIFO 入站路由覆盖 create→bind→deliver 全链路（快速连发首条消息绝不会建两个会话）；未绑定 chat 的展示也 fail-closed
- **⚡ 响应式 UI 通道** — bar 按钮与内联回调走独立 `control:<chat>` 发送队列：卡片/命令回执/Bar 载体绝不排在 assistant 流式消息后面；Goal/Todos/Queue/收起 点击即响应
- **🎛️ 按钮式交互** — 常驻键盘栏（`☰ Menu · ✨ New · 🧩 Models` …）加临时内联卡片：会话、工作区、目标、技能、子代理、预设、设置、凭据、模型、宿主、任务、插件与动态清单
- **🗂️ 按项目分组的会话** — Sessions 卡按工作区项目分类，标题同步 web（`session/title` → cwd 基名 → id），默认展示运行中项目的会话，`🔀 项目` 一键切换，每行直接 `归档`/`删除`，归档后隐藏并在页头显示 `🗄N`
- **💡 Bar 开关** — Menu 第一页提供 `💡 收起 Bar / 显示 Bar`，也支持 `/bar [on|off]`；bar 上 `🗜️ 收起` 点击后不再留任何载体消息
- **🎯 目标入口** — Goal 在 Menu 第一页（与 Capabilities 同行），卡片只做显示/编辑/暂停/`🗑 Clear goal`（或 `/goalclear`），不影响正在运行的会话；`/goal <objective> [maxRounds]` 启动目标；长目标 turn 有 step/tool 进度卡，完成后收为 openclaw 风格收据（含缓存命中率）
- **🗂️ 工作区可直接使用** — Workspace 详情卡提供 `✅ 使用此项目`（设为当前项目）与 `🧭 会话`（打开该项目会话）
- **🌐 Web 对齐** — 适配器按 Web ApiProxy RPC 契约实现：`session.list/search/create/history/models/selectModel/prompt/attachment/updateQueue/cancel`、subagent、host、workspace、agentPreset、skills、goals、settings、credentials、llm providers/discovery
- **⚡ Openclaw 风格实时流** — 思考/工具进度/打字机回复分层渲染（goal turn 标题带目标与 step），回合总结含思考/工具/耗时、输入/输出 token、缓存命中率，以及会话轮数/步数、LLM/工具耗时与 token 速度（`outbound.liveFeed` 热切换）
- **📈 上下文压力压缩（#8）** — 最新请求 token 达到模型窗口 `compact.threshold`（默认 0.8）时按 `compact.policy`（`ask|auto|never`）弹审批卡或自动压缩，成功后推送摘要与压缩量
- **📎 媒体扩展（#9）** — 多图媒体组作为单个 user turn 全部投喂；语音经 OpenAI 兼容端点转写（`media.transcribe.*`）；文档/视频落盘到会话 attachments 目录并注入读取提示
- **📋 Todo 卡片（#10）** — `/todo` 与 bar 的 `📋 Todos · N` 实时剩余计数；`todo/write` 事件产生增量新增/进行中/完成卡片
- **📝 HTML 感知长文拆分** — 超过 4096 字符时按换行/空格边界切分，绝不切在标签或实体内部，跨切分标签逐段配平
- **♻️ 可靠发送队列** — 每 chat FIFO + 全局滑动窗口限速；只重试 429/5xx/网络/超时，永久 4xx 只试一次；长轮询重启安全且保留 offset
- **🔁 热更新与热插拔** — `internal/update` 热应用白名单/规则/限速/长度/watch；teardown 逆序回收全部挂载效应，重复 apply 幂等
- **🛡️ 默认安全** — chat 白名单（空 = 拒绝一切入站）、agent 工具仅限白名单、回调数据百分号编码、token 单次消费且有界、密钥永不回显
- **🤖 Agent 工具** — `telegram_send` / `telegram_reply` / `telegram_broadcast` / `telegram_attach`（发文件：图片/语音/音频/文档）/ `telegram_status` / `telegram_mark_no_reply`，全部走同一套经审计的发送管线

## 快速开始

### 1. 创建 Telegram bot

打开 [@BotFather](https://t.me/BotFather) → `/newbot`，保存返回的 token。token 只从 `TELEGRAM_BOT_TOKEN` 读取——绝不写入磁盘或 profile。

### 2. 安装插件

```sh
# 安装到 dsh profile（等价于在 profile 目录执行 pnpm add）
dsh plugin --profile <name> add dsh-telegram

# 在 <profile>/cordis.patch.yml 用户层加入 loader 条目
#   - insert:
#       - id: telegram
#         name: dsh-telegram

# 提供 token
export TELEGRAM_BOT_TOKEN='123456:ABC...'
```

### 3. 配置 `telegram.json`

位于 `<workspace>/.pi/telegram.json`（向上最近的包含 `.pi` 的目录）：

```json
{
  "security": { "allowedChatIds": [123456789] },
  "watch": { "autoStart": true },
  "outbound": { "liveFeed": true },
  "interactive": { "userQuestions": "telegram" }
}
```

所有字段可选；`security.allowedChatIds` 为空意味着**拒绝一切入站**。

### 4. 启动并放行

```sh
/telegram start        # 开始长轮询（或依赖 watch.autoStart）
/telegram allow <id>   # 白名单你的 chat id
```

然后给 bot 发 `/start`。未授权 chat 第一次发 `/start` 会收到 Allow 按钮；点击放行后欢迎语会自动重放。

### 5. 聊天

直接发消息。bot 会把该 chat 绑定到它自己的 dsh 会话，挂载 Openclaw 扩展时流式渲染回合，最终以 Telegram 原生引用回复落到触发消息，回复上不附带反馈按钮。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `security.allowedChatIds` | `[]` | 入站白名单；空 = 拒绝一切入站 |
| `watch.autoStart` | `false` | agent 创建后自动开启轮询 |
| `inbound.defaultMode` | `auto-handle` | `auto-handle` / `queue-only` / `muted` |
| `inbound.rules` | `[]` | 按顺序匹配 `chatId` 和/或不区分大小写 `pattern` |
| `outbound.parseMode` | `HTML` | 助手回复的 Telegram 解析模式。模型 Markdown（粗体/斜体/代码/链接/列表/标题/引用）会自动规范化为合法 HTML；内部卡片始终为 HTML |
| `outbound.disableNotification` | `false` | 静默发送 |
| `outbound.maxRetries` | `3` | 仅对瞬时错误的重试次数 |
| `outbound.sendRatePerSecond` | `20` | 全局滑动窗口限速 |
| `outbound.maxMessageLength` | `4096` | Telegram HTML 消息上限（拆分器使用） |
| `outbound.liveFeed` | `true` | Openclaw 风格流式草稿（需挂载 openclaw 扩展） |
| `workspace.activePath` | — | 新会话使用的活动项目目录 |
| `mode.name` | — | profile 模式标签 |
| `model.provider` / `model.model` | — | Telegram 侧默认模型，`/new` 与 `✨ New` 继承 |
| `reasoning.effort` | `medium` | `minimal` / `low` / `medium` / `high` / `max` 指令前缀 |
| `interactive.userQuestions` | `telegram` | `ask_user_question` 归属：`telegram` / `web` / `auto`。`telegram` 在 web profile 下即使 API proxy 已占用 provider seam 也能继续应答；`web` 让给浏览器 UI；`auto` 保留旧的 loader-entry 推断 |
| `interactive.allowByTool` | `[]` | 用户点按审批卡 `Allow forever (by tool)` 后永久自动放行的工具名（如 `["bash", "web_search"]`）；设为 `[]` 全部撤销 |

热更新：Telegram 侧 `/config get|set <path> [json]` 或 dsh 侧 `/telegram config get|set <path> <json>` 可实时应用并持久化任意配置叶（如 `outbound.sendRatePerSecond`）。`interactive.userQuestions` 在插件挂载时读取，下次重启生效；`interactive.allowByTool` 即时热生效。

## 架构

```
Telegram ⇄ grammY 长轮询 ⇄ 每 chat FIFO 路由
                              │
                              ├─ Bridge        每 chat 绑定、入站引用、回合事件、缺失回复提醒
                              ├─ Transport     发送队列、限速、重试分类、HTML 拆分、stop/start 世代
                              ├─ Cards         临时卡片：菜单/会话/模型/工作区/目标/…
                              ├─ Interactive   审批/提问卡（原地结算）
                              ├─ Adapters      Web ApiProxy 对齐的 ctx 服务适配器
                              └─ Extensions    reasoning 指令 + openclaw 流式草稿
```

| 层 | 文件 | 职责 |
|---|---|---|
| bridge | `src/harness/bridge.ts` | 每 chat agent 路由、事件扇入、原生引用回复、live-feed 门 |
| transport | `src/telegram/transport.ts` | 长轮询、发送队列、超时、图片/文档投递 |
| queue | `src/telegram/queue.ts` | 每 chat FIFO + 全局滑动窗口 + 仅瞬时重试 |
| router | `src/telegram/router.ts` | 命令/栏/回调/文本/媒体的每 chat FIFO 与未授权门 |
| html | `src/telegram/html.ts` | 转义工具 + HTML 感知长文拆分 |
| keyboard | `src/telegram/keyboard.ts` | 纯构建器（栏/菜单/卡片）、编码回调数据 |
| tokens | `src/telegram/tokens.ts` | 有界单次消费回调 token 注册表 |
| adapters | `src/harness/adapters/` | sessions/workspaces/goals/skills/subagents/presets/settings/credentials/llm/host/jobs/plugins/status |
| extensions | `src/extensions/` | `reasoning`（effort 指令）与 `openclaw`（流式草稿） |
| entry | `src/index.ts` | `apply/teardown`、dsh 命令 + agent 工具、卡片派发、热配置 |

## 命令

**dsh 侧**

`/telegram status` · `/telegram start` · `/telegram stop` · `/telegram allow <chatId>` · `/telegram disallow <chatId>` · `/telegram watch on|off` · `/telegram config auto-start` · `/telegram config get|set <path> [json]`

**Telegram 侧**

`/start /menu /new /compact /stop /models /sessions /workspaces /project [path] /goals /todo /bar [on|off] /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /help /menucheck /answer /config get|set <path> [json]`

另有 `/history [id] [limit]`、`/rename <title>`、`/fork [atSeq]`、`/use <id>`、`/archive <id>`、`/queue`、`/todo`、`/steer <text>`、`/cancel`、`/goal <objective> [maxRounds]`、`/goalcreate <objective> [maxRounds]`、`/goaledit <text>`、`/goalclear`、`/workspacecreate <path> [title]`、`/workspacepin <workspaceId> <sessionId> [before]`、`/pluginenable|plugindisable <name>`、`/settingsdescribe [ns]`、`/settingsupdate <ns> <json>`、`/settingsreplace <ns> <json>`、`/settingsmutate <ns> <json-ops>`、`/credential|credentialset|credentialunset <REF> [value]`、`/ls [path]`、`/mkdir <path>`、`/openpath [path]`、`/pickdir [path]`、`/discover <settingsNs> [baseURL]`、`/subagentprompt <text>`、`/sessionlog [id]`、`/commands`、`/capabilities`。

## 工作原理

一次回合的完整生命周期：

1. Telegram 投递 update → transport 先应答回调，再由每 chat FIFO router 分发命令 / 栏按钮 / 回调 / 文本 / 图片 / 文档。
2. chat 的首条消息创建并绑定 chat 专属 dsh 会话；FIFO promise 覆盖 create → bind → deliver 全链路，因此首条消息风暴也只落一个会话。
3. Bridge 把消息作为 user turn 投递（或按入站模式排队），并记录 Telegram message id 用于原生引用回复。
4. 挂载 openclaw 扩展且 `outbound.liveFeed` 开启时，思考/工具/回答流进同一可编辑草稿。
5. 最终 assistant 文本以原生引用回复落到触发消息；缺少 `telegram_reply` 会显式提醒而不是沉默。
6. 审批/提问卡由 bridge 认领、内联作答，并原地编辑卡片结算（移除已失效按钮）。

## 测试

```bash
npm run check          # tsc 构建 + node --test：244/244 green
npm audit --omit=dev   # 0 漏洞
npm pack --dry-run     # 发布载荷：dist + README + README.zh + CHANGELOG + LICENSE
```

套件覆盖 bridge 路由、多聊天隔离、transport 竞态、队列重试分类、HTML 拆分、键盘载荷编码、token 单次消费、交互卡、配置热更新、每个 Web 对齐适配器，以及 apply 级集成测试（含首条消息竞态）。

## 文档

- [`docs/WEB_PARITY_AUDIT.md`](docs/WEB_PARITY_AUDIT.md)：逐方法 Web 对齐状态与遗留缺口
- [`docs/SEAMS.md`](docs/SEAMS.md)：已核实的 dsh service seam
- [`PLAN.md`](PLAN.md)：接口映射与推进计划（A–D 节）
- [`TESTING.md`](TESTING.md)：完整自动化/实机测试记录与 Telegram 人工验收清单
- [`CHANGELOG.md`](CHANGELOG.md)：版本历史

## 安全

- 只处理白名单 chat；空白名单拒绝一切入站
- Agent 工具只能发送到白名单内 chat
- 回调数据百分号编码并安全解码；token 单次消费且有界
- 用户/agent 内容先严格 HTML 转义再包装；长 HTML 拆分不破坏标签
- bot token 只来自 `TELEGRAM_BOT_TOKEN`，永不落盘；凭据值永不回显
- 永久 Telegram 4xx 不重试；每次调用有超时，挂起请求不会卡死发送链

## License

MIT
