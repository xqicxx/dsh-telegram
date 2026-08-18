# dsh-telegram 进度日志

## 2026-08-16 Round 1（已完成）

- 基线构建修复 + 12 项缺陷修复，160/160 tests，commit `577a820`。
- 详见 TESTING.md §15。

## 2026-08-16 Round 2（已完成）

- liveFeed 真开关、15 个转发事件订阅、危险操作确认、credential 隐私。
- 163/163 tests；提交 `4beeb7f`、`319169c`、`64337ee`。
- 详见 TESTING.md §16。

## 2026-08-16 Round 3（已完成）

- Sessions/History 分页、goal edit maxRounds、preset copy 自定义。
- 173/173 tests；提交 `71f8347`；详见 TESTING.md §17。

## 2026-08-16 Round 4（已完成）

- Models/Plugins 分页、工具白名单、host/commands/jobs/dynamic 单测。
- 183/183 tests；提交 `683e7d7`；详见 TESTING.md §18。

## 2026-08-16 Round 5（已完成）

- Host `Browse cwd` 目录浏览、Jobs 分页、Search 专用键盘。
- 184/184 tests；提交 `9fe482e`；详见 TESTING.md §19。

## 2026-08-16 Round 6（已完成）

- Skills 按 sessionId 查询并只显示 user-invocable；Search 结果 10/页分页。
- 187/187 tests；提交 `d50ae7d`；详见 TESTING.md §20。

## 2026-08-16 Round 7（已完成）

- Subagents 对齐 web 目录语义并 gating continuable。
- 190/190 tests；提交 `f805d65`；详见 TESTING.md §21。

## 2026-08-16 Round 8（已完成）

- document/voice/video 明确指引；downloads 单测；README 平台限制同步。
- 194/194 tests；提交 `8d77095`；详见 TESTING.md §22。

## 2026-08-16 Round 9（已完成）

- `/credential` 批量；Host 版本真实化。
- 198/198 tests；提交 `22c028a`；详见 TESTING.md §23。

## 2026-08-16 Round 10（已完成）

- `/attachment <id>` 读回真实 ref；Host 默认模型对齐 agentDefaultModel。
- 201/201 tests；提交 `4338240`；详见 TESTING.md §24。

## 2026-08-16 Round 11（已完成）

- v0.3.0 RC：版本、CHANGELOG、preset hasDocument、§25 人工 checklist。
- 202/202 tests；提交 `876302f`；详见 TESTING.md §25。

## 2026-08-16 Round 12（已完成）

- Host 浏览卡 New folder。
- 203/203 tests；提交 `8f11be2`；详见 TESTING.md §26。

## 2026-08-16 Round 13（已完成）

- Models routable + per-session thinking。
- 206/206 tests；提交 `9301270`；详见 TESTING.md §27。

## 2026-08-16 Round 14（已完成）

- Settings schema envelope。
- 207/207 tests；提交 `14ac1ee`；详见 TESTING.md §28。

## 2026-08-16 Round 15（已完成）

- settings expectedRevision。
- 208/208 tests；提交 `7c8cfd8`；详见 TESTING.md §29。

## 2026-08-16 Round 16（本轮）

- Subagent activity 重映射 + prompt 时区/信号。
- `npm run check`：**208/208 pass**。
- 文档已同步 TESTING.md §30 与 WEB_PARITY_AUDIT.md。
- 待办：npm pack 验证 + git 提交本轮改动。

## Round 17（已完成）

- Release gate：npm publish --dry-run OK；tag v0.3.0-rc.1（commit `3bccf34`）。
- 详见 TESTING.md §31。

## Round 18（本轮）

- 独立审计 7 项修复；211/211 tests。
- 实机冒烟：@XosEvolvesbot 长轮询、openclaw 挂载、bar sync 投递成功。
- 详见 TESTING.md §32。

## Round 19（本轮）

- 实机实例保持运行（web 49523 + long polling + openclaw）。
- §25 checklist 已发到 Telegram chat 8753447694（message_id 1271）。
- 详见 TESTING.md §33。

## 下一步（Round 20 候选）

收集用户在 Telegram 的 checklist 结果；有偏差修偏差，全过则推 tag 与正式发布。

## Round 20（本轮）

- 实机日志发现 `state change handler failed [object Error]` 刷屏；根因是上次改名误把 `notifyStateChange()` 方法体改成自递归，RangeError 每次 turn 事件触发。
- 修复并新增 2 个回归测试；`npm run check`：**213/213 pass**。
- 重启隔离实机（web 49733）复验：两次 `/telegram status` turn 完成，无 state-change 错误。
- 详见 TESTING.md §34。
- 剩余阻塞：隔离 profile 无 `DEEPSEEK_API_KEY`，完整 agent 轮次无法验证；等待用户提供 key / 完成 §25 人工清单。

### Round 20 追加

- 复制主 profile 凭据到隔离 DSH_HOME 后重启（web 49803）：`MISSING_CREDENTIAL` 消除，但现有 `DEEPSEEK_API_KEY` 已失效（401 AUTH）。等待用户更新有效 key 后跑完整 Telegram 轮次。

## Round 21（本轮）

- 独立发布审计（后台子代理）：213/213、audit 0、pack 119 files；报 3 个发布阻断。
- 修复版本漂移 / HTML 拆分 / 重试分类 / 回调编码 / HTML 工具契约 / typing 泄漏；新增 9 个回归测试，**222/222 pass**。
- 实机：激活 opencode-go 路由，真实 LLM 轮次 `turn/end completed`；修复版 live 实例 web 50755 运行正常。
- 待人工：Telegram chat 真实入站一条消息完成端到端交付；§25 清单与发布。

## Round 22（本轮）

- 修复多聊天展示串台（未绑定 chat fail-closed）与 approval/question 卡片原地结算；223/223 pass。
- 实机端到端仍等用户在 Telegram 回复（提醒已发，message_id 1277）。

## Round 23（本轮）

- 修复 callback token 重复执行与 /credentialset 删除竞态；226/226 pass。
- 实机端到端仍等待用户在 Telegram 回复。

## Round 23 追加

- 实机发现并修复「两条首消息 → 两个会话」竞态；新增 apply-race 集成测试；227/227。

## Round 24（本轮）

- 修复未授权 /start 放行后的欢迎语重放；227/227。
- 实机端到端：真实 Telegram ping 已验证（真实 LLM turn completed）；竞态修复后等待用户快速连发复验。

## Round 25（本轮）

- 收集到真实 Telegram 实机验收证据：单会话竞态、回调闭环、真实 LLM 轮次。
- 发布门满足，下一步 push main/tags + release。

## Round 25 发布动作

- GitHub push + pre-release 完成；用户已明确选择暂不发布 npm，发布动作以 GitHub rc release 收口。

## Sessions 项目分组交互（本轮）

- 按用户要求：标题直接同步 web（title → cwd 基名 → id），Sessions 卡按工作区项目分组，
  默认打开运行中项目，`🔀 项目` 可切换，保留 `🌐 全部会话` 平铺。
- 适配层：cold cwd 透传、`running` 改 `agent.status`、新增分组/排序纯函数。
- UI：Sessions 卡项目页 + 项目切换器 + per-chat 返回记忆；键盘新增项目行与运行标记。
- `npm run check`：**236/236 pass**；计划见 `docs/SESSION_UX_PLAN.md`。
- 待办：实机冒烟（真实 bot `/sessions` 默认落运行项目、切换、返回同项目）。

## Round 26（本轮）

- 按用户实机反馈：bar 所有按钮走独立 `control:<chat>` 出站队列（卡片/命令回执/Bar 载体/typing 不再排在 assistant 流后面），收起按钮 fire-and-forget 立即响应；Goal 按钮保持 UI 通道只读展示，并新增 `🗑 Clear goal` + `/goalclear`（先确认，不影响运行中会话）。
- 修复 issue 7：goal 长任务 step/tool 进度卡（无流式渲染器时自动启用），turn/end 收成 openclaw 风格收据并保留缓存命中率；openclaw 草稿标题在 goal turn 显示目标与 step。
- 修复 issue 8：`compact.threshold|policy|cooldownMs` 配置 + 压力观测器（request/context + usage），ask 弹一次性审批卡，auto 直接 compactIfNeeded，成功推送摘要与压缩量。
- 修复 issue 9：多图媒体组合并为单 turn；语音走 OpenAI 兼容转写（`media.transcribe.*`）；文档/视频落盘 `~/.dsh/sessions/<id>/attachments` 并注入读取提示。
- 修复 issue 10：`/todo` 命令、`📋 Todos · N` bar/menu 计数、`todo/write` 增量卡片、状态/优先级展示。
- 修复 issue 11-13：transport 全通道成功/失败日志 + `sendTextFallback` 原始 API 兜底、`safeWrap` 消灭 `void X.catch(()=>{})`、dispatch 失败通知用户、openclaw turn/start 即发占位并在流失败时给用户兜底提示。
- `npm run check`：**305/305 pass**（新增 safe/todos/compaction/media/goal-progress/transport lanes 测试）。
- 待办：实机冒烟 + 用户确认后提交/发布。

## Round 27（本轮）

- 修复 GitHub issue #15（openclaw placeholder storm）：
  - 编辑帧 diff 检查（相同 HTML 直接跳过，避免 400 "message is not modified"）。
  - 节流 120ms → 1000ms（每 chat ~1 edit/s）。
  - 编辑失败保留 `messageId`，同消息指数退避重试（1.5s→30s cap）；连续 5 次失败才放弃并换一个新占位。
  - 占位消息从单字符「…」改为完整标题 `⚙️ Working…`；占位发送失败只发一次 fallback，本回合不再重试。
  - turn receipt 新增 `🎯 OpenClaw: N 次 editText · 命中 X%`。
- 修复 GitHub issue #14（Todos 卡死 + 执行中实时查看）：
  - `listTodos` 按 agent 增量缓存（WeakMap + scannedEnd），只扫新增事件尾部，空结果也缓存，数组缩短时全量重扫。
  - Todos 卡打开即走 control lane，入口/耗时/错误日志 + 失败兜底消息。
  - 卡片每 5s 原地 auto-refresh；Back/Close/换卡/teardown 自动停表；`turn/end` 立即刷新活跃卡片。
  - 全部完成时卡片头变为 `✅ Todos complete · X/Y done`（新增 `telegram/todos-card.ts` 纯渲染模块）。
- `npm run check`：**317/317 pass**（新增 openclaw 4 例、todos 缓存 4 例、todos-card 渲染 3 例、Todo 卡 5s 刷新集成测试 1 例）。
- 已提交 `29669fd` 并推送 main；issues #14/#15 已评论并关闭（评论含修复说明）。

## Round 28（本轮）

- 全项目死锁/卡死/无限递归/循环审计：扫描全部 while/for(;;)/setInterval/await 无超时/自递归路径；逐模块审查并发结构。
- 审计报告写入 `docs/LOOP_AUDIT.md`；高风险 8 项已修复、中风险 8 项已列 plan（findings.md + LOOP_AUDIT）。
- 本轮修复：
  - Status 打开时停 Todo 5s 定时器（修“Todo 卡复活”）。
  - `statusSubagentSync` 闩锁加 5s 超时，保证 finally 必清。
  - `downloadFile`/`sendTextFallback`/`setCommands`/`transcribeVoice` 网络调用全部加超时。
  - `SendQueue` 对非正 maxPerWindow/windowMs 做 clamp（防无限循环）。
  - `markdown renderInline` 增加递归深度上限 32（防栈溢出）。
- `npm run check`：**319/319 pass**（新增 queue clamp、markdown 深度、media signal、Todo/Status 切换集成测试）。
- 待办：commit/push 本轮；中风险项按 LOOP_AUDIT 计划后续轮次实施。

## Round 29（本轮）

- 修复全部 open issues #16-#21：
  - #16 bar 卡片 Back：来源记录（bar/menu）分流，bar → 关卡回聊天。
  - #17 收起发 collapsed keyboard 新 carrier；typing 10 分钟 guard 在 turn 仍跑时续轮。
  - #18 openclaw + GoalProgress 30s heartbeat；goal 完成 push 新 receipt（响铃）；
    `notify.onComplete/onLongTask` 配置开关（默认 true）。
  - #19 markdown GFM 表格 → `<pre>` 等宽对齐；assistant 送达路径复核。
  - #20 LOOP_AUDIT 中风险 8 项全部落地（增量 eventStats 缓存、UI lane 10s deadline、
    fs timeout、interactive 零投递、sessionlog 超时、dispose 超时、opencode latch、
    会话级内存清理）。
  - #21 turn receipt 单行 5 metrics；token/性能/editText 命中率内部化。
- 新增/更新回归测试 19 例（详见 TESTING.md §67）。
- `npm run check`：**340/340 pass**。
- 已提交 `040bbd2` 并推送 main；GitHub issues #16-#21 全部关闭，open issues 已清空。

## Round 30（本轮）

- 修复 open issues #22-#26：
  - #22 status Router preset：fallback 改读 events 首个 session event 的
    agentPreset（兼容 data/envelope 平铺），headerPreset 入增量缓存。
  - #23 placeholder storm v2：MAX_EDIT_FAILURES 保留 messageId 不再重发占位、
    每 turn 仅一次 stall fallback；turn/start 复用 messageId 与
    placeholderFailed 闩锁。
  - #24 EDIT_THROTTLE_MS 1000→200，diff+退避继续承担 429 防护。
  - #25 新增 telegram_attach / telegram_send_file（workspace 白名单、1-10 文件、
    50MB、roster、photo/voice/audio/document 分流）；transport 补
    sendVoice/sendAudio。
  - #26 reasoning 表格 snapshot 走 `markdownTablePreBlock` → `<pre>` 等宽块。
- 新增回归：status 2、markdown 2、openclaw 4、telegram-attach 1（总 349）。
- `npm run check`：**349/349 pass**；`npm pack --dry-run` 通过（149 files）。
- 已提交 `be550f3` 并推送 main；issues #22-#26 全部关闭，open issues 已清空。

## Round 31（本轮）

- 修复 open issues #27-#30：
  - #27：审批卡新增 `🟣 Allow for this session`（同 session 同工具）与
    `🟤 Allow forever (by tool)`（`interactive.allowByTool` 持久化，
    `/config set` 可撤销/热更新）；高风险工具 forever 按钮带 ⚠️。
  - #28：6 个 `@deepseek-ai/dsh-*` devDep 精确 pin 与 peer 范围全部升至
    `0.1.0-rc.7`；本机 rc.7 下 typecheck + 全量测试通过。
  - #29：外部仓库 dsh-telegram-channel，按所有者决定直接关闭，不再跟踪。
  - #30：fenced code / GFM 表格全部 `<pre><code>`，语言 class 白名单。
- 回归测试新增 8 例（markdown 3 / interactive 4 / config 1）。
- `npm run check`：**356/356 pass**；`npm pack --dry-run`：149 files。
- 已提交 `f1559da` 并推送 main；#27/#28/#30 已关闭。
- #29：用户明确表示「别人的仓库不要管」，已直接关闭 issue；验证性 fork PR
  https://github.com/hi-wenw/dsh-telegram-channel/pull/6 已撤回，后台 watcher 已取消。
- GitHub open issues：**0**（#27-#30 全部关闭）。
