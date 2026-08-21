# Changelog

All notable changes to dsh-telegram are documented here.
Versioning follows the npm package version in `package.json`.

## Unreleased

Issues #7-#13, #14, #15, #16-#21, #22-#26, #27-#30, #31-#33, #37-#44, #49, #50.

- **#50 plugin install from the phone**: the Dynamic card is no longer read-only — new `/pluginadd` command (or the `➕ Add plugin` button) accepts a JSON definition (`{"name", "purpose", "host"/"client"}`, optional `pluginId` to append a version), and the card gains per-plugin `▶ Run` / `⏸ Stop` / `🗑 Remove` (confirm-guarded) actions backed by the `dynamicCordisRunner` define/run/stop/undefine remotes. Run prefers the newest defined package and transitions as an update when it differs from the current activation; an unauthorized client half parks in approval and settles through the standard approval card. This lets a user install their own decode plugin — one that calls their own model — and activate it entirely from Telegram.
- **#50 dsh 0.1.1-rc.2 upgrade**: all `@deepseek-ai/dsh-*` dev pins and peer ranges move from `0.1.0-rc.8` to `0.1.1-rc.2` (typecheck + full suite green). Upstream highlights absorbed: unified master/Files image request pipeline with canonical admission, credential records + ask-the-human authorization, llm-deepseek vision model and Files fallback, webserver structured index injection.
- **#49 editText noise**: the benign Telegram `400: message is not modified` response is now classified BEFORE logging and reported as an `editText noop` line — it never pollutes ERROR-level `FAILED` alerting (and pre-c84db7f builds no longer escalate it into identical-payload retry storms once deployed).

- **#31 CJK table alignment**: table cells are now padded by Telegram monospace display width (CJK/fullwidth/emoji = 2 columns, zero-width = 0) measured on the raw cell via `Intl.Segmenter` grapheme splitting, instead of UTF-16 `cell.length` — CJK columns no longer misalign, and cells containing `& < > "` stay aligned because escaping no longer counts toward padding. Columns keep a minimum width of 3 and a model-styled overlong separator row no longer inflates column widths.
- **#32 trajectory view**: `/history` and the History card now render the web's 轨迹 (trajectory) ledger instead of a flat event dump — turns grouped `turn/start..turn/end` with per-turn `provider/model` (from `request/header`), outcome, duration, and 👤/🧠/🔧/📥/🤖 step lines (tool calls include their arguments). Long step lists fold to a counter; `Load older` pages six turns per window.
- **#33 empty response notice**: a successful turn with zero visible output no longer deletes its placeholder into silence — the placeholder is edited into a `🤷 Empty response · ⏱️ Ns` notice (fresh send fallback when no placeholder exists), and a pending inbound is satisfied by that notice instead of the misleading tool-shaped `NO_REPLY_REMINDER`.
- **#37 classified turn failures**: upstream LLM failures are now rendered by tone — 429/rate-limit → `⏳ Rate limited…` (transient, wait and retry), 5xx → `⚠️ Upstream provider error…`, anything else stays verbatim after `❌`. The opaque OpenAI SDK literal `429 status code (no body)` is never shown raw; informative details ride along after a `·`.
- **#38-#44 dsh 0.1.0-rc.8 upgrade**: all `@deepseek-ai/dsh-*` dev pins and peer ranges move from rc.7 to rc.8. rc.8 upstream fixes land in dsh-telegram: deepseek `reasoning_content` passback (#38), five-retry default with backoff for 429/5xx/TIMEOUT/TRANSPORT/EMPTY_RESPONSE — the retry half of #37 (#39), pi-ai wire-compat profile surface (#40), pi-ai image payload bound + oldest offload (#41), deepseek multimodal support (#42), plan-mode image-only requests (#43), agent-loop finalize delivered-prefix cancellation (#44), slash-command image attachment routing (#45), and oversized-image admission refusal (#46).
- **#34/#35 upstream scope**: Dots AI `api-key` auth headers and MODALITIES video/audio input need changes in `deepseek-ai/deepseek-harness` / `pi-ai` itself (rc.8 does not cover them) — closed here as out of scope per the #29 precedent.

- **#27 approval scopes**: approval cards now offer `🟣 Allow for this session` (same tool in the same dsh session) and `🟤 Allow forever (by tool)`, in addition to goal/once/reject. Session grants live in memory for the plugin mount; forever grants persist into `interactive.allowByTool` under `.pi/telegram.json` and survive restarts. High-risk tools (bash/write/delete/…) get a `⚠️` warning on the forever button. Revoke with `/config set interactive.allowByTool []`.
- **#28 dsh 0.1.0-rc.7 sync**: all `@deepseek-ai/dsh-*` dev dependencies are pinned to `0.1.0-rc.7` and peer ranges start at `^0.1.0-rc.7`, so local builds type-check against the same dsh generation production profiles load.
- **#29 external channel package**: closed as out of scope by the repo owner's decision — the peer-range declaration belongs to the separate `dsh-telegram-channel` repository, and the exploratory fork PR was withdrawn so the upstream repo is left untouched.
- **#30 real code blocks**: fenced code and GFM table blocks now render as `<pre><code>…</code></pre>` (Telegram requires the inner `<code>` to guarantee the monospace font), and fenced languages become `class="language-*"` after sanitization, matching pi-telegram.

- **#16 bar card Back semantics**: card origins are tracked (`bar` vs `menu`); Back on a bar-opened card now closes it and returns to chat, while menu-opened cards still return to the last menu page.
- **#17 bar collapse + typing keep-alive**: collapsing sends the one-button collapsed keyboard carrier (Telegram persistent keyboards are only replaced by a new keyboard message), and the 10-minute typing guard renews the loop while the turn is still running instead of silently stopping it.
- **#18 long-task liveness + completion push**: openclaw and goal progress cards heartbeat every 30s so elapsed time keeps moving during silent tools; goal turn completion pushes a fresh receipt message with sound. Configurable via `notify.onComplete` / `notify.onLongTask` (both default `true`).
- **#19 Markdown tables**: GFM pipe tables now render as aligned monospace `<pre>` blocks before assistant output reaches Telegram HTML parse mode.
- **#20 LOOP_AUDIT follow-up**: all 8 medium-risk items landed — incremental session-event stats cache, 10s UI card-load deadlines, bounded filesystem/export/agent-dispose/provisioning-latch calls, zero-delivery settling for questions/approvals, and per-session memory cleanup.
- **#21 slim turn receipt**: the receipt is one `·`-separated line with exactly five metrics (duration, thoughts, tools, turns/steps, cache hit); token billing, performance segments, and openclaw edit hit rate stay internal.
- **#14 live Todo card**: `/todo` and the bar Todos button open immediately on the UI control lane, the card auto-refreshes in place every 5 seconds while the agent runs, switches to `✅ Todos complete` when all items are done, and the refresh loop stops on Back/Close/teardown. `listTodos` now caches the scanned event index per agent so repeated refreshes never re-walk a long session history.
- **#15 openclaw edit storm**: streaming edits are diff-checked (identical frames are skipped) and a failed edit keeps the SAME message id with exponential backoff retries instead of clearing it and spawning a new placeholder. The placeholder is now the full `⚙️ Working…` title, a failed placeholder falls back exactly once per turn, and the editText hit rate is kept as an internal openclaw log line.
- **#22 status Router preset**: the preset fallback now reads the session header from the first `session` event (`events[0].data.agentPreset`) instead of the nonexistent `agent.session.header`, so `Router: router-<preset>` reflects the preset a session actually started with.
- **#23 placeholder storm v2**: exhausting `MAX_EDIT_FAILURES` no longer clears the message id and re-sends a fresh `⚙️ Working…`; the retained message is kept and the user gets one "live progress stalled — use /history" notice per turn. A `turn/start` restart also reuses the previous placeholder's message id and failed-send latch.
- **#24 reasoning latency**: the openclaw edit throttle is back to 200ms (from the over-corrected 1000ms) — diff-checking and same-message backoff from #15 remain the 429 protection.
- **#25 agent outbound files**: new `telegram_attach` tool (+ `telegram_send_file` alias) sends 1-10 workspace files per call, defaults to the executing agent's bound chat, enforces the allowed roster and the workspace root, caps files at 50MB, and auto-routes `.jpg/.jpeg/.png` → photo, `.ogg/.opus` → voice, common audio extensions → audio, everything else → document. Transport gains `sendVoice`/`sendAudio` on the same rate-limited queue.
- **#26 reasoning table snapshots**: `markdownTablePreBlock` finds a GFM table anywhere in a reasoning snapshot and renders it as an aligned `<pre>` block in the openclaw progress draft instead of raw pipes; final assistant answers already used the #19 path.
- **Loop/hang audit hardening**: full-project deadlock/hang/recursion audit (`docs/LOOP_AUDIT.md`); Status panel now stops the Todo card refresh loop, the status subagent latch always clears via a 5s timeout, Bot API/file/transcription fetches are bounded by abort timeouts, `SendQueue` clamps non-positive limiter values instead of spinning forever, and Markdown inline rendering has a recursion depth guard.
- **Responsive bar/control lane**: TelegramTransport now runs every UI surface (cards, menus, status panels, command acks, bar swaps, typing, approval edits) on a dedicated `control:<chat>` queue, so bar buttons — Goal, Todos, Queue, 收起 — react immediately even while assistant streaming occupies the content queue.
- **Goal UX**: Goal card gains `🗑 Clear goal` and `/goalclear`; Goal stays display-only on tap and never touches the running session. Progress cards for autonomous `/goal` turns update per step/tool and collapse at turn end into the openclaw-style receipt (cache hit rate included).
- **#8 auto compaction**: new `compact.threshold` (default 0.8), `compact.policy` (`ask|auto|never`), and `compact.cooldownMs`. Pressure watcher reads durable request usage/context, asks once with an inline approval card, and announces successful compactions with the summary and shadowed token count.
- **#9 media**: multi-photo media groups become ONE inbound turn; voice messages transcribe via an OpenAI-compatible endpoint (`media.transcribe.*`, `OPENAI_API_KEY`); documents/videos download into `~/.dsh/sessions/<id>/attachments` and are injected as a read prompt.
- **#10 todos**: `/todo` command + `📋 Todos` bar/menu entry with live remaining count; `todo/write` events produce incremental add/start/complete cards.
- **#11/#12/#13 observability**: `safeWrap` labels every fire-and-forget failure; transport logs every send/edit/delete/chat-action success and failure; critical command acks fall back to one raw Bot API send; dispatch failures notify the chat; openclaw sends an immediate placeholder on turn/start and a visible fallback when streaming cannot deliver.

## 0.3.9

- Approval cards gain `🟢 Allow for this goal`: one tap auto-allows every later approval under the same goal.
- Abort and stop are split: bar/menu `⏹ Abort` cancels only the current turn (legacy `⏹ Stop` still maps to abort); `/stop` closes the chat's session and unbinds it, `/abort` aborts the current turn.
- Openclaw turn summary redesigned into a compact aligned card: completion/time header, activity row (thoughts/tools/turns/steps), token row, and LLM/tool/speed row.
- Redacted the leaked Telegram bot token from issue #6 and resolved the GitHub secret-scanning alert (the token must still be revoked in BotFather).

## 0.3.8

- Model selection now waits for `opencode-go-responses` to actually appear in the llm registry before switching; a not-yet-registered route returns a clear retryable error instead of `no adapter registered`.
- The provisioned route model entries are minimal (no reasoning-effort map), maximizing compatibility with older pi-ai settings validators.
- Stop semantics fixed: `⏹ Stop` now aborts only the current turn and keeps queued messages; it never falls back to another chat's/session's agent, and the reply says “Stopping the current turn” instead of “Cancelling <session-id>”.

## 0.3.7

Fixes `❌ Stream ended without finish_reason` for `opencode-go/gpt-5.6-luna` and `opencode-go/grok-4.5`.

- Root cause: the Go-tier gateway only serves these two models through the OpenAI **Responses** API; its chat-completions stream ends without a `finish_reason`, which pi-ai correctly reports as `TRANSPORT`.
- dsh-telegram now provisions an additive `opencode-go-responses` route in `llm-pi-ai` settings (same `OPENCODE_GO_API_KEY`, `/zen/go/v1`, `cacheRetention: none` so no stateful session headers), then transparently repoints model selections of `gpt-5.6-luna` / `grok-4.5` to that route.
- The route is idempotent and never rewrites existing provider settings; all other `opencode-go` models keep using chat completions.

## 0.3.6

Issue #5.

- `selectSessionModel` now reads the llm service through `ctx.get("llm")` instead of the strict `ctx.llm` property, so switching models no longer throws `cannot get property "llm" without inject`. `modelsSummary` got the same hardening.
- Callback tokens are restored when their dispatch throws before completing: a failed Models tap stays retryable instead of trapping the user behind “already handled”.
- Turn errors are now delivered to the bound chat even when the turn has no inbound message (goal/maintenance turns): an LLM `TRANSPORT` failure no longer ends in silence.
- With the model-switch path fixed, opencode-go selections resolve through the llm service's `resolveCallConfig` again.

## 0.3.5

Issue #4: `/goal` no longer fails silently.

- `/goal` with no bound agent always sends `❌ No live agent — goals are per-agent.`; service errors send the concrete `❌ <error>` message.
- Command replies are logged (`command reply chatId=... command=... kind=ok|error`) so a swallowed send is visible in the log.
- Session binding after `✨ New` / `/new` / model select is verified and logged; a created-but-unbound session sends an explicit rebind hint instead of going silent.
- Non-409 polling failures (502/timeout/network) now back off exponentially (2s→4s→8s→16s→30s) and log only the first failure until a poll succeeds, matching the existing 409 behavior.

## 0.3.4

- Openclaw turn summary appends a third line with the web-style session stats: `📊 4 轮 · 279 步 | ⚡ LLM 46m41s · 工具调用 5m10s | 🎯 首 token 平均 3.5s · 68 tok/s`.

## 0.3.3

- Inbound routing now has two per-chat lanes: real chat content stays FIFO (rapid first messages still produce one session), while bar buttons and inline callbacks run in a responsive UI lane — tapping `🗜️ 收起` collapses the bar immediately and tapping `Goal` opens the card immediately, even while a turn is working.
- Session creation is serialized per chat across both lanes, and auto-create paths reuse a session that finished first instead of replacing it.
- Openclaw turn summary adds a second line: `📥 输入 N tok · 📤 输出 M tok · 💾 缓存命中 X%`, counted per turn from usage chunks.

## 0.3.2

Issues #2 and #3: a real web-profile integration regression test proves the `tools/execute` seam settles Telegram questions end-to-end, and assistant replies now render Markdown as valid Telegram HTML.

### Web-profile question regression (#2)

- Added a real Cordis + ToolRuntime integration test for `web` profile + Telegram + `ask_user_question`: the web provider is never invoked, Telegram receives the card, option select, custom text, cancel, and concurrent multi-chat questions all settle the exact tool execution.
- Cancelled/aborted question paths reject the waiting tool execution instead of hanging.

### Assistant Markdown rendering (#3)

- New `src/telegram/markdown.ts` normalizes model Markdown to Telegram HTML before sending, for both the built-in bridge forwarder and the openclaw final answer.
- Supports bold/italic/strike, inline and fenced code, links (safe schemes only), ATX headings (as bold lines), unordered/ordered lists, and block quotes.
- Word-boundary-aware emphasis keeps `snake_case` and arithmetic intact; malformed markup degrades to escaped, readable text.
- Long normalized replies still pass through the HTML-aware splitter, so formatting stays balanced across Telegram chunks.
- Internal cards, keyboards, approvals, questions, and the progress draft keep their own HTML pipeline unchanged.

## 0.3.1

Issue #1: Telegram can now answer `ask_user_question` in the web profile and never loses early session events or final answers.

### Interactive question ownership

- New `interactive.userQuestions` config: `telegram` (default), `web`, or `auto`.
- `telegram` answers `ask_user_question` even when `@deepseek-ai/dsh-host-apiproxy` already owns the single `ctx.userQuestions` provider: it intercepts the public `tools/execute` seam instead of registering a second provider, so the service invariant is preserved and a clear startup diagnostic is emitted.
- `web` yields to the browser UI; `auto` keeps the legacy loader-entry inference.
- Question options now use their protocol `label` as the answer value, while callback data carries tiny numeric indexes (long labels can no longer break the 64-byte callback limit).

### Event ordering & final delivery

- `Bridge.deliver()` / `deliverImage()` install the chat binding and inbound quote before calling `agent.followup()` / `agent.send()`, so synchronous `turn/start` / `assistant/message` events can no longer be dropped as “no chat for agent”.
- Dropped events for a Telegram-touched but unbound agent are logged with a per-agent summary.
- Openclaw final-answer delivery moved outside the draft-existence guard: a turn whose live draft was never created still delivers the buffered answer (or the reminder), and final-send failures are logged.

## 0.3.0

Final release of the web-parity Telegram bridge: workspace-grouped sessions, goal/menu/bar ergonomics, direct session management, and release hardening.

### Sessions & workspaces

- Sessions grouped by workspace project; running project opens first; `🔀 项目` switcher plus `🌐 全部会话` flat view.
- Session titles follow the web chain exactly: `session/title` → cwd basename → id (cold-session JSONL parsing fixed).
- `running` mirrors `agent.status === 'running'`; cold sessions keep their header cwd.
- Per-row `归档` / `删除` actions on the Sessions card; archived sessions hide with a `🗄N` count.
- Workspace detail adds `✅ 使用此项目` and `🧭 会话`; the broken `w:create` callback dispatch is fixed.

### Goal & menu

- Goal is a display/edit/pause card (no Create button); `/goal <objective> [maxRounds]` starts it.
- Menu page 1 keeps Goal beside Capabilities; Watch moved to page 2.
- Menu page 1 adds a `💡 收起 Bar / 显示 Bar` switch; `/bar [on|off]` toggles the keyboard.
- Bar layout is `Menu/New/Models · Sessions/Plugins/Status · Goal/Queue/Compact · Stop/收起`.

### Bar & transport

- `🗜️ 收起` hides the bar without leaving a carrier message; restoring is explicit via Menu or `/bar`.
- The tapped collapse/return message stays in the chat.
- Exponential backoff for `getUpdates` 409 conflicts instead of retry spam.

## 0.3.0-rc.1

Telegram-first production hardening on top of the v0.2.0 web-parity baseline.

### Multi-chat isolation

- Per-chat agent bindings route sessions/events back to their own chat; dead bindings fail closed.
- Unbound chats fail closed for display too: Menu/Queue/Status never show another chat's agent or queue.
- Per-chat FIFO inbound router spans the whole create→bind→deliver path, so two rapid first messages can never create two sessions.
- Rebinding a chat clears stale inbound quote state; `disallow`/security hot-update ejects the chat fully.
- `telegram_reply`/`telegram_mark_no_reply` resolve the inbound by the executing agent.
- Approval/question cards route to the session-owned chat; broadcast fallback only when unbound.

### Human-friendly Telegram UX

- Clickable Host directory browser (`Browse cwd`) with Up/Home/Root and 20-dir paging.
- Sessions card sorted by latest prompt, 10/page; History `Load older`; no search clutter.
- Models provider card 12/page; Plugins 20/page; Jobs 20/page.
- Confirm-before-destructive for session/workspace delete, preset remove, subagent interrupt.
- Approval/question settlements edit the original card in place and remove its dead buttons.
- A first `/start` from an unauthorized chat replays the welcome automatically after the Allow tap.
- Project browser has an explicit `☰ Menu` return; Queue items are numbered with text previews.
- Queue actions are delete-and-resend (`🗑 Delete #N`) or `⚡ Run #N now` — no inline text editing.
- Step-by-step text prompts use Telegram ForceReply (input opens automatically); `/start` sets the official MenuButtonCommands.
- Presets/Workspaces/Sessions cards re-read their data in place when web-side settings/plugin events fire.
- Status card mirrors the web top bar: `router-<preset>`, subagent count, and running background jobs.
- Assistant replies stay clean: no 👍/👎/📋 feedback keyboard is attached (web feedback adapters remain for parity).
- Preset copy asks for a custom id; `/goaledit` supports maxGoalRounds.
- Skills card is session-scoped and user-invocable-only; subagent cards show mode/label/hasChildren/reason.
- `/attachment <id>` reads a photo back through its exact durable ref and sends it as a Telegram photo.
- document/voice/video receive a clear guidance reply instead of being silently dropped.
- `/credential` supports batch describe (≤64 refs); credential-set command message auto-deletes.
- `outbound.liveFeed` is a live switch for the Openclaw-style stream (no restart required).
- 15 web forwarded/host events refresh open panels only; no card, no message.

### Reliability & security

- Agent-tool `telegram_send`/`telegram_broadcast` targets are restricted to the allowed roster.
- Callback chat id reads the Bot API shape (`callback_query.message.chat`).
- Router dispatch promises are awaited, so command/bar-button/callback/photo handling is truly per-chat FIFO (no concurrent tap races).
- Malformed assistant events cannot throw the bridge listener; openclaw timers cancel on new turns.
- State-change panel refresh is forwarded exactly once and failures log the real `message + stack`.
- Long messages are split HTML-aware: never inside a tag or entity, with tags rebalanced per part.
- Send queue retries only transient failures (429/5xx/network/timeout); permanent Telegram 4xx fail once.
- Model/settings callback payloads are percent-encoded and decode safely; malformed legacy payloads never kill a tap.
- Callback tokens are single-use and bounded: a button can never execute twice, even on redelivery or a stale tap.
- `/credentialset` deletes the command message queue-ordered before its own reply, so the secret never lingers.
- `telegram_send`/`telegram_reply`/`telegram_broadcast` always deliver their HTML body as HTML.
- Typing keep-alive self-destructs after 10 minutes if a `turn/end` is lost.
- Long-poll restart aborts the previous generation; offset survives stop/start; token registry bounded.
- Unauthorized photos/media receive the allow prompt like text.

### Tests

- `npm run check`: 229/228 (unit + integration across adapters, bridge, router, transport, keyboard, config, tools); exported version is locked to package.json.
- ESM smoke imports for `dist/index.js`, `dist/extensions/openclaw.js`, `dist/extensions/reasoning.js`.

## 0.2.0

- Native Telegram runtime adapter: grammY long polling, send queue + rate limit + retry.
- Web-parity cards for sessions, workspaces, goals, skills, subagents, presets, settings,
  credentials, llm/models, host, commands, jobs, plugins, dynamic inventory (feedback adapters retained but the Telegram reply surface no longer attaches feedback buttons).
- Presets, menu paging, openclaw streaming draft, mid-session preset fork.
- Hot apply/update and teardown-safe plugin lifecycle.
