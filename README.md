# dsh-telegram

<p align="center">
  <strong>Recreate the web-app control experience for <a href="https://www.npmjs.com/package/@deepseek-ai/dsh">DeepSeek Harness</a> agents on Telegram.</strong><br/>
  🤖 Chat with dsh agents from a phone · 🗂️ Drive sessions/models/presets/workspaces with buttons · 🔧 Live status & queue counts · 🛡️ Multi-chat isolation and fail-closed routing
</p>

<p align="center">
  <b>English</b> |
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.3.9-2ea44f" />
  <img alt="License" src="https://img.shields.io/github/license/xqicxx/dsh-telegram?color=blue" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-244%2F244%20green-2ea44f" />
  <img alt="dsh" src="https://img.shields.io/badge/dsh-0.1.0--rc.6-8A2BE2" />
</p>

<p align="center">
  <a href="#why">Why</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#commands">Commands</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#tests">Tests</a> &bull;
  <a href="#docs">Docs</a> &bull;
  <a href="#safety">Safety</a>
</p>

---

## Why?

DeepSeek Harness's web UI is the gold standard for controlling an agent: sessions, models, workspaces, goals, presets, approvals. This plugin brings that surface to Telegram with the messaging ergonomics humans actually expect from a phone bot:

| Dimension | Typical Telegram bot | dsh-telegram |
|---|---|---|
| 🤖 Chat | One global session, implicit state | One agent per chat, bound sessions, fail-closed routing |
| 🧭 Navigation | Long slash-command lists | Persistent reply-keyboard bar + paginated inline cards |
| 🧩 Models | Text config or guesswork | Provider cards, 12/page paging, per-session reasoning picker |
| 📬 Queue | Invisible inbox | Live `⌛ Queue · N` count embedded in the bar key |
| 🛡️ Approval | No path on mobile | Inline Allow/Reject cards settled in place (buttons removed) |
| 📎 Attachments | Dropped silently | Photos enter the session; documents/voice/video get clear guidance |
| 💬 Replies | Plain messages | Native reply-quote to the triggering message, clean reply surface |
| 📈 Streaming | Everything at once | Openclaw-style live draft (thinking / tool lines / typewriter answer) |

## Features

- **🔀 Multi-chat isolation** — per-chat agent bindings, per-chat FIFO inbound router that spans the whole create→bind→deliver path (two rapid first messages can never create two sessions), unbound chats fail closed for display too
- **⚡ Responsive UI lane** — bar buttons and inline callbacks now also ride a dedicated `control:<chat>` outbound queue, so Goal/Todos/Queue/收起 react instantly while assistant streaming occupies the content queue
- **📈 Context-pressure compaction (#8)** — `compact.threshold`/`compact.policy`/`compact.cooldownMs` trigger an approval card or auto compaction near the model window, then announce the summary and shadowed tokens
- **📎 Media (#9)** — multi-photo media groups become one user turn, voice transcribes via `media.transcribe.*`, documents/videos land in the session attachments directory
- **📋 Todos (#10)** — `/todo`, a `📋 Todos · N` bar entry, and incremental todo cards from durable `todo/write` events
- **⚡ Responsive UI lane** — bar buttons and inline callbacks (collapse bar, Goal, menu navigation, question cards) run immediately instead of waiting behind a slow inbound turn; session creation stays serialized per chat across lanes
- **🎛️ Button-first UX** — persistent reply bar (`☰ Menu · ✨ New · 🧩 Models` …) plus ephemeral inline cards for sessions, workspaces, goals, skills, subagents, presets, settings, credentials, llm/models, host, jobs, plugins and dynamic inventory
- **🗂️ Project-grouped sessions** — the Sessions card mirrors the web display-title chain (`session/title` → cwd basename → id), groups sessions by workspace project, opens the running project first, offers a `🔀 项目` switcher, per-row Chinese `归档`/`删除` actions, and hides archived sessions with a live `🗄N` count
- **💡 Bar control** — Menu page 1 has a `💡 收起 Bar / 显示 Bar` switch and `/bar [on|off]` toggles the keyboard; the bar's `🗜️ 收起` hides it without leaving any carrier message behind
- **🎯 Goal in menu** — Goal lives in the first menu page (shares a row with Capabilities); the card is display/edit/pause/`🗑 Clear goal` (or `/goalclear`) only and never disturbs the running session; `/goal <objective> [maxRounds]` starts a goal, long goal turns get a step/tool progress card that collapses into the openclaw receipt with the cache hit rate
- **🗂️ Workspaces are usable** — a Workspace detail card has `✅ 使用此项目` (set active project for new sessions) and `🧭 会话` (open its sessions)
- **🌐 Web-parity surface** — adapters mirror the web ApiProxy RPC contract: `session.list/search/create/history/models/selectModel/prompt/attachment/updateQueue/cancel`, subagents, host, workspace, agent presets, skills, goals, settings, credentials, llm providers/discovery
- **⚡ Openclaw-style live feed** — separate thinking lane, live tool progress, typewriter answer draft, and a turn summary with thoughts/tool calls/duration, input/output tokens, cache hit rate, plus session turns/steps, LLM/tool time and token speeds (`outbound.liveFeed`, hot-toggleable)
- **📝 HTML-aware long sends** — messages over 4096 chars are split on newline/space boundaries, never inside tags or entities, with tags rebalanced per part
- **♻️ Reliability-first queue** — per-chat FIFO + global sliding-window rate limit; retries only 429/5xx/network/timeout, permanent 4xx fails once; restart-safe long polling with offset preservation
- **🔁 Hot update & hot plug** — `internal/update` live-applies whitelist/rules/rate/length/watch without restart; teardown reverses every mount effect and re-apply is idempotent
- **🛡️ Safe by default** — chat allowlist (`empty = deny all`), agent tools restricted to the roster, callback payloads percent-encoded, callback tokens single-use and bounded, secrets never ride back
- **🤖 Agent tools** — `telegram_send` / `telegram_reply` / `telegram_broadcast` / `telegram_attach` (files: photo/voice/audio/document) / `telegram_status` / `telegram_mark_no_reply`, all routed through the same audited send pipeline

## Quick Start

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the returned token. The token is read from `TELEGRAM_BOT_TOKEN` only — it is never written to disk or the profile.

### 2. Install the plugin

```sh
# install into a dsh profile (forwards to pnpm in the profile directory)
dsh plugin --profile <name> add dsh-telegram

# add the loader entry to <profile>/cordis.patch.yml (user layer)
#   - insert:
#       - id: telegram
#         name: dsh-telegram

# provide the token
export TELEGRAM_BOT_TOKEN='123456:ABC...'
```

### 3. Configure `telegram.json`

At `<workspace>/.pi/telegram.json` (the nearest ancestor directory containing `.pi`):

```json
{
  "security": { "allowedChatIds": [123456789] },
  "watch": { "autoStart": true },
  "outbound": { "liveFeed": true },
  "interactive": { "userQuestions": "telegram" }
}
```

All fields are optional; `security.allowedChatIds` empty means **deny all inbound traffic**.

### 4. Start and allow

```sh
/telegram start        # begin long polling (or rely on watch.autoStart)
/telegram allow <id>   # whitelist your chat id
```

Then send `/start` to the bot in Telegram. An unauthorized chat that sends `/start` first gets an Allow button — after tapping it, the welcome message is replayed automatically.

### 5. Chat

Send a message. The bot binds the chat to its own dsh session, streams the turn (when the Openclaw extension is mounted), and replies as a native Telegram quote; no feedback keyboard is attached to the reply.

## Configuration

| Field | Default | Description |
|---|---|---|
| `security.allowedChatIds` | `[]` | Inbound whitelist; empty denies all inbound traffic |
| `watch.autoStart` | `false` | Start long polling when an agent is created |
| `inbound.defaultMode` | `auto-handle` | `auto-handle` / `queue-only` / `muted` |
| `inbound.rules` | `[]` | Ordered rules on `chatId` and/or case-insensitive `pattern` |
| `outbound.parseMode` | `HTML` | Telegram parse mode for assistant replies. Model Markdown (bold/italic/code/links/lists/headings/quotes) is normalized to valid HTML automatically; internal cards are always HTML |
| `outbound.disableNotification` | `false` | Send silently |
| `outbound.maxRetries` | `3` | Retry attempts for transient failures only |
| `outbound.sendRatePerSecond` | `20` | Global sliding-window rate limit |
| `outbound.maxMessageLength` | `4096` | Telegram HTML message limit, used by the splitter |
| `outbound.liveFeed` | `true` | Openclaw-style streaming draft (needs the openclaw extension) |
| `workspace.activePath` | — | Active project folder for new sessions |
| `mode.name` | — | Profile mode label |
| `model.provider` / `model.model` | — | Telegram-owned default model, inherited by `/new` and `✨ New` |
| `reasoning.effort` | `medium` | `minimal` / `low` / `medium` / `high` / `max` directive prefix |
| `interactive.userQuestions` | `telegram` | `ask_user_question` ownership: `telegram` / `web` / `auto`. `telegram` keeps working in the web profile even when the API proxy owns the user-questions provider seam; `web` yields to the browser UI; `auto` keeps the legacy loader-entry inference |
| `interactive.allowByTool` | `[]` | Tool names permanently auto-allowed after the user taps `Allow forever (by tool)` on an approval card (e.g. `["bash", "web_search"]`); set to `[]` to revoke all |

Live updates: Telegram-side `/config get|set <path> [json]` or dsh-side `/telegram config get|set <path> <json>` hot-apply and persist any leaf (e.g. `outbound.sendRatePerSecond`). `interactive.userQuestions` is read at plugin mount and applies on the next restart; `interactive.allowByTool` hot-applies immediately.

## Architecture

```
Telegram ⇄ grammY long polling ⇄ per-chat FIFO router
                                   │
                                   ├─ Bridge        per-chat bindings, inbound quoting, turn events, reminders
                                   ├─ Transport     send queue, rate limit, retry classification, HTML split, stop/start generations
                                   ├─ Cards         ephemeral menu/session/model/workspace/goal/... keyboards
                                   ├─ Interactive   approval/question cards (settle in place)
                                   ├─ Adapters      web ApiProxy parity over ctx services
                                   └─ Extensions    reasoning directive + openclaw streaming draft
```

| Layer | Files | Responsibility |
|---|---|---|
| bridge | `src/harness/bridge.ts` | Per-chat agent routing, event fan-in, native reply quoting, live-feed gate |
| transport | `src/telegram/transport.ts` | Long polling, send queue, timeouts, photo/document delivery |
| queue | `src/telegram/queue.ts` | Per-chat FIFO + global sliding window + transient-only retries |
| router | `src/telegram/router.ts` | Per-chat FIFO for commands/bar/text/callback/media, unauthorized gating |
| html | `src/telegram/html.ts` | Escaping helpers + HTML-aware long-message splitter |
| keyboard | `src/telegram/keyboard.ts` | Pure builders for bar/menu/cards, encoded callback payloads |
| tokens | `src/telegram/tokens.ts` | Bounded single-use callback token registry |
| adapters | `src/harness/adapters/` | sessions, workspaces, goals, skills, subagents, presets, settings, credentials, llm, host, jobs, plugins, status |
| extensions | `src/extensions/` | `reasoning` (effort directives) and `openclaw` (streaming draft) |
| entry | `src/index.ts` | `apply/teardown`, dsh commands + agent tools, card dispatch, hot config |

## Commands

**dsh side**

`/telegram status` · `/telegram start` · `/telegram stop` · `/telegram allow <chatId>` · `/telegram disallow <chatId>` · `/telegram watch on|off` · `/telegram config auto-start` · `/telegram config get|set <path> [json]`

**Telegram side**

`/start /menu /new /compact /stop /models /sessions /workspaces /project [path] /goals /todo /bar [on|off] /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /help /menucheck /answer /config get|set <path> [json]`

Plus `/history [id] [turns]` (the web's turn-grouped trajectory ledger: per-turn model, outcome, duration, and 👤/🧠/🔧/📥/🤖 steps), `/rename <title>`, `/fork [atSeq]`, `/use <id>`, `/archive <id>`, `/queue`, `/todo`, `/steer <text>`, `/cancel`, `/goal <objective> [maxRounds]`, `/goalcreate <objective> [maxRounds]`, `/goaledit <text>`, `/goalclear`, `/workspacecreate <path> [title]`, `/workspacepin <workspaceId> <sessionId> [before]`, `/pluginenable|plugindisable <name>`, `/settingsdescribe [ns]`, `/settingsupdate <ns> <json>`, `/settingsreplace <ns> <json>`, `/settingsmutate <ns> <json-ops>`, `/credential|credentialset|credentialunset <REF> [value]`, `/ls [path]`, `/mkdir <path>`, `/openpath [path]`, `/pickdir [path]`, `/discover <settingsNs> [baseURL]`, `/subagentprompt <text>`, `/sessionlog [id]`, `/commands`, `/capabilities`, and `/pluginadd [json]` (install your own dynamic plugin from the phone: the host half can call your own model to decode; run/stop/remove live on the Dynamic card, #50).

## How It Works

A turn's full lifecycle:

1. Telegram delivers an update → transport answers callbacks first, then the per-chat FIFO router dispatches command / bar button / callback / text / photo / document.
2. The first message in a chat creates and binds a chat-owned dsh session; the FIFO promise spans the whole create → bind → deliver path, so a burst of first messages still lands in one session.
3. The bridge delivers the message as a user turn (or queues it per inbound mode) and records the Telegram message id for native reply quoting.
4. The openclaw extension streams reasoning/tool/answer into one editable draft (when mounted and `outbound.liveFeed` is on).
5. The final assistant text lands as a native reply to the triggering message with no feedback keyboard attached; a missing `telegram_reply` produces an explicit reminder instead of silence.
6. Approval/question cards are claimed by the bridge, answered inline, and settle by editing the card in place (buttons removed).

## Tests

```bash
npm run check          # tsc build + node --test: 244/244 green
npm audit --omit=dev   # 0 vulnerabilities
npm pack --dry-run     # publish payload: dist + README + README.zh + CHANGELOG + LICENSE
```

The suite covers bridge routing, multi-chat isolation, transport races, queue retry classification, HTML splitting, keyboard payload encoding, token single-use, interactive cards, config hot-update, every web-parity adapter, and apply-level integration tests (including the rapid-first-message race).

## Docs

- [`docs/WEB_PARITY_AUDIT.md`](docs/WEB_PARITY_AUDIT.md): per-method web-parity status and remaining gaps
- [`docs/SEAMS.md`](docs/SEAMS.md): verified dsh service seams
- [`PLAN.md`](PLAN.md): interface mapping and rollout plan (sections A–D)
- [`TESTING.md`](TESTING.md): full automated/live test log and the manual Telegram acceptance checklist
- [`CHANGELOG.md`](CHANGELOG.md): version history

## Safety

- Only whitelisted chats are handled; an empty allowlist denies all inbound traffic
- Agent tools can only target chats in the allowed roster
- Callback payloads are percent-encoded and decode safely; tokens are single-use and bounded
- User/agent content is always HTML-escaped before wrapping; long HTML is split without breaking tags
- The bot token comes only from `TELEGRAM_BOT_TOKEN` and is never persisted; credential values never ride back
- Permanent Telegram 4xx errors are never retried; a per-call timeout keeps a hung request from wedging the send chain

## License

MIT
