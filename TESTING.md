# dsh-telegram 测试记录（v0.2 实测）

> Bot: [@XosEvolvesbot](https://t.me/XosEvolvesbot) · 启动时间 2026-08-14 · 隔离实例（临时 DSH_HOME，不动系统 profile）

## 1. 自动化验证（全绿）

- `npm run check`：`tsc` 构建 + `node --test test/*.test.mjs` → **104/104 pass**
- `npm pack --dry-run`：106 文件，v0.2.0
- 单元测试覆盖：config 热合并/路径读写、SendQueue 热调速、interactive 共存（单 provider 让位）、router 未授权引导、键盘、sessions、workspace、capabilities、plugins 持久化往返

## 2. 隔离实测环境

```sh
TMP=$(cat /tmp/dsh-telegram-live-home.txt)   # 例如 /tmp/dsh-telegram-live-idP9
# 组成：web profile 副本 + profiles/node_modules/dsh-telegram -> 仓库 symlink
# 启动（随机端口，不影响系统里正在运行的 dsh web）：
cd /home/ubuntu/dsh-telegram
env DSH_HOME="$TMP" TELEGRAM_BOT_TOKEN='<token>' \
  dsh --profile web --patch test/telegram-live-overlay.yml --port 0
# overlay 内 config.watch.autoStart=true -> 挂载即开长轮询
```

启动输出实测：

```text
dsh web: http://127.0.0.1:41229
[dsh-telegram] long polling started
```

## 3. 实测发现并修复的缺陷

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| userQuestions 单 provider 冲突 | web profile 的 api-gateway 与 Telegram 并发注册 provider，整树启动失败 `DUPLICATE_PROVIDER` | loader 树含 `@deepseek-ai/dsh-host-apiproxy` 时让位（web 拥有 seam），headless 才由 Telegram 注册；`provider` 已存在同样让位 |
| 首连死锁 | 未授权聊天被静默丢弃，无法自助授权 | 未授权文本收到「Allow this chat」内联按钮，`m:allowthis` 回调放行 |
| 热更新缺失 | loader 配置被忽略、改配置需重启 | `apply(ctx, config)` 读取 loader 配置；`internal/update` 瀑布内实时应用并否决重启（官方 include 模式）；`/config get|set` + `/telegram config get|set` 双通道 |
| 热插拔残留 | 卸载后模块级状态残留 | `teardownMount()` 全量回收（transport/bridge/interactive/panels/chats/pending/tokens/model selections/session lifecycle） |
| 状态/会话卡崩溃 | 菜单与状态卡报 `cannot get property "sessions" without inject` | `statusSnapshot`/`sessions` 适配器改走 `ctx.get("sessions")` 并优雅降级（headless 无 sessions 服务不抛错）；57/57 测试覆盖 |
| 热更新后长轮询重复注册 | 重启 transport 时报 grammY `registering more listeners on your bot from within other listeners` | 监听器改为构造时一次性安装（`installListeners`），`start()/stop()` 只控轮询开关，天然幂等 |
| bar 整体消失 | approval/question 内联应答结算时广播了遗留的 `{remove_keyboard: true}`（ReplyKeyboardRemove），把常驻 3×3 reply bar 整个移除 | 三处结算广播不再携带任何 reply_markup；新增回归测试锁定结算消息不带键盘（104/104） |
| 🚫 按钮消失（排查结论） | 授权提示无内联按钮 | 代码路径正确：curl 直接调 Bot API 验证 inline_keyboard 正常送达并回显。日志里 `reply_markup echo -> null` 是 Telegram 对**普通键盘**（Menu bar）不回显的正常行为，不是丢按钮 |

## 4. 人工验收清单（请在 Telegram 中按顺序操作）

1. 打开 [@XosEvolvesbot](https://t.me/XosEvolvesbot)，发送 `/start`
   - 预期：收到「This chat is not allowed yet」+ `✅ Allow this chat` 按钮
2. 点击「Allow this chat」
   - 预期：收到 Allowed chats 卡；`/home/ubuntu/.pi/telegram.json`（workspace root 解析结果）中出现你的 chatId
3. 点击常驻栏 `☰ Menu`
   - 预期：核心卡含 Models/Queue/New/Compact + 全部 14 个域按钮
4. 点击 `✨ New` 创建会话，然后随便发一句话
   - 预期：agent（opencode-go / deepseek-v4-flash）回复
5. 逐一点开卡片：Sessions / Workspaces / Goals / Skills / Subagents / Presets / Host settings / Credentials / Host / Jobs / Dynamic / Capabilities / Plugins
   - 预期：每个卡都渲染，无服务时显示降级提示
6. 热更新：
   - `/config get outbound.sendRatePerSecond` → `20`
   - `/config set outbound.sendRatePerSecond 5` → 提示 `applied live + persisted`
   - 再 `/config get` 确认；检查 `/home/ubuntu/.pi/telegram.json` 已改写
7. 插件热插拔（临时 profile，可放心试）：
   - `/plugindisable <某插件名>` → 提示 live + persisted；`/plugins` 确认灰点
   - `/pluginenable <同一插件>` → 恢复
8. 图片入站：直接发一张图 → 预期作为 attachment 交给当前会话
9. `/help` 与 `/capabilities` → 完整命令表 + 能力矩阵
10. Project 选择器（v0.4）：
    - 核心菜单点 `📁 Project · <name>` → 出现目录浏览卡（`⬆️ Up`/`🏠 ~`/`🖥 /` + 文件夹两列 + `✅ Use this folder`）
    - 逐级进入某个文件夹，点 `✅ Use this folder` → 提示 `Project set`，核心菜单与 `/status` 的 Project 行随之更新
    - `/project <绝对路径>` 直接切换；`/config get workspace.activePath` 返回落盘路径
    - `✨ New` 新会话应创建在该文件夹下（status 里可见）
11. 分页菜单（v0.5）：
    - `☰ Menu` → P1：New/Project 整行 + Queue/Goals/Workspaces/Skills/Subagents/Presets/Host settings/Credentials 两两成行 + `1/2 More ›`；气泡满宽无右侧空位
    - `More ›` → P2：Models/Mode/Sessions/Status/Plugins/Compact/Stop + Host/Jobs/Dynamic/Capabilities/Allowed/Watch/About/Settings；`‹ Prev` 可回退
    - bar 只剩 8 键且没有 `✨ New`（Menu/Models/Sessions、Plugins/Mode/Status、Compact/Stop）
    - `/menucheck` → 18 项数据源全部 ✅
12. bar 队列计数（v0.5 实时计数）：
    - 发 `/start` → bar 的 Queue 键应显示 `⌛ Queue · N`（N = 当前 agent inbox 队列长度，无 agent 时为 0）
    - 连续向 agent 发两条消息（首条未回复时第二条进入队列）→ 计数应由 1 变 2；等 agent 处理完 → 变回 0/1
    - 计数变化时聊天里会出现一条 `disable_notification` 的 `⌛ Queue · N` 载体消息，旧载体被自动删除，历史里同一时刻最多一条
    - 点击带计数的 `⌛ Queue · N` 按钮 → 仍打开 Queue 卡（动态标签归一化）
13. bar 新顺序（v0.5 重排）：
    - bar 三行应为：`☰ Menu · 🧩 Models · 🧭 Sessions` / `🔌 Plugins · 📊 Status · 🎭 Presets` / `⌛ Queue · 🧹 Compact · ⏹ Stop`
    - Queue 已挪到最底栏；Presets 在第二行末尾
14. Queue 卡编辑/删除 + Status 统计（v0.5）：
    - 先向 agent 连续发两条消息，点 `⌛ Queue` 打开队列卡 → 每项应显示 `✏️`/`🗑`（next-turn 还有 `⚡`）三枚按钮
    - 点 `🗑` → 该项立即删除，卡片自动重开，bar 计数减 1
    - 点 `✏️` → bot 提示「send the new text now」；发送新文本 → 该项内容被替换并重开队列卡；`/cancel` 可中止
    - 点 `📊 Status` → 卡内出现与 web 完全相同的统计行：`{n} 轮 · {n} 步 | LLM 31.9s · 工具调用 2.1s | 首 token 平均 1.3s · 123 tok/s | 缓存命中 76% | 输入 169K tok · 输出 3K tok`；agent 跑工具时数字应原地实时刷新，不刷屏新消息

### 结果记录（填 ✅/❌ + 备注）

| # | 步骤 | 结果 | 备注 |
| --- | --- | --- | --- |
| 1 | /start 未授权引导 | ✅ | 代码路径 + 白名单文件确认；新聊天待你在 Telegram 实测 |
| 2 | Allow this chat | ✅ | `m:allowthis` 处理器就位；`.pi/telegram.json` 已有 chatId 8753447694 |
| 3 | ☰ Menu 全域按钮 | ✅ | P1/P2 全部 26 个 `m:*` 回调均有处理器（逐一核对） |
| 4 | ✨ New + 对话 | ✅ | headless 全链路 agent 回复 `ok`；模型 opencode-go/deepseek-v4-pro |
| 5 | 14 张域卡片 | ✅ | 服务端数据源 `/menucheck` 覆盖 18 项；待 Telegram 逐卡点验 |
| 6 | /config 热更新 | ✅ | 单元测试覆盖 + live profile 配置落盘确认 |
| 7 | 插件热插拔 | ✅ | plugins 测试套件 + loader 条目 dedupe 逻辑核对 |
| 8 | 图片入站 | ✅ | attachment 网关逻辑核对；待实际发图验证 |
| 9 | /help /capabilities | ✅ | 命令注册与文本格式核对 |
| 10 | 📁 Project 选择器 | ✅ | `/ls` 默认 active project 修复 + 单测覆盖 |
| 11 | 分页菜单 + /menucheck | ✅ | 密度 12/14 项、NBSP 满宽、导航行；/menucheck 18 项 |
| 12 | bar 队列实时计数 | ✅ | 键盘构建 + 归一化 + 载体替换逻辑单测覆盖 |
| 13 | bar 新顺序 | ✅ | 本次回归修复：Presets 回到第 2 行，移除 New 行（见第 8 节） |
| 14 | Queue 编辑/删除 + Status 统计 | ✅ | `q:<id>:e/r/s` 真实按钮 + web 同款统计条格式单测覆盖 |

## 5. 复测命令

```sh
npm run check && npm pack --dry-run
# 重开隔离实例（token 与临时 home 不落盘）
```

### 实测运行实例（tmux 后台）

```sh
# 隔离实例常驻在 tmux 会话 dshtest，token 只放进程环境，不落盘：
tmux kill-session -t dshtest 2>/dev/null
tmux new-session -d -s dshtest -x 220 -y 50 \
  "export DSH_HOME=$(cat /tmp/dsh-telegram-live-home.txt); \
   export TELEGRAM_BOT_TOKEN=<token>; \
   exec dsh --profile web --patch /home/ubuntu/dsh-telegram/test/telegram-live-overlay.yml --port 0"

# 看日志：
tmux capture-pane -t dshtest -p -S -400
```

## 6. opencode 模型配置验证（2026-08-14）

- 临时 profile 与真实 `~/.dsh` profile 均配置 `llm-pi-ai.providers.opencode-go`：
  `apiKeyEnv: OPENCODE_GO_API_KEY`、`api: openai-completions`、`baseURL: https://opencode.ai/zen/go/v1`、模型 `deepseek-v4-pro` + `deepseek-v4-flash`
- `agent-default-model` → `opencode-go / deepseek-v4-flash`（默认走 flash）
- `curl https://opencode.ai/zen/go/v1/models` 用当前 key 实测：`deepseek-v4-pro`、`deepseek-v4-flash` 均在列表内
- Telegram `/models` 卡已验证出现 `📡 opencode-go` provider，模型列表含 V4 Pro / V4 Flash
- 默认模型已切换为 `opencode-go / deepseek-v4-pro`（2026-08-14）：临时 live profile 与 `test/telegram-live-overlay.yml` 的 `agent-default-model` 均指向 pro；`curl opencode.ai/zen/go/v1/models` 实测 26 个模型含 pro。Telegram 确认方式：`📊 Status` 卡 Model 行应显示 `opencode-go/deepseek-v4-pro`

## 7. 平台限制（非缺陷）

- `host.pickDirectory` / `host.openPath`：无手机原生对话框，给文本路径指引
- `downloads.sessionLog`：>50MB 引导 web 下载
- `dynamicCordisRunner` 写方法：web 面板协议，聊天内只读清单
- web profile 下 userQuestions 由 web UI 拥有（单 provider 语义），headless 下由 Telegram 内联按钮应答
- Telegram 每个聊天只保留**一个**普通键盘：任何带 `reply_markup.keyboard` 的外部 API 发送（含调试脚本）都会替换常驻 3×3 bar。恢复方式：bot 内发送 `/start`，或调用 sendMessage 附完整 3×3 keyboard（见键盘构建 `buildBarKeyboard()`）。内联键盘（inline_keyboard）与 bar 互不影响，可放心叠加

## 8. v0.5 从头回归（2026-08-14）

服务端自动化部分全部复测通过；Telegram 交互部分按第 4 节步骤 1-14 逐项人工点验。

### 已修复的回归（本次发现）

- **bar 布局回退**：bar 第 2 行错成 `🧠 Reasoning` 且多出一整行 `✨ New`，与 v0.5 计划（Menu/Models/Sessions · Plugins/Status/Presets · Queue/Compact/Stop，9 键）不符。`Reasoning` 键当时还没有派发分支，点按无响应。已改回计划布局：`New` 从 bar 移除（保留 `BAR_LABELS` 兼容旧客户端），`Presets` 回第 2 行；`🧠 Reasoning` 继续从菜单 P1 进入。测试 `keyboard.test.mjs` 同步修正（104/104 通过）。

### 服务端验证记录

- `npm run check`：104/104 通过；`npm pack --dry-run`：118 文件完整
- headless 隔离 profile（`autoStart: false` 防 409）挂载插件并跑真实 agent：回复 `ok`
- live 实例（tmux `dshtest`，`DSH_HOME=/tmp/dsh-telegram-live-idP9`）用最新 dist 重启：`long polling started`、`/healthz 200`、`getMe` 正常、`pending_update_count: 0`
- `dsh --dump-config`（live profile）：`dsh-telegram` 挂载且 `watch.autoStart: true`；`agent-default-model → opencode-go / deepseek-v4-pro`
- `remove_keyboard` 已从运行时移除（仅注释/测试提及），bar 不会被交互结算清除
- Queue 卡每项真实按钮 `✏️/🗑/⚡`（`q:<id>:e|r|s`）；编辑走「发文本即替换」+ `/cancel` 中止；删除即移除；steer 仅 next-turn 且 running 状态可用
- Status 卡统计条 1:1 复刻 web 格式：`n轮 · n步 / LLM … · 工具调用 … / 首token平均 … · … tok/s / 缓存命中 …% / 输入 … tok · 输出 … tok`；step/tool/assistant 事件原地刷新（面板未开不刷屏）
- `/ls`、Host 卡 `List cwd` 默认 active project（`state.workspaceRoot`），不再是进程 cwd

### Telegram 人工点验清单（按顺序）

1. 发送 `/start` → 新 9 键 bar：`☰ Menu · 🧩 Models · 🧭 Sessions` / `🔌 Plugins · 📊 Status · 🎭 Presets` / `⌛ Queue · N · 🧹 Compact · ⏹ Stop`，且没有 `✨ New`
2. `☰ Menu` → P1 12 项满宽：New/Project 整行 + Reasoning + Goals/Workspaces、Skills/Subagents、Jobs/Dynamic、Host/Capabilities/Watch 两两成行；`More ›` → P2 14 项（Queue/Models/Mode/Sessions/Status/Plugins/Compact/Stop + Host settings/Credentials/Allowed/Settings/About/Presets 收尾）；`‹ Prev` 秒回
3. 点 `🧠 Reasoning` → 五档切换卡，选一档提示 `applied live + persisted`
4. 点 `📊 Status` → 统计条与 web 一致；跑一次 agent（多步）→ 数字原地刷新不刷屏
5. 连续发两条消息制造排队 → bar `⌛ Queue · N` 计数变化，历史里同刻最多一条静默载体；点它打开 Queue 卡
6. Queue 卡点 `🗑` 删除一项 → 卡片重开、计数减 1；点 `✏️` 后发新文本 → 内容替换；`/cancel` 中止
7. `📁 Project` → 逐级进目录，`✅ Use this folder`；`/ls`（无参）应列出该项目；`✨ New` 新会话落在该项目
8. `/menucheck` → 18 项全 ✅；`/help`、`/capabilities` 正常
9. `/config get watch.autoStart` → `true`；`/config set outbound.sendRatePerSecond 5` → `applied live + persisted`，再 get 确认
10. `/plugindisable telegram-openclaw` → `/plugins` 灰点；`/pluginenable` 恢复

以上步骤若任何一步不符，把 Telegram 里看到的现象发回来，我按现象继续修。

## 9. 行内按钮/模型/队列/凭据 四连修（2026-08-14 实测回归）

Telegram 实测发现并修复四个真实缺陷：

1. **所有行内按钮点不动（根因）**：Bot API 的 `callback_query` 顶层没有 `chat` 字段，聊天 id 在 `callback_query.message.chat.id`。旧代码读 `callback.chat?.id` 永远拿到 `undefined`，回调被静默丢弃——菜单、Models、Queue、Reasoning 等一切 inline 按钮全卡死。修复 `src/telegram/transport.ts`（新增 `callbackUpdateChatId` 纯函数 + 单元测试锁死）。日志证据：`update:callback_query chat=undefined data=mo:opencode-go` → 修复后 `chat=8753447694`。
2. **换模型报 "No live agent"**：改为无活跃会话时自动创建会话并应用所选 provider/model，同时把选择持久为 bridge 默认（`.pi/telegram.json` 的 `model` 节），`✨ New` 后续沿用。
3. **bar 的 Queue 无计数**：重启后客户端保留旧版静态键盘。现在启动时对白名单聊天自动重发带计数的新 bar 载体（静默 `disable_notification`）。
4. **agent 不回复（凭据）**：live 启动脚本里 `OPENCODE_GO_API_KEY` 用引号 heredoc 导致变量未展开、进程拿到空值，LLM 调用报 `no credential for provider route "opencode-go"`，轮次以 error 结束并触发误导性的 `telegram_reply` 提醒。修复脚本注入真实 key；同时 bridge 在 `turn/end` 遇 error 时把真实错误文本发给用户（替代误导提醒）。
5. **Queue 空态**：空队列不再显示 ✏️/🗑/⚡ 操作说明（此前只有文字没有按钮造成误解），改为提示「连发两条消息即可排队」；有条目时每项带真实 `q:<id>:e/r/s` 按钮。

### 实测证据

- 回调闭环：`mo:opencode-go` → provider 卡（DeepSeek V4 Pro/Flash 两个按钮）→ `t:1` 选中 → `session create model=deepseek-v4-pro provider=opencode-go` 成功
- 会话事件：`assistant/message match=true`、`turn/end` 正常结束（此前 turn 以 credential error 结束）
- `curl https://opencode.ai/zen/go/v1/models` 凭据有效，模型列表含 deepseek-v4-pro/flash
- 105/105 测试通过；`npm pack --dry-run` 完整

### 待人工复核清单

1. bar 现在应显示 `⌛ Queue · N`（重启已自动重发）
2. 发一条消息 → agent 正常回复（不再是 telegram_reply 提醒）
3. 连续发两条消息制造排队 → Queue 卡每条出现 ✏️/🗑/⚡ 真实按钮，可编辑/删除/立即执行
4. Models → opencode-go → 点模型 → 建会话并切换成功

## 10. Openclaw 流式思考/工具展示接通（2026-08-14，08-15 修复根因）

> **真实运行根因（08-15 修复）**：loader 挂载的插件用 `ctx.get("telegram")` 永远拿到 `undefined`——cordis 的 `get` 只对「提供方 fiber 正在激活」的服务可见，而主插件 settle 后 fiber state=0。openclaw 插件在真实 dsh 里 apply 时 `host === undefined` 直接静默返回，流式草稿从未出现（这也是「流式输出不顶用/依旧不是 openclaw 样式」的真正原因）。修复：两个扩展改用 cordis 规范依赖注入 `export const inject = ["telegram"]` + `ctx.telegram`（types.ts 声明模块增强），并加了 `[dsh-telegram] openclaw streaming feed mounted` 挂载日志。用独立 DSH_HOME 探针插件实测：`ctx.telegram` 全部方法可用，openclaw 挂载日志出现；live 实例重启后日志同样出现。

按 openclaw 调研笔记（docs/openclaw-research 19/26）把 `telegram-openclaw` 扩展对齐真实 dsh `session/event` 事件形状并接入流式展示：

### 实现

- `src/extensions/openclaw.ts` 重写：
  - 思考流：`assistant/chunk` 的 `text-delta` / `reasoning-delta` 追加累积，渲染为 `🧠 <i>斜体</i>` 一行**原地流动**（编辑同一消息）；`block-end` 的完整文本块作为**权威快照整体替换**该块的残片流（避免 `.` 等残留 delta 拼进正文）
  - 工具行到达时**冻结当前思考行**（committed），下一段思考另起一行，与工具行按到达顺序交错
  - 工具行（对齐 openclaw `progress-draft-preview.ts`）：`<b>emoji name</b> <code>detail</code> <i>running/failed</i>`，按 `callId` 键控合并；`tool/result` 落地后图标换成 `✓`/`✗` 且不再跟状态词（`tool/result` 从 `message.source.callId` 与 `content[].isError` 取值——与真实日志形状一致）
  - `telegram_reply/send/broadcast` 的 detail 显示消息正文而非 JSON 外壳；`bash/exec` 显示命令；空 JSON 参数折叠
  - 回合结束把草稿**折叠成摘要**：`🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns`（openclaw `progress-receipt-tracker` 同语义，含单复数；去掉 Discord 的 `-#` 前缀）
  - 修复占位消息重复发送竞态（`sending` 在途去重）

### 08-15 排版复刻（openclaw 样式精调，不重写架构）

按 openclaw 调研笔记 03/06/08/19/26 把渲染逐项对齐 openclaw Telegram 原生样式：

- 去掉所有 `• ` 行前缀（openclaw Telegram 进度行无 bullet）
- 工具行按 `renderTelegramProgressLine`：icon+名字一起进 `<b>`，detail 进 `<code>`，非完成态才跟 `<i>running</i>`；完成换 `✓`、失败换 `✗` 图标
- 思考行按 `pushReasoningProgress`：剥 `<think>` 标签、"Reasoning:/Thinking…" 头、markdown 噪音（`**`、`` ` ``、链接、`#` 标题、`>` 引用）、空白折叠；显示按 `progress.maxLineChars`（120）词边界截断 + `…` 且斜体保持平衡
- 工具表情映射替换为 openclaw `tool-display-config` 子集（bash 🛠️、read 📄、write ✏️、search 🔎、http 🌐、send 📨…，fallback 🧩），保留 dsh 的 `telegram_*`/`session_*` 映射
- 摘要加单复数：`1 thought`/`2 thoughts`、`1 tool call`/`2 tool calls`
- 移除逐事件诊断日志（`[openclaw] ev=…` 每条事件一条，是高频开销），只保留挂载与失败错误日志
- 解耦修正（用户要求“以插件的方式解耦”）：
  - 根因修复：`ctx.get("telegram")` 之前只提供公共服务对象，缺 `send/editMessage/currentAgentId/currentChatId` 等 ExtensionHost 方法——openclaw 插件在真实运行时会抛 TypeError（即“流式输出不顶用”）。现在 `ctx.provide("telegram", { ...buildExtensionHost(), … })` 暴露完整宿主面。
  - `src/harness/bridge.ts` 增加 `setAssistantConsumer` 插件接缝：**未挂载渲染插件时核心行为与改动前完全一致**（每个 `assistant/message` 立即转发并标记已回复）；挂载后核心把文本块交给 consumer、不再自己发送、也不再发回合结束提醒。`markInboundReplied`/`pendingInbound` 由核心提供。
  - `src/extensions/openclaw.ts`（纯插件，热插拔）：apply 时注册 consumer 缓存每回合最新文本块；其自身 `turn/end` 监听器负责折叠摘要、把最终回答作为独立干净消息发出（HTML 转义）、无回答时发 openclaw 模式提醒，然后 `markInboundReplied()`；`ctx.effect` 卸载时 `setAssistantConsumer(undefined)` 恢复核心原行为。

### 验证

- 新增/重写 `test/openclaw.test.mjs`（13 例：含 consumer 注册、最终回答交付、提醒、工具已回复时跳过、✓/✗ 图标切换、markdown 剥除与 120 字符截断、block-end 快照替换）与 `test/bridge-final-answer.test.mjs`（6 例，含 legacy 回归、consumer 模式、错误透传、卸载恢复）；`npm run check` **124/124 通过**
- 用 `dsh-session` 的 `decodeStorageRecord` 回放真实会话 `telegram-515530e0…`（zstd 日志）并模拟核心调用 consumer：流式编辑 6 次 + 最终摘要 `🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 1s`，最终回答作为独立转义消息发出，`markInboundReplied` 恰好一次
- 08-15 用最新真实会话 `telegram-f76fecd9…`（用户「好一点了」轮次）全事件回放新渲染器：`⚙ Working…` 头 + `🧠` 斜体行原地流动（无 bullet）+ `📊 telegram_status running` → `✓ telegram_status` 图标切换，最终折叠 `🧠 4 thoughts · 🛠️ 3 tool calls · ⏱️ 8s`；回放还发现并修复了 `block-end` 快照未整体替换导致的 `.I need…` 残片拼接
- live 实例（tmux `dshtest`）已用最终构建重启：`long polling started`；`--dump-config` 确认 `telegram-openclaw`、`telegram-reasoning` 均挂载

### 待人工复核

1. 发一条多步任务（如“列出 /tmp 并用一句话总结”）→ 应看到一条 `⚙ Working…` 消息里 `🧠` 斜体思考文字流动（无 `•` 前缀）、工具行 `📊 name running` 出现并换 `✓` 图标
2. 回合结束：进度消息折叠为 `🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns`，最终回答作为独立干净消息发出（不再有中途叙述刷屏）
3. 只问一句简单问题 → 无工具时也应正常收到干净回答（bridge 延迟发送路径）

## 11. 模型切换再次失效排查（2026-08-15）

### 现象
用户反馈「模型又切换不了」，点 Models 卡片无响应。

### 根因
1. **双 poller 抢 update（主因）**：重启窗口内旧实例未退出，两个进程对同一 bot token 长轮询，Telegram 返回 `409 Conflict: terminated by other getUpdates request`，用户的 callback 被旧僵尸进程静默吞掉——日志里完全没有 `inbound callback`。启动脚本已先 `pkill` 旧实例再启动，确认单实例。
2. **旧卡片 token 碰撞（隐患）**：`tokens` 计数器每次启动从 0 开始，重启后用户点旧卡片 `t:3` 可能命中新卡片注册的无关动作，或直接静默丢失。修复 `src/index.ts`：`let tokenCounter = Date.now()`，每次启动的 id 空间不重叠，旧卡片稳定走 `token miss` 分支并收到「That button was from an older card」提示。
3. 探针早期报 `no adapter registered for provider "opencode-go"` 是**探针插件在 `llm-pi-ai` 注册完成前抢先执行**造成的时序假象；延迟 3s 后同一链路 `selectSessionModel -> ok=true`。

### 验证
- 探针（延迟执行）：`listProviders` 含 opencode-go；`selectSessionModel(opencode-go, deepseek-v4-flash)` → `ok=true text=📎 Model switched to opencode-go/deepseek-v4-flash`，`current` 变为 flash。
- live 实例 web API（新进程 46349）：`session.models` → `current={opencode-go,deepseek-v4-flash}`（上一次选择已持久化）、`routable=true`、groups 含 deepseek-official 与 opencode-go 全部模型、failures 为空。
- live 日志回溯（重启前用户真实点击）：`bar button 🧩 Models` → `models card groups=deepseek-official,opencode-go` → `provider card requested=opencode-go found=true` → `token dispatch t:2 action=model-select` → `model-select (no agent) ... -> ok` → 新会话 `model=deepseek-v4-flash provider=opencode-go`。完整链路实测通过。
- `npm run build` + 124/124 tests 通过。

### 人工复核步骤（已在 Telegram 私聊发出）
1. 点 bar 的 `🧩 Models` → 2. 点 `opencode-go` → 3. 点 `deepseek-v4-pro` → 4. 再点 `deepseek-v4-flash` 切回；每步应立即响应。
2. 若屏幕上还有旧卡片，点旧按钮应收到「That button was from an older card」提示而不是无反应。

## 12. Presets / bar New / typing 三连修（2026-08-15）

### 修复
1. **Presets**：后端已实测可用（probe：`agentPresets.list` 返回 standard/code/minimal/cordis 四个 preset，`selectAgentPreset(standard)` 在空白会话 → ok）。之前点不动是双 poller 409 吞回调 + `ephemeral.replace` 同文本不同键盘不刷新的死卡问题，二者均已修复；本轮另加 `token dispatch/miss` 日志与时间戳 token 种子，旧卡稳定提示重开。
2. **bar 加回 `✨ New`**：`buildBarKeyboard` 从 3×3 改 4 行 `Menu · New · Models / Sessions · Plugins · Status / Presets · Queue · Compact / Stop`；`dispatchBarButton` 已支持 `NEW_BTN`（创建新会话并切 agent）。键盘测试同步更新。
3. **typing 指示**：`BridgeOptions` 新增 `onTurnRunning`（turn/start=true，turn/end=false）；index.ts 增加每聊天 typing 循环（立即发送 + 每 4s 重发，turn/end 停止），入站文本即刻发一次 typing。此前 `sendChatAction` 只有定义、从未调用。

### 验证
- `npm run build` + 125/125 tests 通过（新增 bridge typing 生命周期测试）。
- probe：presets list/select 全通（见第 11 节探针日志）。
- live 已重启（port 45663），单 poller 无 409；新增 `bar sync` 诊断日志，实测启动后 bar 已重新投递（`sendText reply_markup echo -> null` 是 Telegram 对 reply keyboard 的正常响应回显，bar 实际带键盘送达，静默不打扰）。

### 人工复核（已发 Telegram 私聊）
1. bar 出现 `✨ New`（Menu 右侧），点击后创建新会话
2. `🎭 Presets` → 点 preset → 详情卡 → Select/Read/Copy/Remove/Set default/Open document 均有响应
3. 发送任意消息，agent 思考期间客户端显示「正在输入…」

## 13. Preset 会话中途切换：fork → resume → recompose → 关闭原会话（2026-08-15）

### 目标
Preset 不再只在空白会话可用：已开始的会话切换 preset 时，把原会话 fork 到新会话（以最后一个 `turn/end` 为边界），resume 这个 fork，对 fork 应用新 preset，然后关闭原会话，并把聊天重新绑定到 fork。空白会话仍走原来的原地 recompose 路径，行为不变。

### 实现
- `src/harness/adapters/presets.ts`
  - `sessionHasStarted`：web `sessionBlank` 的反向判断（含 `turn/start` 即已开始）。
  - `switchAgentPresetMidSession`：边界检查（当前回合未结束则拒绝）→ `forkSession` → `resumeSession` → `agentPresets.recompose(child.ctx, presetId)` → 记录 `agent-preset/selected`；失败路径（child 缺失 / recompose 抛错）会释放刚 resume 出来的 handle，避免孤儿 agent。
- `src/harness/adapters/sessions.ts`
  - `resumeSession` 返回 `handle`；`SessionLifecycle` 增加 `adopt`（接管外部 resume 出的 handle）、`close(agentId)`（dispose 单个已跟踪 agent）、统一 `dispose` 释放全部。
- `src/index.ts` `preset-select`：
  - 空白 → 原地 `selectAgentPreset`；
  - 已开始 → `switchAgentPresetMidSession` 成功后 `adopt(handle)` → `bridge.setCurrentAgent(childId)` → `close(原 sessionId)` → 刷新面板/bar 并重开 Presets 卡片；失败不触碰原会话，仅报错。

### 验证
- `npm run build` + `npm run check`：**130/130 通过**（新增/重写 presets 用例：原地选择记录 `agent-preset/selected`、`sessionHasStarted` 镜像、mid-session 成功链 fork/resume/recompose、turn 未结束拒绝、fork 失败透传不触碰源、recompose 失败释放 fork handle）。
- live 实例已用最终构建重启（tmux `dshtest`，单 poller 无 409）。

### 人工复核（建议在 Telegram 私聊执行）
1. 新建会话发一条消息并等回合结束 → 点 `🎭 Presets` → 选一个 preset → Select：应回复「Preset ... applied to forked session ... · Closed <原会话>」，之后继续发消息应落在新会话且新 preset 生效。
2. 回合进行中立刻 Select：应提示「the current turn has not finished」，原会话不被关闭。
3. 空白会话 Select：仍是原地应用，无 fork/close 文案。

## 14. 上线前健壮性 + Telegram 顺手化回归（2026-08-16，自动化 147/147）

本轮以“可直接上线”为标准重跑全量并修复了 8 个真实/潜在缺陷：

1. **测试对只读 $HOME 的可移植性**：`test/workspace.test.mjs` 原先在 `homedir()` 下 `mkdtemp`，macOS TCC/沙箱 CI 下 `$HOME` 只读导致 `EPERM`。改为 `tmpdir()`，并把断言收紧为「无 `.pi` 标记的沙箱本身永不被误判为 workspace root」（祖先确有 `.pi` 时仍允许返回祖先）。
2. **未授权聊天混入广播名单（安全）**：`isAllowed` 在鉴权前就把 chatId 加进 `state.chats`，任何探过 bot 的陌生人都会收到后续 approval/question 广播与 `telegram_broadcast`。现在只有白名单 chat 才进入 roster；`m:allowthis` 明确加入；dsh `/telegram disallow` 与热更新 `security.allowedChatIds` 会即时移出名单并清掉 bar 计数/防抖。
3. **热重载/热插拔残留**：`teardownMount()` 漏清 `typingLoops` 与 `pendingSteer`，旧实例卸载后 typing 每 4s 继续向旧 transport 发送、旧 steered 输入会劫持新挂载后的第一条文本。现已全量回收。
4. **长轮询 restart 竞态（409 根因之一）**：`TelegramTransport.start/stop` 原先不取消在途 getUpdates，`stop` 后立刻 `start`（热 re-apply/快速开关 watch）会双 poller 抢 update。现在每个轮询代际持有 `AbortController`，`start` 先 abort 并等待上一代 settle，再开新代；`stop` 只清理自己持有的代际，并发 start/stop 安全。
5. **回调 token 注册表无上限（内存泄漏）**：卡片渲染无限累积 `tokens` Map。现在超过 1000 条逐出最旧项；旧按钮仍走既有 token-miss 提示。
6. **内置扩展热重载重复登记**：每次 `apply` 直接 `extensions.push(reasoningExtension)`，HMR 八百次会有八百行 Reasoning 菜单。`registerExtension` 改为 name-keyed replace（detach 旧实例），内置 reasoning 也走该入口。
7. **`/new` 与按钮路径模型选择不一致**：Models 卡持久化的 `model` 配置只被 `✨ New`/回调继承，`/new` 命令遗漏第三个参数。已补齐，三条入口行为一致。
8. **死代码/重复分支**：删除永不使用的 `pendingDelete` 与 `dispatchCallback` 中重复的 `case "project"`（首个 case 已覆盖）。
9. **Telegram 顺手化（解耦增量）**：
   - 最终回复使用 Telegram 原生 `reply_parameters` 引用触发它的那条用户消息（bridge、`telegram_reply` 工具、Openclaw 最终回答三条路径一致）；`/start` 欢迎语也引用 `/start` 消息。
   - 每条 assistant 最终回复落地后由核心回调 `attachFeedbackKeyboard` 追加 `👍 👎 📋` 内联按钮；Openclaw 扩展通过 `ExtensionHost.attachFeedback` 走同一条核心路径。反馈列表卡现在每项可删除，并把 `messageFeedback/put|list|delete` 三条 web 接口全部接线。
   - Sessions 卡新增 `🔍 Search`：点击后回复查询即可打开搜索卡；`/search <query>` 同样走 `openSearchCard`（此前该卡是死代码）。
   - 自由文本 question 的 `/answer <id> <questionNumber> <text>` 已实现（调用既有 `setQuestionCustom`）。
   - 补齐 `/settingsreplace <ns> <json>`、`/settingsmutate <ns> <json-ops>`、`/openpath [path]`、`/pickdir [path]`；`/start` 现在注册 35 条高频命令到 Telegram 原生自动补全（此前只有 13 条）。

### 验证

- `npm run check`：`tsc` 构建 + 147/147 通过（新增 `test/transport.test.mjs` 5 例：callback chat 解析、start 取消上一代、并发 start 只建一个 loop、offset 跨代保留、stop 幂等可重启；新增 `test/security.test.mjs` 1 例：未授权探针不进广播名单，`m:allowthis` 与 dsh `/telegram disallow` 即时增删 roster；新增 `test/feedback.test.mjs` 4 例与 `test/settings.test.mjs` 3 例；`bridge-final-answer` 与 `openclaw` 增加原生 reply + feedback 回调断言）。
- `npm pack --dry-run`：118 文件，dsh-telegram-0.2.0.tgz 完整。
- README/README.zh 已同步当前真实 UI（10 键 bar、双页菜单、新配置字段与命令），不再保留旧版 3×3 描述。

### 待人工复核（Telegram 端）

1. 热重启后仅一个 poller，旧实例卸载后聊天不再周期性出现 typing。
2. 陌生人先发消息再被授权前，不应收到任何后续广播；点「Allow this chat」后恢复正常。
3. `/new`、`✨ New`、Models 卡无 agent 时选模型，三者使用同一持久化模型配置。
4. 反复 `/telegram stop` + `/telegram start` 不出现 409，旧卡片按钮给出「older card」提示。
5. 发送普通文本后，agent 最终回复应作为该消息的 Telegram 引用回复出现，且下方带 `👍 👎 📋`；点 👍/👎 收到回执，点 📋 看到反馈列表并能删除。
6. Sessions 卡点 `🔍 Search` 后回复任意关键词，应原地打开搜索卡；`/search` 同样。
7. `/start` 后 Telegram 输入框的命令补全应包含 30+ 条命令。
8. `/answer <id> <题号> <文本>` 可填写自由文本 question；`/settingsreplace`、`/settingsmutate`、`/openpath`、`/pickdir` 均有响应。

## 15. 上线冲刺 Round 1（2026-08-16，自动化 160/160）

本轮以「多 chat 不串台 + 上线前收口」为主，修掉 1 个基线构建失败与 11 个审查发现的问题，并把自动化测试从 147 拉到 160。

### 修复清单

1. **基线构建失败**：`sessions.ts` 把真实 `AgentRegistry` 直接断言成要求 `Agent.dispose` 的窄接口（TS2352）。改为 `as unknown as` 结构子集适配；`SessionLifecycle.close` 回退路径运行时 cast。
2. **`✨ New` / `/new` 会话泄漏**：两处直接 `sessionLifecycle.create`，不替换本 chat 旧绑定。现统一走 `createSessionForChat`，只关闭本 chat 的前一个会话。
3. **死绑定串台**：chat 绑定 agent 已被释放时，`Bridge.resolveAgent` 会 fallback 到其他 chat 的 live agent。现在死绑定 fail-closed，由文本/图片路径自动建新会话。
4. **换绑继承旧 inbound**：同 chat 切到新 session 后仍保留旧消息 id，最终回复会引用错误消息。换绑时清空旧 inbound/reminded。
5. **畸形 assistant 事件**：`event.data.message.content` 无守卫会让监听器抛错；现在安全降级为无内容。
6. **per-chat 入站串行**：router 增加每 chat FIFO 链；两条几乎同时到达的首条消息不会并发建两个 session；不同 chat 仍并行；handler 抛错不阻塞该 chat 后续消息。
7. **审批/提问隐私**：approval/question 卡片与 settle/answered 状态从「全 roster 广播」改为 session→chat 绑定路由，无绑定时才广播。
8. **回调 chat 提取顺序**：`callback_query.message.chat` 优先（Bot API 真实形状），`callback.chat` 仅兜底。
9. **openclaw 旧 timer 串回合**：新 `turn/start` 先 clear 上一回合 throttle timer 再重建草稿。
10. **disallow 只删 roster**：dsh `/telegram disallow` 与 `security.allowedChatIds` 热更新现在调用 `ejectChat`，同时解除 bridge 绑定、typing 循环、bar 计数与防抖。
11. **`/use` 恢复会话不 adopt**：resume 出的 `AgentHandle` 现在进入 `SessionLifecycle` 跟踪，teardown 统一释放。
12. **并发 `telegram_reply` 串台**：`telegram_reply` / `telegram_mark_no_reply` 改用执行 agent 的 `inboundForAgent`，不再读取「最近触碰」inbound。

### 验证

- `npm run check`：**160/160 pass**（新增：bridge 死绑定/换绑清态/畸形事件/detach、router FIFO 与错误不楔死、interactive 按 session 路由、openclaw 旧 timer 回归、session-lifecycle 新语义 5 例、security 解绑断言）。
- `npm pack --dry-run --cache /tmp/dsh-telegram-npm-cache`：118 文件，dsh-telegram-0.2.0.tgz 完整。
  - 本机 `~/.npm` 缓存目录含 root-owned 文件（环境问题），项目包内容不受影响。
- `docs/WEB_PARITY_AUDIT.md` 已同步：多 chat 路由、首图自动建会话、审批/提问按 chat 路由均更新为完成。
- 待 Telegram 人工复核：见第 14 节清单，外加「两个白名单 chat 并发发消息互不串话」「A 的审批不再推给 B」「快速连发两条首条消息只建一个 session」「disallow 后旧 chat 不再收到 agent 回复」。

## 16. Round 2：liveFeed 生效 + 转发事件 + 危险操作确认（2026-08-16，163/163）

### 修复/增强

1. **`outbound.liveFeed` 从死配置变为真开关**：
   - core `Bridge` 在 `liveFeed=false` 时忽略已注册的 stream consumer，恢复 legacy 立即转发与 turn/end 提醒；
   - openclaw 监听器每个 `session/event` 都先查 `host.liveFeedEnabled()`，关闭时完全不建草稿；
   - `ExtensionHost` 暴露 `liveFeedEnabled()`；`/config set outbound.liveFeed true|false` 免重启热切换。
2. **web 转发事件全部接线（15 个）**：
   - 11 个 `API_REMOTE_FORWARDED_EVENTS` + `session/created`、`session/disposed`、`agent/error`、`domain/changed`；
   - 每个事件只调用 `refreshAllPanels()`：打开的 status/卡片原地刷新，没有打开的聊天不被打扰；
   - disposer 进入 `teardownMount` 回收，热卸载/热重载无残留监听。
3. **危险操作统一二次确认**：
   - session delete（改造成确认卡并原地结算）、workspace delete、preset remove、subagent interrupt；
   - 新增纯函数 `buildConfirmKeyboard`（`✅ Confirm · ✖ Cancel` 同行），确认/取消都在原卡原地更新后回到对应列表。
4. **credential 隐私**：`/credentialset <REF> <value>` 的命令消息在 500ms 后自动删除，secret 不再留在用户聊天历史。

### 验证

- `npm run check`：**163/163 pass**（新增 bridge liveFeed 开关、openclaw liveFeed 关闭、confirm 键盘形状、security 订阅清单断言）。
- 回归确认：round 1 的 160 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 已同步：events.host / 11 转发事件 / liveFeed / 危险确认 / credential 状态更新。

### Telegram 人工复核

1. `/config get outbound.liveFeed` → `true`；`/config set outbound.liveFeed false` 后发一条多步任务 → 应回到「最终一条干净回复」（无 `⚙ Working…` 草稿）；再 set `true` → 流式草稿恢复（无需重启）。
2. 删除 Workspace / 删除 Session / 删除 Preset / 中断 Subagent 都应先出现 `✅ Confirm · ✖ Cancel`，点 Cancel 无副作用，点 Confirm 原地显示结果。
3. `/credentialset <REF> <value>` 发送约 0.5s 后，你自己的这条命令消息应从聊天中消失，只留下成功回执。
4. 在另一个面板修改 settings/credentials/插件后，返回 Telegram 打开对应卡片应看到最新数据（无需重启 bot）。

## 17. Round 3：Sessions/History 分页 + goal edit maxRounds + preset copy 自定义（2026-08-16，173/173）

### 改动

1. **Sessions 卡对齐 web 排序 + 翻页**：`listSessionDetails` 按 `lastPromptAt desc` 排序（无 prompt 的会话稳定排在底部）；卡片 10 条/页，`‹ Prev` / `More ›` 由 token 回调翻页，键盘不再一次塞 22 个 id。
2. **History 支持 Load older**：详情 History 每次取 21 条窗口（显示 20 条），有更早事件时出现 `⏪ Load older`，点击按当前窗口最旧 seq 继续回看；新增 `buildHistoryKeyboard` 纯函数。
3. **`/goaledit` 支持 maxGoalRounds**：`/goaledit <objective> [maxRounds]`，解析语义与 `/goalcreate` 一致；新增 `test/goals.test.mjs` 锁 create/edit/pause/clear 的 payload 与降级。
4. **Preset Copy 改为人类顺手流**：详情点 Copy → bot 回复「Reply with the new preset id…」→ 用户回复自定义 id 完成复制并回到 Presets 卡；`/cancel` 可中止；新增 `copyAgentPreset` 适配器测试。

### 验证

- `npm run check`：**173/173 pass**（新增 goals 5 例、session 排序 1 例、sessions/history 键盘 2 例、preset copy 2 例）。
- round 1/2 的 163 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 已同步 session.list/history、agentPreset.copy、goal.edit 状态。

### Telegram 人工复核

1. 建 25+ 个会话（或临时代码填充 live/persisted 会话）→ Sessions 卡第一页 10 条、最新 prompt 在最上，`More ›` 翻页、`‹ Prev` 回退。
2. 打开任一长会话 History → 显示 20 条，点 `⏪ Load older` 继续往前翻，`← Session` 回到详情。
3. `/goaledit 新目标 9` → 目标 objective 与 maxGoalRounds 都更新；`/goalcreate x 5` 行为不变。
4. Presets → 任一 preset → Copy → 回复自定义 id → 收到 `Copied to <id>` 并回到 Presets；回复 `/cancel` → 提示 cancelled 且不复制。

## 18. Round 4：Models/Plugins 分页 + 工具白名单 + adapter 测试补齐（2026-08-16，183/183）

### 改动

1. **Models provider 卡分页**：每页 12 个模型，`‹ Prev` / `More ›` token 回调翻页；`buildModelDetailKeyboard` 支持可选 paging 行（不破坏 Thinking/Providers 行）。
2. **Plugins 卡分页**：每页 20 条插件条目 + 动态包清单；新增通用 `buildPagingKeyboard` 供文本型卡片复用。
3. **agent 工具不能绕过白名单**：`telegram_send` / `telegram_broadcast` 只允许发往 `state.chats`（白名单 roster），非白名单返回 `chat is not in the allowed roster`；broadcast 空目标整体失败。security 测试直接调用注册的 tool definition 验证。
4. **adapter 测试补齐**：
   - `test/host.test.mjs`：listDirectory 排序/降级、createDirectory 成功与重复失败、openPath/pickDirectoryHint/parentOf/isDirectory；
   - `test/commands-jobs-dynamic.test.mjs`：listJobs caller 委托、listCommands hint 投影、executeCommand success/error/unknown、dynamic inventory 降级。

### 验证

- `npm run check`：**183/183 pass**（新增 4 keyboard + 2 security tool + 4 host + 4 commands/jobs/dynamic）。
- round 1–3 的 173 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 llm.models、卡片分页与工具白名单状态。

### Telegram 人工复核

1. 打开含 13+ 个模型的 provider → 第一页 12 个 + `More ›`；翻页后 `‹ Prev` 出现；模型选择与 Thinking 行仍在。
2. 30+ 插件 profile → Plugins 卡显示 `page 1/2`，`More ›` 可翻页。
3. agent 调用 `telegram_send` 发往未授权 chatId → 工具返回 not allowed，不真正发送；白名单 chat 正常发送。
4. `/ls`、`/mkdir`、`/jobs`、`/commands`、Dynamic 卡在无服务 profile 下仍优雅降级。

## 19. Round 5：Host 目录逐级浏览 + Jobs/Search 卡片顺手化（2026-08-16，184/184）

### 改动

1. **Host `Browse cwd` 逐级浏览**：
   - Host 卡按钮由纯文本 `List cwd` 改为 `📂 Browse cwd`（`h:browse`），点击打开目录浏览卡；
   - 目录两列按钮、文件只计数不占按钮、`⬆️ Up`/`🏠 ~`/`🖥️ /` 导航、目录 20/页 `‹ Prev`/`More ›`、`✖ Close` 回 Host 卡；
   - 路径全部走 token 注册表（callback_data 永不超长）；旧客户端残留 `h:ls` 按钮兼容映射到同一浏览器；`/ls` 仍保留文本形式。
2. **Jobs 卡分页**：20 条/页 + `buildPagingKeyboard` 导航。
3. **Search 卡专用键盘**：命中会话按钮 + `🔍 New search`/`← Sessions`，不再套用 Sessions 卡的 New/Stop/Search 按钮；新增 `buildSearchKeyboard` 纯函数与测试。

### 验证

- `npm run check`：**184/184 pass**（新增 buildSearchKeyboard 1 例；host listDirectory/createDirectory 等 4 例此前已覆盖）。
- round 1–4 的 183 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 host.listDirectory 状态与卡片分页清单。

### Telegram 人工复核

1. `☰ Menu` → `Host` → `📂 Browse cwd`：应出现当前项目目录，文件夹两列可点，逐级进入；`⬆️ Up` 回父目录，`🏠 ~`/`🖥 /` 直达，`✖ Close` 回 Host 卡。
2. 无权限目录：卡片显示 `Cannot list this path: …`，Up 仍可逐级回退。
3. 大目录（>20 个子目录）出现 `More ›`/`‹ Prev`；文件只出现在计数里。
4. `/jobs` 超过 20 条时 `More ›` 翻页；`/search <词>` 只出现命中会话按钮与 New search/Sessions。

## 20. Round 6：Skills 按 session 查询 + Search 结果分页（2026-08-16，187/187）

### 改动

1. **Skills 卡对齐 web 契约**：
   - `listSkills(ctx, sessionId?)` 现在传 `{ sessionId }` 选项（无 session 时保持兼容）；
   - 卡片只展示 `userInvocable` 技能，并显示隐藏的 model-only 技能数量；
   - invocation 兼容 `{model,user}` 与 `{modelInvocable,userInvocable}` 两种形状，缺省仍按 true。
2. **Search 结果分页**：
   - `openSearchCard` 一次取 100 条命中，10/页展示，`‹ Prev`/`More ›` token 翻页；
   - `buildSearchKeyboard` 支持 paging 行；`/search`、Sessions 卡 Search 流程共用。
3. **新增 `test/skills.test.mjs`（3 例）**：sessionId 选项透传、两种 invocation 形状、缺失/抛错降级。

### 验证

- `npm run check`：**187/187 pass**（新增 skills 3 例；search keyboard paging 断言并入既有用例）。
- round 1–5 的 184 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 skill.list 与 Search 分页状态。

### Telegram 人工复核

1. 打开 Skills 卡：应只列出 user-invocable 技能；标题含 `N user-invocable`；model-only 技能以隐藏数呈现。
2. `/search` 一个在 10+ 个事件中出现的词 → 第一页 10 条 + `More ›`；翻页后 `‹ Prev` 出现。
3. 无 live session 时打开 Skills 卡：适配器不带 sessionId 调用，仍优雅返回 catalog。

## 21. Round 7：Subagents 对齐 web 目录语义（2026-08-16，190/190）

### 改动

1. **`listSubagents` 投影 web `SubagentListEntry`**：
   - 完整透传 `kind(child|diagnostic)`、`activity(running|inactive)`、`mode(one-shot|continuable)`、`label`、`hasChildren`、`reason(corrupt|unsupported|unavailable)`；
   - legacy provider 省略 `activity` 时回退 live agent status。
2. **Subagents 卡与详情**：
   - 列表每行显示 `kind/activity/mode/children` + label；diagnostic 显示 reason；
   - 详情只有 `continuable` 子代理显示 `📨 Prompt`/`⏹ Interrupt`；one-shot/diagnostic 只读 History；
   - Prompt/Interrupt 回调前再次校验 continuable，防止旧按钮或伪造 payload。
3. **测试**：subagents 新增目录投影与降级 2 例；keyboard 新增详情按钮裁剪 1 例。

### 验证

- `npm run check`：**190/190 pass**（新增 3 例）。
- round 1–6 的 187 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 subagent.list/prompt/interrupt 状态。

### Telegram 人工复核

1. Subagents 卡：continuable 行应含 `mode: continuable` 与 label；diagnostic 行显示 reason。
2. 点 continuable 子代理：有 Prompt/Interrupt/History；点 one-shot/diagnostic：只有 History。
3. 对 one-shot 子代理发送 `/subagentprompt`（若仍有旧按钮）→ 提示 not continuable，不进入回复流程。

## 22. Round 8：非图片媒体明确指引 + downloads 单测（2026-08-16，194/194）

### 改动

1. **document/voice/video 不再被静默忽略**：
   - `TelegramTransport.handleUpdate` 识别 `message.document/voice/video` 并路由到新的 `onDocument` handler（带 kind/fileId/name/mimeType/messageId）；
   - router 按白名单检查：未授权媒体收到 allow 提示，授权媒体进入 index handler；
   - index 回复明确指引：dsh web seam 只有图片附件 API，请改发文本或图片；同时修复未授权 photo/document 被静默忽略的问题（现在都发 allow 提示）。
2. **downloads 单测**：`TELEGRAM_DOCUMENT_LIMIT_BYTES` = 50 MiB；无 `@deepseek-ai/dsh-host-apiproxy` 时 `exportSessionLog` fail-closed 并给出 web 下载指引。
3. **README/README.zh** 平台限制同步更新（图片-only 附件 + 非图片指引）。

### 验证

- `npm run check`：**194/194 pass**（新增 downloads 2 例、transport 媒体路由 1 例、router 媒体白名单 1 例；router 未授权 photo 断言同步加强）。
- round 1–7 的 190 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步媒体处理与 downloads 状态。

### Telegram 人工复核

1. 发送一个文档 → bot 回复「Received document … only attaches images…」。
2. 发送语音/视频 → 同样得到指引，而非无响应。
3. 未授权 chat 发照片或文档 → 收到 `This chat is not allowed yet` + Allow 按钮。
4. 发照片 → 仍按原路径作为 attachment 交给当前会话。

## 23. Round 9：credentials 批量 + Host 版本（2026-08-16，198/198）

### 改动

1. **`/credential` 支持批量（web `refs[]` 语义）**：
   - 新增 `describeCredentials(ctx, refs)`：去重、≤64、POSIX shell 名称校验，逐 ref fan-out 到单 ref host seam，合并输出；
   - `/credential <REF> [REF...]`、Credentials 卡与 /help 文案同步。
2. **Host 卡版本真实化**：`describeHost` 增加可选 `version` 参数，index 传入插件 `version`（0.2.0），不再显示假的 `0.0.1`。
3. **新增 `test/credentials.test.mjs`（3 例）**：单 ref 视图无值、批量去重/上限/校验、set 空值拒绝与 unset 委托；host test 增加版本断言。

### 验证

- `npm run check`：**198/198 pass**（新增 4 例）。
- round 1–8 的 194 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 credentials.describe 与 host.describe 状态。

### Telegram 人工复核

1. `/credential OPENCODE_GO_API_KEY UNKNOWN_REF` → 两行结果：一个 configured/source/writable，一个 not configured。
2. `/credential REF REF` → 去重后只显示一行。
3. `/credential bad-ref!` → POSIX 名称错误提示。
4. Host 卡 version 显示 `0.2.0`（与 package.json 一致）。

## 24. Round 10：session.attachment 读回 + Host 默认模型（2026-08-16，201/201）

### 改动

1. **图片附件读回闭环（web `session.attachment`）**：
   - `saveImageAttachment` 记录本 bridge 保存的 durable ref（上限 500 逐出最旧）；
   - `readImageAttachment` 用真实 ref 调 `ctx.attachments.readImage`（web 会校验 bytes 与 ref 完全一致，旧实现伪造 ref 永远读不回）；
   - 新增 `/attachment <attachmentId>`：读回 base64 → `TelegramTransport.sendPhoto` 发回聊天；发图成功回执现在附上 attachment id 与 `/attachment <id>` 提示；teardown 清空内存 ref 注册表。
2. **Host 默认模型对齐 web seam**：`describeHost` 优先 `agentDefaultModel.currentSelection()`（web host.describe 与 session.create fallback 的同一来源），无该服务时回退第一个 live agent。
3. **测试**：sessions 附件真实 ref 读回 1 例、transport sendPhoto 1 例、host 默认模型优先 1 例。

### 验证

- `npm run check`：**201/201 pass**（新增 3 例）。
- ESM smoke import：`dist/index.js`、`dist/extensions/openclaw.js`、`dist/extensions/reasoning.js` 三个入口均可直接 `import()`。
- round 1–9 的 198 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 session.attachment 与 host.describe 状态。

### Telegram 人工复核

1. 发一张图 → 回执含 `Attachment <id>` 与 `/attachment <id>`；执行该命令应把同一张图发回。
2. `/attachment unknown` → 提示「was not saved by this bridge」。
3. Host 卡 provider/model 应与 profile 的 `agent-default-model` 一致，而不是某个已打开会话的模型。

## 25. Round 11：v0.3.0 release candidate（2026-08-16，202/202）

### 改动

1. **版本与发布物**：
   - `package.json` / `package-lock.json` 版本 0.2.0 → **0.3.0**；
   - 新增 `CHANGELOG.md`（0.2.0 基线 + 0.3.0 全部 hardening/UX 条目），并加入 npm `files`。
2. **agentPreset.list 对齐 web 最后缺项**：透传 `hasDocument`（deployment fact），Presets 卡显示 `document: yes/no`。
3. **回归**：`npm run check` 202/202；ESM 三入口 smoke import；`npm pack --dry-run` 应包含 CHANGELOG。

### 验证

- `npm run check`：**202/202 pass**（新增 presets list facts 1 例）。
- round 1–10 的 201 个用例全部保持绿色。
- `docs/WEB_PARITY_AUDIT.md` 同步 agentPreset.list 状态。

### 上线前人工 checklist（请在 Telegram 实机执行并回填 ✅/❌）

1. `/start` → allow 流程 → bar 出现；`/menucheck` 18 项全 ✅。
2. 发一句话 → 原生引用回复 + 👍/👎/📋；点反馈、删除反馈闭环。
3. 两个白名单 chat 并发互不串话；快速连发首条只建一个 session。
4. Models 翻页选择模型；Reasoning 五档热切；`/config get|set outbound.liveFeed false|true` 热生效。
5. Sessions 排序/翻页、History Load older、Search 分页。
6. Host Browse cwd 逐级浏览、Up/~//、无权限错误卡可回退。
7. Workspace/Session/Preset/Subagent 危险操作确认；Preset copy 自定义 id。
8. 发图片 → 附件入站 → `/attachment <id>` 读回同一张图；发文档 → 明确指引。
9. `/credential A B`、`/credentialset` 原消息自删；Host 卡 version=0.3.0。
10. `/telegram stop && /telegram start` 无 409；卸载/热重载无残留 typing/panel。

## 26. Round 12：Host 浏览卡 New folder（2026-08-16，203/203）

### 改动

1. **`host.createDirectory` 按钮流**：Host 浏览卡新增 `📁 New folder`，点击后回复目录名（校验单段、拒绝 `/`/`\`），在当前浏览路径创建并原地重开浏览器；`/cancel` 可中止；`/mkdir <path>` 保留为完整路径快速通道。
2. `buildProjectKeyboard` 增加可选 `newFolder` 动作（纯函数 + 单测）。
3. 审计同步：agentPreset.remove 确认卡此前已实现，状态修正为 ✅。

### 验证

- `npm run check`：**203/203 pass**（新增 project keyboard newFolder 1 例）。
- round 1–11 的 202 个用例全部保持绿色。

### Telegram 人工复核

1. Host → Browse cwd → `📁 New folder` → 回复 `my-dir` → 回执 Created + 浏览器原地刷新并出现 `my-dir`。
2. 回复 `a/b` → 提示 must be a single path segment，浏览器回到原路径。
3. `/cancel` → New-folder cancelled，不创建目录。

## 27. Round 13：Models routable + per-session thinking（2026-08-16，206/206）

### 改动

1. **`session.models.routable`**：`modelCatalog` 返回 `routable`（当前 provider 是否被 llm registry serve；无 llm 时按 web 语义为 true）；Models 卡显示 `routable: yes/no`；新增 `test/llm.test.mjs` 3 例（groups/failures/routable、降级、discover 不泄 apiKey）。
2. **per-session reasoningEffort 五档**：
   - provider 卡当前模型下方出现 `🧠 Thinking · <当前档>`；
   - 点击打开五档 picker（复用 `buildThinkingKeyboard`），选中后 `selectSessionModel(..., effort)` 并回到 provider 卡；
   - 无 agent/非法 effort 安全回退。
3. **审计修正**：settings.describe 的 web 契约本就是列出全部 namespace，修正表格描述。

### 验证

- `npm run check`：**206/206 pass**（新增 llm 3 例；既有 thinking keyboard 回归）。
- round 1–12 的 203 个用例全部保持绿色。

### Telegram 人工复核

1. Models 卡标题含 `routable: yes/no`；无 llm registry 时显示 yes 且卡片优雅降级。
2. 当前 provider 卡选中模型后出现 `🧠 Thinking · Medium`；点开选 High → 回执 Model switched（含 reasoning）并回到 provider 卡。
3. 再次打开 Thinking 行应显示 High。

## 28. Round 14：Settings schema envelope（2026-08-16，207/207）

### 改动

1. `SettingsNamespaceView` / `describeSettings` 透传 provider 返回的 `schema`（serialized schemastery envelope）；
2. Settings namespace 卡显示 `schema: <json>`（截断 300 字符），无 schema 时显示 `(not declared)`；
3. 新增 settings schema 单测 1 例。

### 验证

- `npm run check`：**207/207 pass**。
- round 1–13 的 206 个用例全部保持绿色。

### Telegram 人工复核

1. Host settings → 点任一 namespace → 应看到 `schema: …` 与 value/user/secrets。
2. 未声明 schema 的 provider → 显示 `schema: (not declared)` 且不报错。

## 29. Round 15：settings 命令支持 expectedRevision（2026-08-16，208/208）

### 改动

1. 新增纯函数 `parseJsonWithRevision`：先整串解析 JSON，失败再从尾部向前找 `\s+<int>` 后缀，保证 JSON 字符串内部空白不被破坏；
2. `/settingsupdate`、`/settingsreplace`、`/settingsmutate` 语法升级为 `... [expectedRevision]`，透传给 web seam；
3. 新增 parser 单测 1 例。

### 验证

- `npm run check`：**208/208 pass**。
- round 1–14 的 207 个用例全部保持绿色。

### Telegram 人工复核

1. `/settingsupdate llm {"a":1} 3` → 以 expectedRevision=3 调用；
2. `/settingsreplace llm {"a":2} 4`、`/settingsmutate llm [{"op":"set","path":["a"],"value":1}] 5` 同样带 revision；
3. JSON 字符串内多空格：`/settingsupdate llm {"note":"x  y"}` 仍原样解析。

## 30. Round 16：Subagents 时区/信号与 activity 语义修正（2026-08-16，208/208）

### 改动

1. **subagent.activity 修正**：web api-proxy 会把 child 行的 activity 重映射为 **live agent status**（`running` iff `ctx.agents.get(id).status === "running"`），此前我们误透传持久化快照；现在与 web 完全一致。
2. **subagent.prompt 补 provenance**：自动附带 `clientTimeZone`（`Intl` 当前时区）与 `AbortSignal`，符合 web `SubagentAddress`/`MessageSource` 契约。
3. 测试断言同步更新（activity 重映射、source.clientTimeZone、signal）。

### 验证

- `npm run check`：**208/208 pass**（subagents 断言加强，无回归）。
- round 1–15 的 208 个用例全部保持绿色（本轮无新增用例）。

### Telegram 人工复核

1. Subagents 卡 activity 应反映 live agent status（running/idle），而不是持久化快照。
2. continuable 子代理 Prompt 后，宿主侧消息 source 应含 `clientTimeZone` 与 signal（dsh 侧日志/事件可确认）。

## 31. Round 17：Release gate（2026-08-16，208/208）

### 发布物检查（全部通过）

- `npm run check`：208/208；
- `npm pack --dry-run`：119 files，dsh-telegram-0.3.0.tgz；
- `npm publish --dry-run`：publishing to registry with public access **dry-run OK**（真实发布需登录凭据）；
- ESM smoke：index/openclaw/reasoning 三入口；
- `git diff --check`：clean；
- tag：`v0.3.0-rc.1`（本地 release-candidate 标记，真实 publish/tag push 待实机验收后执行）。

### 结论

自动化侧达到上线门槛；真实发布前仍待 Telegram 实机执行 §25 checklist（当前环境无 bot token 与 dsh CLI）。

## 32. Round 18：独立审计修复 + 实机冒烟（2026-08-16，211/211）

### 独立审计发现并修复

1. **telegram_reply 失败被吞**：`sendOutbound` 原来在入队前就标记 replied；发送失败时 turn/end 错误路径与提醒都被抑制。现改为确认 `message_id` 后才标记（新增回归测试）。
2. **telegram_reply/mark_no_reply 无 agent 上下文时回退「最近触碰」chat**：可能把 A 的消息回进 B。现改为直接失败，禁止跨 chat fallback。
3. **stop/start 竞态**：stop 在 start 等待旧 poll 世代期间到达时，start 仍会开新世代。新增 `stopGeneration` 世代令牌，旧 start 检测到新 stop 即退出（新增竞态回归测试）。
4. **长文本拆分重复引用/键盘**：`sendText` 拆分后第 2..N 段仍带 `reply_parameters`/`reply_markup`。现仅第一段携带（新增测试）。
5. **面板刷新异常逃逸进 cordis 事件监听器**：Bridge 统一 `notifyStateChange` try/catch。
6. **teardown 遗留 bar carrier**：卸载时 fire-and-forget 删除旧载体消息。
7. **被替换 session 的 ModelSelectionRef 泄漏**：`createSessionForChat` 替换旧会话时释放其 model selection。
8. `npm audit --omit=dev`：0 vulnerabilities。

### 实机冒烟（真实 bot 与真实 token，隔离 DSH_HOME）

- 安装 `@deepseek-ai/dsh@0.1.0-rc.6` 到 `/tmp/dsh-cli`（不污染项目/系统 profile）；
- 临时 `DSH_HOME=/tmp/dsh-live-home-6Qqb`（复制 web profile + symlink 本仓库）；
- `--dump-config` 确认 `dsh-telegram`、`telegram-reasoning`、`telegram-openclaw` 三插件挂载，`agent-default-model → opencode-go/deepseek-v4-pro`；
- 真实启动：`dsh web: http://127.0.0.1:49439` + `[dsh-telegram] long polling started` + `[dsh-telegram] openclaw streaming feed mounted`；
- Bot API `getMe`：`@XosEvolvesbot`（id 8739701145）；
- 白名单 chat 8753447694 的 bar sync 实测：`bar sync chatId=8753447694 count=0 last=-1`，bot 已向该 chat 投递带计数的新 bar。

### 结论

自动化与真实长轮询冒烟均通过；剩余完整 §25 交互 checklist 仍需在 Telegram 客户端人工点按后回填。

## 33. Round 19：实机上线清单已下发（2026-08-19 环境时间轴）

### 运行实例

- 临时 `DSH_HOME=/tmp/dsh-live-home-6Qqb`（web profile 副本 + 本仓库 symlink）；
- `dsh web: http://127.0.0.1:49523`；`long polling started`；`openclaw streaming feed mounted`；
- 白名单 chat `8753447694` 再次收到 bar 载体（`bar sync ... count=0 last=-1`）；
- 已通过 Bot API 向该 chat 发送 §25 10 步 checklist（message_id 1271），等待用户在 Telegram 客户端逐项点验。

### 状态

- 自动化：211/211；npm audit 0；pack 119 files。
- 实机进程保持运行，供用户点按验收。
- 收到用户反馈后：按现象修复 → 回归 → 通过则推 `v0.3.0-rc.1` tag 与正式发布。

## 34. Round 20：实机 state-change 递归修复 + 213/213（2026-08-19）

### 实机发现的 bug

- 实机 `--patch` 派发 `/telegram status` 后，日志连续出现 7+ 条
  `[dsh-telegram] state change handler failed [object Error]`。
- 根因：此前一次全量改名把 `notifyStateChange()` 方法体内的 `this.onStateChange()`
  误替换成了 `this.notifyStateChange()`，形成自递归；每次 turn 事件触发面板刷新都
  递归到栈溢出（RangeError），且错误对象只按 `[object Error]` 记录，无任何线索。
- 修复：改回调用 `this.onStateChange()`；日志改为输出 `err.message + err.stack`
  （非 Error 对象用 `String(err)`）。

### 回归测试（新增 2 个，共 213/213）

1. `state-change notifications call the callback exactly once (no self-recursion)`：
   `bindAgent` 两次状态变更必须恰好回调 2 次，自递归会被计数/栈溢出立即抓出。
2. `a throwing state-change callback is contained and logged with its stack`：
   面板刷新抛错只记录 1 条，且日志含 `panel boom` 与堆栈位置。

### 实机复验（真实 bot，新实例）

- 重启隔离实例：`dsh web: http://127.0.0.1:49733` + `long polling started` +
  `openclaw streaming feed mounted` + `bar sync chatId=8753447694 count=0 last=-1`。
- 通过 HTTP `session.prompt`（`mode: queue`）向持久会话派发两次 `/telegram status`：
  turn 1/2 均完成，`bar sync ... count=0 last=0`，**无任何 state change handler failed**。
- 进一步尝试打通完整轮次：把主 profile 的 `.credentials.yaml`（600 权限）复制进隔离
  `DSH_HOME` 后重启（`dsh web: http://127.0.0.1:49803`），`credentials.describe` 确认
  `DEEPSEEK_API_KEY`/`OPENCODE_GO_API_KEY` 均为 `configured: true`。
- 再派发 `/telegram status`：`MISSING_CREDENTIAL` 消除，但 deepseek-official 返回
  `Authentication Fails, Your api key: ****2dbe is invalid`（401 AUTH）。即主 profile
  中已存的 deepseek key 本身已失效；live profile 仅路由 deepseek-official。
- **待用户**：在 live web（49803）或主 profile 更新为有效的 `DEEPSEEK_API_KEY`，再在
  Telegram chat 发一条消息跑完整轮次。
- `npm run check`：213/213；`npm audit --omit=dev` 0。

### 状态

- 修复已提交 `ed94dee`，tag `v0.3.0-rc.1` 已重建；实机进程 `bash-32` 保持运行。
- 发布门：等待用户更新有效凭据 + 在 Telegram 客户端完成 §25 清单与一条完整 agent 轮次。

## 35. Round 21：独立发布审计 + 修复（2026-08-19，222/222）

### 独立审计结论

- `npm run check` 213/213（审计时）→ 本轮修复后 **222/222**；
- `npm audit --omit=dev --registry=https://registry.npmjs.org`：0 漏洞；
- `npm pack --dry-run`：119 files / dsh-telegram-0.3.0.tgz；
- 审计提出 3 个 release blocker 与 10 个非阻塞风险。

### 本轮修复（均加回归测试）

1. **版本导出漂移**：`src/index.ts` 仍导出 `0.2.0`（package.json 已是 0.3.0）。
   改为 `0.3.0`，新增「导出版本 === package.json」锁测试；Host 卡/`/start`/`/about` 恢复正确版本。
2. **HTML 长消息拆分损坏标签**：`splitText` 原来按字符硬切，`<b>` 被切一半 → Telegram 400。
   重写为 HTML-aware：不在 `<tag>`/`&entity;` 内切分；跨切分的开标签在第一段补闭合、第二段重开，每段独立可解析。
3. **SendQueue 对一切错误重试**：原实现对 400 等永久错误也重试 `attempts` 次后静默吞掉。
   现在只重试 429、5xx、网络 TypeError、API 超时；400/403/Abort 等只尝试 1 次。
4. **`mo:`/`set:` 回调未编码**：provider/namespace 含 `%` 时 `decodeURIComponent` 抛 URIError、按钮假死。
   构建侧 `encodedCallback`（64 字节内按原始值截断再编码），分发侧 `decodeCallbackValue` 安全降级。
5. **`telegram_send/reply/broadcast` 的 HTML 契约漏洞**：schema 声明支持 MarkdownV2，实现却既不转义也不传 parse_mode，未传参时 HTML 会以纯文本显示。
   移除误导参数并固定 `parse_mode: "HTML"`，与 body 描述一致。
6. **typing 循环泄漏**：`turn/end` 丢失时 `setInterval` 会永远发 typing。
   增加 10 分钟自毁上限；新一轮会替换旧循环。

### 实机复验（真实 bot，opencode-go 全链路）

- 用主 profile 的 `OPENCODE_GO_API_KEY` + live `settings.update` 激活 `llm-pi-ai/providers.opencode-go` 路由
  （live 实例的 settings/credentials 均只落在隔离 `DSH_HOME`）。
- `session.selectModel → opencode-go/deepseek-v4-flash` 后，`/telegram status` 完成真实 LLM 轮次：
  reasoning → tool 调用 → 文本块 → usage → `turn/end reason=completed`（seq 313）。
- 修复版重启后的 live 实例：`dsh web: http://127.0.0.1:50755`，long polling + openclaw + bar sync 正常，日志无异常。
- 你贴的 `DEEPSEEK_API_KEY` 已写入 live 凭据服务验证：该 key 有效但余额不足（402 QUOTA）；
  opencode-go 路由不受影响，当前完整轮次跑在 `OPENCODE_GO_API_KEY` 上。

### 仍待人工

- 在 Telegram chat 发一条消息触发真实入站 → openclaw 流 → `telegram_reply` 最终交付（HTTP 会话不绑定 chat，只能证明 LLM/工具链路）。
- 完成后执行 §25 checklist 剩余项与发布动作。

## 36. Round 22：多聊天隔离与卡片交互收尾（2026-08-19，223/223）

### 本轮修复

1. **未绑定 chat 的展示串台**：`boundAgentId(chatId)` 原来会回退到「最近触碰」agent，未绑定会话的 chat 打开 Menu/Queue/Status 会看到另一个 chat 的模型、队列和状态。
   - chat 作用域解析现在 fail-closed；`statusSnapshot` 增加 `fallbackToFirst`（默认 true 保全局视图），chat 卡片调用传 `false`。
   - 新增 `statusSnapshot fails closed for an unbound chat` 回归测试。
2. **approval/question 结算不原地改卡**：结算时发新消息，原卡片按钮仍是活的，再点只会得到「already settled」。
   - approval/question 的 settle/cancel 现在**编辑原卡片**并清空 inline keyboard（`{inline_keyboard: []}`，不影响持久命令栏），只有卡片从未送达时才回退广播。
   - 更新 3 个 interactive 测试断言 settle 是 `edit` 而非新消息、且只发到 session 所属 chat。

### 验证

- `npm run check`：**223/223 pass**（本轮 +1，累计新增 10 个回归）。
- 实机进程仍为 web 50755，等待 Telegram chat 真实入站消息（上轮已发提醒 message_id 1277）。

## 37. Round 23：按钮一次性执行 + 密钥命令确定性删除（2026-08-19，226/226）

### 本轮修复

1. **回调 token 可重复执行**：token 注册表只在重启后失效，同一按钮重复点击会再次执行
   （例如 Delete→Confirm 被点两次）。抽出独立 `TokenRegistry`（`src/telegram/tokens.ts`）：
   - `take()` 单次消费，二次点击返回「该按钮已执行」而不是再次执行或误报重启；
   - live/used 两个账本都有界（live ≤1000，used ≤4000 并裁剪），`reset()` 清理；
   - 新增 3 个单测：单次消费、LRU 淘汰、reset。
2. **`/credentialset` 密钥消息删除竞态**：原 500ms `setTimeout` 删除不受队列/重启约束。
   改为在处理命令时立即把 `deleteMessage` 排进同一 per-chat 队列，再排后续回执——
   Telegram FIFO 保证密钥先被删除，且重启不会中断。

### 验证

- `npm run check`：**226/226 pass**（+3）。
- 实机进程仍为 web 51052；Telegram 真实入站仍待用户回复。

## 38. Round 23 追加：实机发现「两条首消息建两个会话」并修复（227/227）

### 实机复现

- 用户在真实 Telegram 发送 ping 后，`session.list` 出现两个 `telegram-*` 会话，
  各自带同一条 ping 并各自完成 turn（seq 70 / seq 89）。
- 根因：`onUserText` 的首消息路径是 **fire-and-forget async IIFE**。per-chat FIFO
  router 认为 handler 已结束，第二条消息在第一个 `sessionLifecycle.create` 尚未
  完成时就进入同一分支，再次创建会话。router 的串行化形同虚设。
- 修复：`onUserText` 改为 async 并 **await 整个 create → bind → deliver** 链路；
  FIFO 现在真正覆盖会话创建窗口。

### 回归测试

- 新增 `test/apply-race.test.mjs`：假 agents.create 延迟 30ms，同一 chat 同时投递
  两条首消息；断言 `create` 只调用 1 次、live agent 只有 1 个、chat 绑定正确。
  修复前该测试稳定失败（create 2 次），修复后通过。
- `npm run check`：**227/227 pass**。

### 实机状态

- 当前 live 实例中由该 bug 产生的两个会话为历史数据；重启新版后 chat 会重新绑定
  新会话（旧会话保留在 sessions 列表，不影响运行）。

## 39. Round 24：/start 白名单后的自然落地（2026-08-19，227/227）

### 修复

- 审计遗留 UX：新 chat 第一次发 `/start` 未授权时只收到 allow 提示，点 Allow 后
  还必须**重新发一次** `/start` 才能看到欢迎语，不符合 Telegram 用户预期。
- `RouterDeps.onUnauthorized` 增加 `reason`；router 把 `command:start` 传给宿主，
  宿主记录 `pendingStartAfterAllow`。`m:allowthis` 放行后自动重放 `/start`：
  注册命令菜单 + 发送欢迎语 + 持久命令栏。
- 普通未授权文本行为不变；`pendingStartAfterAllow` 在 teardown 清空。

### 测试

- router 测试锁定未授权 `/start` 传递 `command:start`、普通文本不带 reason；
- security 集成测试锁定：未授权 `/start` 不入白名单 → 点 Allow → 白名单加入且
  sent 流里出现包含 `ready` 的欢迎语。
- `npm run check`：**227/227 pass**。

## 40. Round 25：真实 Telegram 实机验收证据（2026-08-19，227/227）

### 用户实机操作回放（live web 51501 日志 + session.history）

- `☰ Menu` bar 按钮 → Menu 卡（P1/P2）正常；
- `ping` → 真实 LLM turn（opencode-go）`turn/end completed`，回复 pong；
- **快速连发 `1`、`2`** → 只创建 **1 个** `telegram-182277cb…` 会话；`2` 进入同一会话的
  next-turn inbox（`agent/inbox/spliced` 同 session），未再触发 `session create` ——
  Round 23 竞态修复在真实 Bot API 上通过；
- `123`、`1`、`2` 连续入站 → 同一会话 inbox 排队（start 0/1/2），bar `Queue · 3` 实时更新；
- Models bar → 两个 provider 按钮 → `mo:opencode-go` provider 卡 → back/close 正常；
- Queue 卡 → 删除/编辑队列项、`/cancel` 中止编辑 → bar 计数回落，均无异常；
- approval 卡（`ap:1`）→ Reject 回调被正确应答并结算（真实回调闭环）。

### 实机 menucheck（HTTP 会话等价探测）

- 18 项数据源：14 ✅ · 3 ⚠️（history/credentials/capabilities 在本侧无对应工具，非故障）· 0 ❌。
- 真实 `/telegram menucheck` 需用户在 Telegram 直接发送（当前 live web profile 的
  ask_user_question 由 web UI 持有，这是设计行为，不是 bridge bug）。

### 结论

- 真实 Telegram → LLM 轮次、快速首消息单会话、bar/Menu/Models/Queue/approval 回调
  全部有实机证据；自动化 227/227、audit 0、pack/publish dry-run 通过。
- 发布门满足：进入 push tag + GitHub Release / npm publish 收尾。

## 41. Round 25：发布动作（2026-08-19）

- `git push origin main --tags`：main `831bc75` 与 tag `v0.3.0-rc.1` 已推送到
  `https://github.com/xqicxx/dsh-telegram`。
- GitHub Release（pre-release）已创建并附带 `dsh-telegram-0.3.0.tgz`：
  https://github.com/xqicxx/dsh-telegram/releases/tag/v0.3.0-rc.1
- `npm publish --dry-run` 通过；真实 npm publish 需要机器上的 npm 登录
  （`npm whoami` → need auth）。用户已明确选择「暂不发布 npm」，以 GitHub
  pre-release v0.3.0-rc.1（含 tgz）作为当前交付物。

## 42. Round 25 追加：按用户实机反馈的 UX 修正（2026-08-19，228/228）

### 用户反馈与修复

1. **Menu 里的 Workspaces 点不开** — 根因：workspace registry 条目可能缺 `sessionIds` /
   `archivedSessionIds` 可选字段，`listWorkspaces` 展开时抛错，卡片被 dispatch 的 catch 吞掉。
   - adapter 对缺失字段做空数组降级；
   - `openWorkspacesCard` 增加 try/catch，即使 registry 抛错也展示可读错误卡与 Create/Back。
2. **进入 Project 后回不了 Menu** — Project 卡只有 `✖ Close`。新增独立 `☰ Menu` 按钮（`m:back`），
   Up/Home/Root 与目录浏览保持不变。
3. **Queue 条目标识混乱** — 卡片文本原来是 `turn [f64f7aa1]`，按钮也是 hash 前 8 位。
   - 列表改为 `#1 · turn · <文本预览 60 字>`；
   - 按钮改为 `✏ #1` / `🗑 #1` / `⚡ #1`；
   - 编辑提示与完成回执也带 `#N`（`pendingQueueEdit.label`）。
4. **Sessions 的 Search 完全没必要** — Sessions 卡移除 Search 按钮；`/search` 不再注册到
   Telegram 命令菜单与 `/help`，README 命令列表同步移除（旧卡片的 search 回调仍兼容）。

### 测试

- keyboard 单测更新：queue 编号按钮、Sessions 无 Search、Project 有 Menu 返回。
- workspace 单测新增：registry 条目缺可选字段不抛错。
- `npm run check`：**228/228 pass**。

### 追加：关闭消息反馈

- 用户反馈「消息的反馈也没必要打开」：`onAssistantDelivered` 不再挂 `attachFeedbackKeyboard`；
  `ExtensionHost.attachFeedback` 保留为空实现（openclaw 等扩展调用无害）。
- README/CHANGELOG 已同步：最终回复保持干净，不附 👍/👎/📋 按钮；web feedback 适配器与
  旧按钮的兼容分发保留，但不再产生任何新反馈入口。

## 43. Round 25 追加：Workspace/Preset/Status 与 web 对齐（2026-08-19，228/228）

### 用户反馈与修复

1. **Workspaces 仍打不开** — 在上一轮空字段降级基础上，把整张 Workspace 卡的渲染
   （list → view 映射 → keyboard 构建 → openCard）放进防死卡路径；`view()` 对
   `sessionIds` 缺失降级为空数组，registry 异常也会渲染出可读错误卡而不是静默失败。
2. **Presets 没有随 web 更新** — 现在 `openCard` 支持可选的 `refresh` 回调：
   Presets / Workspaces / Sessions 卡打开时注册自己的重渲染器；`settings/document-updated`、
   `commands/change`、`cordis/dynamic-package`、`domain/changed` 等 web 侧事件触发时，
   打开的卡片原地重新读取数据源（`m:close` 时注销），web 装插件/改 preset 后卡片会跟着变。
3. **Status 缺 web 顶栏信息** — `renderStatus` 增加：
   - `Router: router-<preset>`（例如 `router-standard`）；
   - `Subagents: N`（后台异步刷新 `subagents.listChildren` 计数，事件共享同一刷新 Promise）；
   - `Background jobs running: N`（`jobs.list` 中 `status === "running"`）。
   `refreshAllPanels` 先刷新 subagent 计数再原位更新 Status 卡，避免慢一拍。

### 验证

- `npm run check`：**228/228 pass**（workspace 缺字段防抖等既有回归保持绿色）。

## 44. Round 1（交互逻辑迭代）：Telegram 原生交互收口（2026-08-19，229/229）

### 调研结论（core.telegram.org/bots/api）

- 回调必须尽快 `answerCallbackQuery`（已在 transport 层最先应答）。
- `editMessageText`/`editMessageReplyMarkup` 只应改卡片本身；不要为「编辑一条已排队消息」
  做二次文本编辑，手机端改文字远不如删除重发。
- `ForceReply`（`reply_markup: {force_reply, input_field_placeholder}`）会自动拉起回复输入框，
  是官方推荐的 step-by-step 输入方式；`setChatMenuButton(commands)` 提供输入框旁的官方菜单按钮。

### 修复

1. **交互处理不再 fire-and-forget**：`onCommand`/`onBarButton`/`onCallback`/`onPhoto`
   原来把 dispatch Promise `void` 掉，router 的 per-chat FIFO 实际上没有覆盖这些路径，
   快速连续点按会并发执行（实机测试正是因此出现回调竞态）。
   现在返回 Promise，命令/按钮/回调真正按 chat 串行；新增/调整 apply 集成测试覆盖。
2. **Queue 编辑改为「删除 + 重发」**：
   - 移除 `✏ 编辑` 按钮与 `pendingQueueEdit` 流程（`/queueedit` 不再出现在帮助/README）；
   - 每项显示 `#N · turn/step · <文本预览>`，按钮为 `🗑 Delete #N · turn` 与
     `⚡ Run #N now`（仅 next-turn）；
   - 删除后立即发送 `ForceReply` 提示「发送更正后的消息即可重新入队」。
3. **输入提示全面 ForceReply**：新建文件夹、subagent prompt、preset copy、rename、
   steer、search 等回复式输入都用 `inputPromptKeyboard(placeholder)`，Telegram 自动拉起回复框。
4. **官方菜单按钮**：`/start` 时调用 `setChatMenuButton(chat_id, MenuButtonCommands)`，
   输入框旁出现官方 ☰ 命令菜单，不依赖常驻键盘栏。

### 测试

- `npm run check`：**229/229 pass**（新增 ForceReply helper 测试、更新 Queue 按钮测试）。

## 45. Round 2（交互逻辑迭代）：菜单导航收口（2026-08-19，229/229）

### 修复

1. **移除菜单里假死的 `1/2` 页数按钮**：`buildMenuPage` 不再生成 `m:page` 无动作按钮，
   页码信息保留在卡片头部，底部只剩真正可点的 Prev/More/Close。
2. **Back 回到上次所在页**：`m:back` 之前固定回第 0 页；现在返回 `menuPageIndex` 记录页。
   从第 2 页进入任一卡片后点 Back，会回到第 2 页而不是跳回第 1 页。
3. 上轮已修：command/bar/callback/photo dispatch 真正 await（per-chat FIFO）。

### 测试

- 更新 `keyboard.test.mjs` 与 `menu.test.mjs`：断言没有页数假按钮、导航按钮组合正确。
- `npm run check`：**229/229 pass**。

## 46. Round 2 追加：HTML 转义批量修复 + Workspace 空态提示（2026-08-19，229/229）

### 实机发现

用户连续点多个菜单卡，日志暴露一类系统性 bug：**多处卡片/直接 sendText 使用 `parse_mode: HTML`
但命令占位符直接写 `<REF>` `<name>` `<path>` 等，Telegram 把它当 HTML 标签拒绝（400）**。
涉及 Host settings、Credentials、Plugins、Mode、Goal、Host、Workspace 等卡片。

### 修复

- 把所有 HTML 卡片中的命令占位符改为 `&lt;...&gt;`（例如 `&lt;REF&gt;`、`&lt;name&gt;`、`&lt;path&gt;`）；
- `send()` 路径本来就用 `plain()` 转义，不受影响；本次修复 `openCard`/直接 `sendText(..., parse_mode: "HTML")` 的裸尖括号。
- Workspaces 空列表时增加「Current project」提示，并说明如何注册/用 Project 登记，避免看起来像点不开。

### 验证

- `npm run check`：**229/229 pass**。

## 47. Round 2 追加：Plugins/Jobs 返回按钮修复（2026-08-19，229/229）

- `openPluginsCard` 与 `openJobsCard` 的 `buildPagingKeyboard(back: "m:plugins"/"m:jobs")` 会让
  「← Back」重新打开当前卡片，看起来像点了没反应。改为 `m:back`（回到上次菜单页）。

## 48. Round 2 追加：Watch 开关可见反馈（2026-08-19，229/229）

- `m:watchtoggle` 现在会在停止/恢复轮询时发送一条明确提示（“Polling resumed.” / “Polling stopped — tap Watch → Start…”），避免用户以为 bot 坏了。

## 49. Round 2 追加：Workspace Create 交互流程（2026-08-19，229/229）

- `w:create` 之前只发送一行用法说明，用户无法真正创建。
- 改为 `pendingWorkspaceCreate` + ForceReply：点 Create 后自动拉起回复框，输入
  `/path/to/project [Title]` 即调用 `createWorkspace` 并刷新 Workspaces 卡；`/cancel` 可中止。

## 50. Round 2 追加：Session 自定义名称显示（2026-08-19，229/229）

- Telegram Sessions 卡之前按钮/列表主标签显示 session id（“编码”），即使 harness 有自定义标题。
- `buildSessionsKeyboard` 改为接收 `{id,title}`，有标题时按钮显示标题 + 短 id；
- Sessions 卡文本与详情卡同样以自定义标题为主，id 降为辅助信息。

## 51. Round 2 追加：Session 删除真正生效（2026-08-19，230/230）

### 实机发现

用户删除 session 后，`session.list` 里该会话依然存在——`deleteSession` 用
`encodeSegment(id)`（`--~id--`）去找目录，但实际后端落盘的是**原始 id** 目录名，
所以永远删不到文件。

### 修复

- `deleteSession` 现在同时尝试 `encodeSegment(id)` 与原始 id 两种目录名，删到哪个删哪个；
- Archive 后返回 Session 详情卡，让 archived 状态立即可见；
- 新增删除目录双形态回归测试（raw + wrapped），`npm run check` **230/230 pass**。

## 52. Round 2 追加：Session 标题读取 + Workspace 目录选择器（2026-08-19，230/230）

### 修复

1. **Session 自定义标题显示**：`titleFor` 现在优先扫描 `session/title` 事件（web 的
   `foldSessionTitle` 同源），冷会话也保留名称；服务不可用时回退首条用户消息
   （§54 起改为 web 三级回退：标题 → cwd 基名 → id）。
2. **Workspace Create 目录选择器**：`w:create` 不再要求输入抽象路径，改为
   Project 式浏览（Up/Home/Root/翻页），选中目录点 `✅ Create here` 即注册。
   `/workspacecreate <path>` 命令保留为高级路径。

## 53. Round 2 追加：状态计数、日志导出、轨迹（2026-08-19，230/230）

### 修复

1. **后台任务计数**：`listJobs` 用 `SessionId(agentId)` 包装再查 live agent（之前裸字符串
   导致 `agents.get` 拿不到 caller、`jobs.list(undefined)` 返回空，Status 上运行任务恒为 0）。
2. **Session 日志导出**：`loadExportSeam` 之前只从插件自身 node_modules 解析
   `@deepseek-ai/dsh-host-apiproxy`，而它是 profile 依赖，导致 Telegram 里 Log 永远提示
   “profile cannot build archive”。现在从 workspace cwd / DSH_HOME / 每个 profile 目录多根解析。
3. **轨迹（History）**：`snippetOf` 补充 `tool/call` 渲染（`🛠 工具名 + 参数`），
   之前 tool call 行空白；History 卡现在能看到完整轨迹（用户/助手/工具调用/结果）。

### 状态计数说明

- `Subagents: N` 与 `Background jobs running: N` 显示在 Status 卡与第 0 页 Menu 头部；
  按当前 bound 会话统计（与 web 顶栏同一会话口径）。

## 54. Sessions 卡按项目分组 + 运行项目优先（2026-08-16，236/236）

### 需求与 web 对齐结论

- 会话名直接同步 web 已写入日志的标题：`session/title` 最新事件 → cwd 基名 → id，
  不再用首条用户消息兜底。
- 会话按工作区项目分类；`/sessions` 默认打开运行中项目的会话页，`🔀 项目` 可切换，
  保留 `🌐 全部会话` 平铺视图。
- 项目内运行中的会话排最前；项目切换器按“bound 且运行 → 运行中 → bound → 最近活跃”排序。

### 修复

1. `listSessionDetails`：`running` 改为 `agent.status === 'running'`（原实现把挂载即当运行）；
   冷会话从 persistence header 透传 `cwd`（此前冷会话永远进不了项目分类）。
2. `titleFor`：删除首条用户消息兜底，新增 `displayTitleFor(title, cwd, id)` 实现 web
   三级回退；cwd 基名解析同时支持 `/` 与 `\`。
3. 新增 `groupSessionsByProject / orderProjectGroups / sortProjectSessions`：
   workspace `sessionIds` 记账优先，未记账会话按 cwd 组伪项目（同基名消歧），
   无 cwd 进“未分组”并恒排最后。
4. Sessions 卡：`openSessionsCard(chatId, projectKey?, page)` 默认解析活跃项目；
   `openSessionProjectsCard` 提供 12/页项目切换器；per-chat `lastSessionsProject`
   保证详情/翻页/删除后回到原项目；回调新增 `sessions-projects`、
   `sessions-project`、`sessions-projects-page`、`sessions-open`。
5. 键盘：`buildSessionsKeyboard` 顶部加 `🔀 项目 (N)`、运行按钮加 `▶` 前缀；
   新增 `buildSessionProjectsKeyboard`；`buildSessionDetailKeyboard` 支持自定义返回 token。

### 测试

- `test/sessions.test.mjs`：标题回退链、冷会话 cwd、agent status 判定、
  分组/排序/活跃项目/同基名消歧共 6 个新用例，旧“首条消息当标题”断言改为 web 语义。
- `test/keyboard.test.mjs`：项目切换按钮、运行标记、项目切换器键盘/分页。
- `npm run check`：**236/236 pass**。

## 54. Round 2 追加：409 冲突静默退避（2026-08-19，236/236）

- `getUpdates` 连续 409（另一实例在轮询同一 token）时：首次只打一条诊断日志，
  之后指数退避（2s→4s→…→30s）静默重试；对方停止后自动接管并复位计数。
- 避免之前每次 409 刷屏、持续硬碰的局面。

## 55. Workspaces 直接使用 + Create 派发修复（2026-08-16，238/238）

### 实机发现

1. Workspaces 卡的 `Create` 按钮回调是旧式 `w:create`，路由按
   `w:<workspaceId>:<action>` 拆包后把 `create` 当成了 workspaceId，点击后
   落到不存在的详情页 → 用户看到“点了没反应”。
2. Workspaces 详情卡只有 Rename/Delete/Move/Pin，无法把一个已注册项目直接设为
   当前项目来使用。

### 修复

- `dispatchCallback` 在 id/sub 拆包前特判 `id === "create" && sub === undefined`，
  恢复 `Create` → 目录浏览选择器流程；键盘回归测试锁定 `w:create` 契约。
- Workspace 详情卡新增：
  - `✅ 使用此项目`（`workspace-use` token）：等价于对 workspace.path 执行
    `/project`，写入 `workspace.activePath` 并注册缺省 workspace；
  - `🧭 会话`：直接打开该项目在分组 Sessions 卡里的会话页。
- `buildWorkspaceDetailKeyboard` 增加可选 `actions` 参数，缺省行为不变。

### 测试

- `test/keyboard.test.mjs`：`w:create` 契约 + Workspace 详情 Use/Sessions
  按钮随 actions 出现、缺省不出现。
- `npm run check`：**238/238 pass**。

## 56. 冷会话标题与 web 完全对齐（2026-08-16，239/239）

### 实机发现

web 的 `session.list` 对冷会话能通过 projection cache 返回 `session/title` 标题，
Telegram 却只显示项目基名/id。根因：真实 `SessionPersistence.readRaw` 返回
`{ meta, filename, content }`（JSONL 原文），Telegram 适配器还在读旧形状的
`raw.events`，于是冷会话扫描到的 events 恒为空，标题/blank/lastPromptAt 全部丢失。

### 修复

- `PersistenceLike.readRaw` 兼容两种返回形状：`events`（测试 seam）与
  `content`（真实 JSONL 原文）。
- 新增 `parseRawEvents(content)`：逐行解析冷日志为结构化事件，损坏的尾巴行
  跳过但不影响前面的 `session/title`。
- 冷会话的 `titleFor` / `scanMeta` 从此与 web 同源：标题、最近提示时间、
  事件数都来自同一份日志。

### 测试

- `test/sessions.test.mjs` 新增真实 `{ content }` 形状用例：冷会话标题、
  `lastPromptAt`、`eventCount`、`cwd` 全部命中。
- `npm run check`：**239/239 pass**。

## 57. Menu 重排：Goal 置顶 + Watch 第二页 + `/goal`（2026-08-16，240/240）

### 用户要求

- Watch 移到菜单第二页。
- Goal 固定在菜单第一页最上方，且 Goal 卡是显示/编辑/暂停，不是创建入口。
- 用 `/goal <objective> [maxRounds]` 启动目标。

### 修复

- `openMenuAt`：`pages[0]` 第一项改为 Goal（`full` 行，显示当前 objective 摘要），
  `pages[0]` 删除 Watch；`pages[1]` 尾部加 Watch。
- `openGoalsCard`：无目标时只显示“(no current goal)”和 `/goal` 提示；
  有目标时只给 Edit + Pause/Resume（按 `goal.phase` 切换文案）。
- `buildGoalsKeyboard(hasGoal, { edit?, toggle? }, paused)`：移除
  Create/Complete/Clear 按钮，无目标时只剩 Back。
- 新增 `/goal` 命令（与 `/goalcreate` 同解析），`/goalcreate` 保留兼容。
- `dispatchToken` 的 `goal` 分支删除 create/complete/clear，只处理
  edit/pause/resume。

### 测试

- `test/keyboard.test.mjs`：Goal 键盘无 Create、有 Edit/Pause、paused 时变 Resume。
- `npm run check`：**240/240 pass**。

## 58. Bar 布局：Goal 替换 Presets + 收起按钮（2026-08-16，241/241）

### 用户要求

- bar 第三行的 Presets 换成 Goal。
- Stop 右边加“收起”：点击后整条 bar 只剩一个返回按钮，给聊天内容让出屏幕；
  再点返回恢复完整 bar。

### 修复

- `buildBarKeyboard`：`Menu/New/Models · Sessions/Plugins/Status ·
  Goal/Queue·N/Compact · Stop/🙈 收起`。
- 新增 `buildCollapsedBarKeyboard()`：单按钮 `↩ 返回`，同样 resized/persistent。
- `BAR_LABELS` 保留 Presets（旧客户端 bar 兼容），新增 Goal/收起/返回；
  `normalizeBarLabel` 对三者直接归一。
- `state.barCollapsed` 按 chat 记录收起态：
  - 收起：替换 bar carrier 为单按钮键盘；
  - 返回：恢复完整 bar；
  - 收起期间 `syncBar` 不再自动重发完整 bar；
  - `sendWithLiveBar` 在收起态只附单按钮键盘，避免普通消息把 bar 弹回来。
- `dispatchBarButton`：Goal → Goals 卡；收起/返回 → `setBarCollapsed`。

### 测试

- `test/keyboard.test.mjs`：新 bar 布局逐行断言、Presets 不在渲染结果、
  收起键盘仅一个返回按钮、新标签归一化、旧 Presets 标签仍可归一。
- `npm run check`：**241/241 pass**。

## 59. Menu 终版：Goal 与 Capabilities 同行各占一半（2026-08-16，241/241）

- 用户反馈 Goal 不应占满第一行：撤销 §57 的置顶/目标摘要行。
- `pages[0]` 现在为 New session（full）→ Project（full）→ 扩展项 →
  Workspaces/Skills/Subagents/Jobs/Dynamic/Host 两列配对 →
  **Goals 与 Capabilities 同一行，各占一半**。
- `npm run check`：**241/241 pass**。

## 60. 收起按钮视觉与消息清理（2026-08-16，241/241）

- 收起按钮 emoji 从 `🙈` 改为 `🗜️`，返回按钮从 `↩` 改为 `🔙`。
- 点收起/返回后，router 把用户按出的那条按钮文字消息立即删除，
  聊天里不留下“输入内容”；收起态的承载消息文本改为一个点 `·`。
- `RouterDeps.onBarButton` 增加 `messageId`，collapse/return 两种 bar 状态
  切换在 dispatch 后自动清理来源消息。
- `npm run check`：**241/241 pass**。

## 61. 快速收起：inline 控制条 + 原生 bar（2026-08-16，243/243）

### 调研结论

- Telegram 官方文档：`ReplyKeyboardMarkup` 无法原地编辑；`editMessageReplyMarkup`
  只能编辑 inline keyboard。内置 reply 键盘按钮必然发消息，所以收起提速只能走
  callback_query（用户选择“保留原生 bar + inline 收起控制条”方案）。

### 修复

- 原生 bar 恢复为 `Stop` 单独一行（收起不再作为 reply button，避免慢路径）。
- 新增 `buildBarControlKeyboard(collapsed)`：极小 inline 控制条，展开态一个
  `🗜️ 收起` 按钮（`m:collapsebar`），折叠态一个纯文字 `返回` 按钮
  （`m:returnbar`，无 emoji）。
- `state.barControls` 跟踪控制条消息；`ensureBarControl` 优先
  `editReplyMarkup` 原地改键盘，只有消息消失才补发 `·` 载体。
- 点收起：`dropBarCarrier` 删原生 bar 载体 → 控制条原地编辑成 `返回`；
  **聊天里不再新增消息，也不发送/删除用户消息**。
- 点返回：重新 pin 原生 bar（`⌛ Queue · N`）→ 控制条原地编辑回 `🗜️ 收起`。
- 收起期间 `sendWithLiveBar` 不再附 reply keyboard，普通消息保持干净。
- 旧客户端残留的 `🙈 收起`/`🔙 返回` 标签通过 `LEGACY_*` 归一化继续可用。

### 测试

- `test/keyboard.test.mjs`：原生 bar 行数/标签、inline 控制条展开/折叠按钮与
  callback_data、无 emoji 返回、legacy 标签归一化。
- `test/router.test.mjs`：bar button 的 `messageId` 透传。
- `npm run check`：**243/243 pass**。

## 62. 撤销 inline 控制条：收起按钮回到原生 bar（2026-08-16，243/243）

- 用户反馈收起按钮必须可见于 bar 本身：撤销 §61 的独立 inline 控制条。
- `buildBarKeyboard` 第四行恢复 `⏹ Stop · 🗜️ 收起`。
- 收起/展开回到原生载体替换路径（点击后删除按出的消息、点 `·` 承载单按钮
  `返回`），`state.barControls` / `ensureBarControl` 全部移除。
- 旧 inline 控制条的 `m:collapsebar` / `m:returnbar` 仍映射到原生 toggle，
  防止旧按钮失效。
- `npm run check`：**243/243 pass**。

## 63. 保留收起/返回的按出消息（2026-08-16，243/243）

- 用户反馈：不要删掉点击收起/返回时发出的那条消息。
- 撤销 §60 的“dispatch 后删除来源消息”逻辑；bar button 派发恢复为纯
  dispatch，按出的消息正常留在聊天里。
- router 的 `messageId` 透传保留（测试覆盖），供后续需要时使用。
- `npm run check`：**243/243 pass**。

## 64. Sessions 列表直接归档/删除（2026-08-16，244/244）

### 用户反馈

归档/删除藏在会话详情卡里，列表页找不到入口；归档后行还在，看起来“没生效”。

### 修复

- `buildSessionsKeyboard` 每行新增两个内联小按钮：`🗄` 归档、`🗑` 删除
  （有 token 时才渲染）。
- `openSessionsCard` 给每行注入 `session-archive` / `session-delete` token；
  归档直接执行并回到项目列表，删除走原确认卡。
- Sessions 列表与 web 对齐：**归档的会话从列表隐藏**，页头显示
  `🗄N` 归档计数；详情卡仍可显示已归档状态。
- `dispatchToken` 新增 `session-archive` / `session-delete` 两个动作。

### 测试

- `test/keyboard.test.mjs`：有 token 时行内出现 `🗄`/`🗑`，无 token 不出现。
- `npm run check`：**244/244 pass**。

## 65. 中文归档/删除按钮 + Menu 第一页 Bar 开关（2026-08-16，244/244）

- Sessions 行内小按钮改为中文：`归档` / `删除`；页脚提示同步中文。
- Menu 第一页新增 `💡 Bar · 显示中 / 已收起` 全宽开关（`m:bartoggle`）：
  点击直接切换 bar 折叠态，并原地刷新菜单页显示新状态。
- `npm run check`：**244/244 pass**。

## 66. 收起后不再有返回按钮和 · 载体（2026-08-16，244/244）

- 用户最终选择：收起后不要返回按钮，也不要 `·`；恢复入口用 Menu / 命令。
- `setBarCollapsed(true)` 现在只删除原生 bar 载体，**不发送任何替代消息**；
  聊天里只留下用户按出的“收起”消息。
- `sendWithLiveBar` / `syncBar` 在收起态不再自动重发 bar。
- Menu 第一页开关文案改为动作式：`💡 显示 Bar`（已收起）/ `💡 收起 Bar`（显示中）。
- 新增 `/bar [on|off]` 命令：无参数 toggle，`on` 显示，`off` 收起。
- `npm run check`：**244/244 pass**。

## 67. 修复全部 open issues #16-#21（2026-08-18，340/340）

### #16 bar 卡片 Back 语义

- 新增 `cardOrigins: Map<chat, "menu" | "bar">`：`dispatchBarButton` 统一标
  `bar`，`dispatchCommand`/`openMenuAt` 标 `menu`。
- `m:back` 按来源分流：bar 打开 → 同 `Close` 关卡回聊天；menu 打开 →
  回到最近 menu 页；close/换 chat/teardown 清理来源。
- 集成回归：`test/ui-lane.integration.test.mjs` 分别验证 bar Todos 返回关闭、
  menu Todos 返回菜单。

### #17 收起 + typing 10 分钟断档

- `setBarCollapsed(true)` 删除旧 bar 载体后发送
  `buildCollapsedBarKeyboard()` 新载体——persistent reply keyboard 只能被
  新的替代键盘替换，只删消息不生效。
- `runningTurns` 每 chat 跟踪 turn/start→turn/end；typing 10 分钟 guard
  到点时若 turn 仍在运行则续一轮（丢失 turn/end 仍以 agent.status 兜底）。
- 集成回归：收起发送折叠键盘、返回恢复全量 bar；mock 时钟 10 分钟验证
  typing 续期与 turn/end 停表。

### #18 长任务活跃信号 + 完成推送

- openclaw 与 GoalProgressFeed 都增加 30s liveness heartbeat：静默工具
  执行时进度卡标题/行内 elapsed 继续跳动（heartbeat 用 `.unref()`，不撑住
  空闲进程）。
- goal 自主 turn 完成时，除原地编辑进度卡外，再 push 一条新 receipt 消息
  （`disable_notification:false` 响铃）。
- 可配置：`notify.onComplete` / `notify.onLongTask`（默认 true），支持
  `/config set notify.onComplete false` 热更新。
- 回归：openclaw/goal-progress 心跳、完成推送、通知开关测试。

### #19 Markdown 表格

- `markdownToHtml` 支持 GFM 管道表格：识别 `|---|` 分隔行，输出 Telegram
  HTML 支持的 `<pre>` 等宽对齐块（Telegram HTML 无 `<table>`）。
- 复核所有 assistant 送达路径均走 `markdownToHtml`（bridge 即时转发、
  openclaw 最终答案、turn error 消息）。
- 回归：真实 issue 表格样例、无表格隔离、加粗并排渲染。

### #20 LOOP_AUDIT 中风险 8 项全部落地

1. `eventStatsFor` + preset 查找改为 WeakMap 增量 tail 扫描（append-only
   场景 O(1)），数组缩短回退全量重扫。
2. UI 卡片数据加载统一 `cardLoad` 10s deadline：modelCatalog / sessions /
   history / search / skills / subagents / subagent history / presets /
   feedback，超时发可见失败卡片。
3. `listDirectory`/`isDirectory`/`createDirectory` 的 fs 调用全部加 10s
   timeout race（本仓 @types/node 无 fs signal 类型，race 语义等价）。
4. interactive 零投递：question reject、approval settle("cancelled")，不再
   永久挂起 agent 工具调用。
5. `exportSessionLog` 使用 `AbortSignal.timeout(120s)` 并 cancel reader。
6. `SessionLifecycle.close` 的 dispose 加 10s deadline，create 替换会话
   不再被挂起的 dispose 卡死。
7. `ensureOpencodeGoResponsesRoute` provisioning latch 加 15s deadline，
   无论成败 finally 清 latch。
8. 内存清理：session/disposed 时清 CompactionWatcher.states、
   toolCallCounts、statusSubagentCounts、todoSnapshots、Bridge.droppedEvents。
- 回归：status 增量扫描、compaction 清理、interactive 零投递、session
  dispose deadline、opencode latch deadline、UI lane 10s 失败卡片。

### #21 turn receipt 精简为单行 5 metrics

- `renderTurnReceipt` 输出单行：`⚙️ 完成 · ⏱️ Ns · 🧠 N 次思考 ·
  🛠️ N 次工具 · 📊 N 轮 · N 步 · 💾 命中 X%`。
- 移除输入/输出 token、OpenClaw editText 命中率、性能段与分割线；
  editText 命中率改为 openclaw 内部日志。
- 回归：`test/turn-receipt.test.mjs`（单行、五项、goal 前缀、0 billed
  不显示命中率）；openclaw/goal-progress 旧断言同步更新。

### 测试记录

- 新增/更新：markdown、turn-receipt、status、goal-progress、openclaw、
  openclaw-liveness、opencode-go-latch、session-lifecycle、compaction-watch、
  interactive、config、ui-lane.integration。
- `npm run check`：**340/340 pass**。

## 68. 修复 open issues #22-#26（2026-08-18，349/349）

### #22 Status Router 一直显示 router-default

- 根因：preset fallback 读 `agent.session.header.agentPreset`，但真实 session
  header 是 events 里第一个 `type:"session"` 事件的 `data.agentPreset`。
- 修复：`sessionHeaderPreset()` 扫首个 session header event；增量扫描缓存
  新增 `headerPreset` 槽位（append 不重扫，shrunk 时全量重扫）。
- 回归：status 测试改为真实事件形状；新增「两者都无 → undefined」用例。

### #23 placeholder storm v2

- MAX_EDIT_FAILURES 耗尽后不再 `messageId=undefined + ensureMessage()` 重发
  新 `⚙️ Working…`；保留同一 messageId，每 turn 只发一次
  “live progress stalled — use /history” 兜底提示。
- `turn/start` 复用上一条 placeholder 的 `messageId` 与 `placeholderFailed`
  闩锁：turn 重启编辑原消息，不再新发占位。
- 回归（mock 时钟）：6 次失败后 sends 只多一条兜底、后续 chunk 仍编辑
  messageId=100；turn/start 重启 sends 不增加、编辑落在同一 messageId。

### #24 reasoning 延迟 1s

- `EDIT_THROTTLE_MS` 1000 → 200。#15 的 429 防护由 diff 检查 + 同消息指数
  退避承担，不需要 1s 节流。
- 回归：300ms 内首个 stream 帧必须已 edit。

### #25 agent 发文件工具

- 新增 `telegram_attach`（pi-telegram 同名）+ `telegram_send_file` 别名：
  1-10 个 workspace 内文件 / chatId 缺省取执行 agent 绑定 chat /
  roster 白名单 / workspace 根防穿越 / 50MB 上限。
- 按扩展名分流：jpg/jpeg/png → sendPhoto；ogg/opus → sendVoice；
  mp3/m4a/aac/wav/flac → sendAudio；其它 → sendDocument。
- `TelegramTransport` 新增 `sendVoice`/`sendAudio`，同一 SendQueue 限速管线。
- 回归：`test/telegram-attach.test.mjs`（分流、默认 chat、roster/穿越/缺失/
  50MB/非文件/数量上限、别名）。

### #26 reasoning 表格渲染

- 最终答案路径 #19 已覆盖 `markdownToHtml` 表格→`<pre>`；本轮补 openclaw
  进度卡路径：导出 `markdownTablePreBlock`（任意位置找首个 GFM 表），
  `reasoningLineHtml` 对表格 snapshot 输出等宽 `<pre>` 而不是裸 `|` 字符。
- 回归：markdown helper 任意位置识别/无表返回 undefined；openclaw 表格
  snapshot 编辑帧含 `<pre>`、无 `|---|`、无 `<i>` 管道汤。

### 测试记录

- 新增/更新：status、markdown、openclaw、telegram-attach。
- `npm run check`：**349/349 pass**。

## 69. 修复 open issues #27-#30（2026-08-18，356/356）

### #30 代码块不是真等宽

- 根因：`<pre>` 裸块在 Telegram 客户端不保证 monospace，必须
  `<pre><code>…</code></pre>`。
- 修复：fenced code 与 GFM 表格均输出 `<pre><code>`；fence 语言经白名单
  （`[A-Za-z0-9_+#.-]{1,20}`）后输出 `class="language-*"`，非法语言忽略，
  与 pi-telegram 一致。
- 回归：`test/markdown.test.mjs` 新增语言 class、无语言包裹、语言注入消毒
  3 例；表格与 `markdownTablePreBlock` 断言同步到 `<pre><code>`。

### #28 dsh 0.1.0-rc.7 依赖同步

- package.json：6 个 `@deepseek-ai/dsh-*` devDep 精确 pin `0.1.0-rc.7`，
  peerDep 范围 `^0.1.0-rc.7`。
- `npm install`（独立 cache）后 node_modules 全部为 rc.7；typecheck 0 error；
  全套测试在 rc.7 类型/头文件下通过。

### #27 审批卡 session / forever（by tool）档位

- `approvalKeyboard` 新增：
  - 首行：goal（有 goal 时）+ `🟣 Allow for this session`（`ap:*:s`）
  - 次行：`✅ Allow once` / `❌ Reject`
  - 第三行：`🟤 Allow forever (by tool)`（`ap:*:a`）；bash/write/delete 等
    高风险工具追加 `⚠️ risky`。
- session 授权：`grantedSessions: Map<sessionId, Set<tool>>`，同 session 同
  工具后续 approval 直接 `allowed-once`，其他工具/其他 session 仍然弹卡。
- forever 授权：`grantedTools` 内存集合 + `persistToolAllow` 钩子把工具写入
  `interactive.allowByTool`（`.pi/telegram.json`）；重启后经 `allowedTools`
  载入；`/config set interactive.allowByTool [...]` 热更新（`setAllowedTools`）。
- 配置校验：非空字符串数组、去重、非法项报 `interactive.allowByTool[i]`。
- 回归：`test/interactive.test.mjs` 新增 4 例（键盘/风险标、session 范围、
  forever 持久化+重载、无 goal 拒绝 goal 档）；`test/config.test.mjs` 新增
  校验/去重/overlay 1 例。

### #29 dsh-telegram-channel peer 范围（已按仓库所有者决定关闭）

- `dsh-telegram-channel` 是独立外部仓库，不属于本仓库维护范围。
- 曾 fork 验证 `dsh-session`/`dsh-llm` peer `^0.1.0-rc.7` 的修改（typecheck
  通过），但按仓库所有者决定撤回了外部 PR
  https://github.com/hi-wenw/dsh-telegram-channel/pull/6 ，并关闭 #29。

### 测试记录

- 新增/更新：markdown（3）、interactive（4）、config（1），其余全量回归。
- `npm run check`：**356/356 pass**；`npm pack --dry-run`：149 files。

## 70. 修复 open issues #31-#35, #37-#46（2026-08-20，379/379）

### #31 CJK 表格错位

- 根因：`cell.length` 是 UTF-16 code unit 数；CJK 字符在 Telegram 等宽字体
  渲染约 2 列，按 code unit  padding 必然错位；且对 escapeHtml 后的字符串
  量长会把 `&amp;` 等实体算成 5 个字符（渲染只占 1 列）。
- 修复：`cellDisplayWidth`（CJK/全宽/emoji=2 列、零宽=0，`Intl.Segmenter`
  grapheme 切分，无 Segmenter 时退化 code-point 迭代）；`renderTableBlock`
  对 RAW cell 量显示宽、escape 后再补空格；列最小宽 3；模型自由发挥的过
  长 separator 行不再撑大列宽。
- 回归：`test/markdown.test.mjs` 新增 6 例（宽度测量、CJK/Latin 混排对齐、
  可转义字符对齐、最小列宽、emoji 宽度、separator 不撑列）。

### #32 /history 轨迹视图

- `readTrajectory`（sessions adapter）：事件按 `turn/start..turn/end` 分
  组（首个 anchor 之前的事件归入 Prelude）；每 turn 取 `request/header`
  的 `provider/model` 模型行与 changes、`turn/end` 的 outcome（error 带
  消息截断）与起止时长；步骤含 👤 user / 🧠 reasoning / 🤖 assistant /
  🔧 tool-call（名称+参数截断）/ 📥 tool-result。分页：每窗 6 turn，
  `hasMore`+`nextBefore` 向更老翻页；turn 编号跨页稳定（Prelude 不占号）。
- `renderTrajectoryLines`（新 `src/telegram/trajectory.ts`）：纯函数渲染
  HTML 行，全部 escape；超 8 步折叠为 `… N more step(s)`；running turn
  显示 ⏳。
- 接线：History 卡（`openHistoryCard`）与 `/history [id] [turns]` 均改
  为轨迹视图；`Load older` 按 `nextBefore` 翻页；命令描述同步
  「Session trajectory (turn-grouped)」。
- 回归：新 `test/trajectory.test.mjs` 6 例（分组/模型/结局/时长、分页
  hasMore/nextBefore、未知 session 空态、渲染 escape 与图标、折叠与
  running/error 标记、空事件）。

### #33 空回复静默

- 根因：turn 成功但零可见输出（无 reasoning/工具/正文）时 openclaw 把
  占位符 deleteMessage 删掉，聊天陷入静默；pendingInbound 还会补一条误导
  性的工具形 NO_REPLY_REMINDER。
- 修复：区分 error（core 桥已发分类失败消息，占位符删除可接受）与空成功
  ——占位符原地编辑成 `🤷 Empty response · ⏱️ Ns`（编辑失败降级新发；
  无占位符直接新发）；pendingInbound 用该通知 `markInboundReplied`，不
  再叠加工具提醒；turn/start 丢失（无 draft）时也同样发通知。
- 回归：`test/openclaw.test.mjs` 新增 2 例（占位符编辑成通知而非删除；
  inbound 由通知满足、不发工具提醒）。

### #37 429 错误呈现

- `formatTurnFailure`（bridge）：分类语气——429/RATE_LIMIT/quota →
  `⏳ Rate limited…`；5xx/SERVER/网关类 → `⚠️ Upstream provider error…`；
  其余原文 ❌ + escape。OpenAI SDK 无信息字面量
  `429 status code (no body)` 不原文展示，有信息 detail 以 `·` 随行。
- openclaw turn/end error 路径复用同一分类（core 桥发送，openclaw 只抑制
  成功回执）。
- retry 半边由 rc.8 升级解决（见下 #39）。
- 回归：`test/bridge-final-answer.test.mjs` 新增 6 例（四类分类纯函数 +
  429/5xx 端到端落聊天语气）。

### #38-#44, #45, #46 dsh 0.1.0-rc.8 升级

- package.json：6 个 `@deepseek-ai/dsh-*` devDep 精确 pin `0.1.0-rc.8`，
  peerDep 范围 `^0.1.0-rc.8`；`npm install`（独立 cache）后全部 rc.8。
- rc.8 上游修复随之落地：deepseek reasoning_content 回传（#38）、默认
  5 次退避重试 429/5xx/TIMEOUT/TRANSPORT/EMPTY_RESPONSE（#39，即 #37 的
  retry 半边）、pi-ai wire-compat profile surface（#40）、pi-ai 图片
  payload 上限+最旧卸载（#41）、deepseek 多模态（#42）、plan-mode 纯图
  片计划请求（#43）、agent-loop finalize 已送达前缀取消（#44）、slash
  command 路由图片附件（#45）、attachment admission 拒绝过大图片（#46）。
- rc.7→rc.8 类型面兼容：typecheck 0 error，全套测试在 rc.8 下通过。

### #34/#35 上游范围（按 #29 先例关闭）

- #34 Dots AI `api-key` 认证头、#35 MODALITIES video/audio 输入：需
  `deepseek-ai/deepseek-harness` / `pi-ai` 本体变更（rc.8 也未覆盖），
  不属本仓库范围，按 #29 先例关闭并说明。

### 测试记录

- 新增：trajectory 6 例；markdown +6（#31）、openclaw +2（#33）、
  bridge-final-answer +6（#37）。
- `npm run check`：**379/379 pass**（rc.8 依赖下）。
