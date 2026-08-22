# dsh-telegram Design Language (DTL)

> 目标：让每一张卡片、每一条回执在手机上都"一眼可扫"——统一的字形语义、
> 统一的排版层级、统一的元数据分隔，并严格落在 Telegram Bot API 官方
> 支持的格式化能力之内。

## 1. 调研结论（官方 Bot API 格式化契约）

来源：https://core.telegram.org/bots/api#formatting-options （2026-08 抓取核对）

HTML parse_mode **只**支持以下标签：

| 能力 | 标签 | DTL 用法 |
| --- | --- | --- |
| 粗体 | `<b>` / `<strong>` | 卡片标题、回合标签、目标/结果句首（`ui.bold`） |
| 斜体 | `<i>` / `<em>` | 辅助说明（少用） |
| 下划线 | `<u>` / `<ins>` | 暂不使用（噪音） |
| 删除线 | `<s>` / `<del>` | 已完成的 todo 条目（状态由图标+删除线表达） |
| 剧透 | `<tg-spoiler>` | 暂不使用 |
| 链接 | `<a href="…">`、`tg://user?id=` | 文档/外链；提及用户暂未使用 |
| 行内码 | `<code>` | 一切"机器值"：session id、路径、模型名、文件名 |
| 代码块 | `<pre>` / `<pre><code class="language-x">` | 助手输出的 fenced code、GFM 表格对齐 |
| 引用 | `<blockquote>` | 助手输出的引用段 |
| **可折叠引用** | `<blockquote expandable>` | 轨迹视图溢出步骤的折叠区（默认收起，点开展开；**不可嵌套**） |
| **日期时间实体** | `<tg-time unix="…" format="r">回退文本</tg-time>` | "last prompt 5m ago" 等相对时间，由客户端本地化渲染 |

硬性约束：

- 命名实体只有 `&lt; &gt; &amp; &quot;`（数字实体均可）；`escapeHtml` 已符合。
- `blockquote` 家族不可嵌套。
- 单条消息上限 4096 字符 —— `splitText` 负责分片并在切片处
  闭合并重放标签（保留原始开标签属性，`<blockquote expandable>` 分片后仍可折叠）。
- 自定义 emoji（`tg-emoji`）需要 Fragment 用户名/Bot Premium —— 不使用。

## 2. 排版规范

### 层级（自上而下）

```
{icon} <b>标题</b> · 元数据 · 元数据     ← headerLine：一行头部，至多两三段安静元数据
────────────                           ← divider(16~24)：分组间细线（纯文本，明暗通道一致）
▸ <b>条目</b> ▶️                        ← 主键加粗；状态用字形缀尾
   ⏱️ <tg-time …>3 分钟前</tg-time> · a1b2c3d4   ← 缩进两格的次要行：时间 + 单码 id
```

### 字形语义表（一个字形只表达一种含义）

| 字形 | 含义 | 出现处 |
| --- | --- | --- |
| ✅ | 成功/完成/全部完成 | 回合结果、todo 完成、回执句首 |
| ❌ | 失败/错误 | 错误回合、失败提示 |
| ⏳ | 进行中/等待 | 未闭合回合、in_progress todo |
| ⚙️ | 中性/系统动作 | stopped 回合、Host 设置 |
| ▶️ | running 状态缀 | 会话行、项目行、状态条 |
| ▸ / • | 绑定项 / 普通项 的行首标记 | Sessions、Projects |
| ⏱️ | 时间量/时点 | 时长、last prompt |
| 🧠 🛠️ 👤 🤖 📥 | 思考 / 工具 / 用户 / 助手 / 工具产物 | 轨迹账本行 |
| 💾 | 缓存命中率 | 回执 |
| ─（U+2500） | 分组细线 | divider |

### 进度条

`progressBar(done, total, width=10)` → `▓▓▓░░░░░░░ 30%`。
纯文本实现，HTML 与纯文本通道渲染一致；Todos 卡与 Goal 进度卡共用。

### 相对时间

`relTime(ms)` → `<tg-time unix="…" format="r">本地化回退</tg-time>`。
兼容性注：`tg-time` 是较新的 Bot API 实体；api.telegram.org 始终支持，
自建反代的老版本 Bot API server 可能拒绝该实体 —— 若遇到
"can't parse entities"，回滚点集中在 `src/telegram/ui.ts#relTime` 一处。

## 3. 代码约定

- 唯一入口：`src/telegram/ui.ts`（字形/排版原语/进度条/相对时间）。
  新卡片禁止再手写 `\u00B7` 拼接头部或私有进度条。
- 双层约定防双重转义：
  - 文本级助手（`bold/mono/strike/relTime`）接收**纯文本**并负责转义；
  - 行级组装器（`headerLine/metaJoin`）接收**已渲染 HTML 片段**只做布局拼接。
- 任何用户可控文本进入 HTML 通道前必须经过转义（历史上 goal 目标文、
  todo 内容都出现过裸插值——含 `<` 即整条消息 HTTP 400）。
- 渲染器输出一律假设 parse_mode=HTML；命令通道如需发送 HTML，
  走 `t.sendTextControl(chatId, html, { parse_mode: "HTML" })` 并保留
  纯文本降级路径（见 `/history`）。

## 4. 已落地表面

- `telegram/trajectory.ts` — 加粗回合标签、单码模型名、溢出步骤折叠进
  expandable blockquote；`/history` 命令改走 HTML 通道。
- `telegram/todos-card.ts` + `harness/adapters/todos.ts#renderTodos` —
  状态进图标、完成项删除线、共享进度条、去掉 `[status]` 标签噪音。
- `telegram/goal-progress.ts` — 目标句加粗并转义（修复裸插值 400 隐患）、
  共享进度条与 metaJoin。
- `telegram/turn-receipt.ts` — 结果/目标句首加粗（openclaw 回执同享）。
- `cards/sessions.ts` — Sessions/Projects/详情/搜索四卡重构：
  两行头部（标题+元数据条）、粗体主键、缩进次要行（相对时间 + 单码短 id）、
  详情卡只拼非默认状态词。
- `cards/goals.ts` — Goal 卡：目标句即内容主体（粗体），phase/rounds/rev
  降为安静 kv 条，created 走相对时间；paused 状态进头部元数据。
- `cards/queue.ts` — Queue 卡：📨 头部带 inbox/outbox 计数，live goal 行
  粗体目标 + ETA 进 metaJoin，条目行统一 `#n · kind · 预览`。
- `cards/models.ts` — Models/Providers/ProviderModels/Thinking 四卡：
  当前选择单码化进头部，组名粗体 + 模型 id 单码缩进，选中项 ✅ 前缀。
- `cards/presets.ts` — New session/Presets/Preset detail 三卡：
  ⭐ 默认标记保留，id 粗体，trust/broken 进 metaJoin，描述缩进两格。
- `cards/workspaces.ts` — Workspaces 列表/详情/Project picker/Create picker：
  路径全部单码化，详情卡 created/updated 相对时间，当前项目 ✅ current 进头部。
- `cards/misc.ts` — 全部 14 张卡：Plugins/Skills/Subagents/Jobs/Dynamic/
  Capabilities(🧩→🧪 探针语义)/Feedback/Mode/Allowed/Watch(状态进图标 🟢/🔴)/
  Settings/About 等 —— 头部统一 headerLine，机器值一律 mono，
  Jobs started 时间走相对时间。
- `telegram/html.ts`（并行流 RE-2 同步落地）— split 后重放开标签保留属性。

## 5. 待办（下一轮）

- host.ts 卡群（并行流正在编辑该文件，等落定后迁移）。
- 键盘按钮文案统一（动词开头、长度预算、emoji 规范）—— keyboard.ts 亦在
  并行流编辑中。
- openclaw 流式草稿的工具行与 ui.ts 对齐（openclaw.ts 在并行流编辑中）。
