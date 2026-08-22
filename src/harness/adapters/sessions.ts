/**
 * Session lifecycle and session-domain operations, mirroring the web
 * ApiProxy `sessions` domain (session.list/search/create/history/models/
 * selectModel/rename/fork/prompt/attachment/updateQueue/cancel) over the
 * host seams: ctx.sessions, ctx.agents, ctx.llm, ctx.sessionTitle,
 * ctx.attachments, ctx.agentDefaultModel.
 *
 * Barrel module (🟡-4): the implementation moved verbatim into the sessions
 * family —
 * - `session-read.ts`: list/search/history/trajectory read-only queries plus
 *   the structural shapes and `ctx` seam accessors shared within the family;
 * - `session-lifecycle.ts`: create/rename/fork/resume/prompt/delete, model
 *   selections, queue items, attachments, and the SessionLifecycle class;
 * - `session-render.ts`: title/grouping/ordering/display helpers (pure).
 *
 * Everything this module exported before the split is re-exported below, so
 * all existing import sites (`../harness/adapters/sessions.js`) stay valid.
 */

// --- session-render.ts: pure display helpers -------------------------------
export {
  displayTitleFor,
  sortProjectSessions,
  groupSessionsByProject,
  orderProjectGroups,
  UNGROUPED_KEY,
} from "./session-render.js";
export type { SessionDetail, ProjectWorkspace, ProjectGroup } from "./session-render.js";

// --- session-read.ts: read-only queries ------------------------------------
export {
  listSessionDetails,
  searchSessions,
  readHistory,
  readTrajectory,
} from "./session-read.js";
export type {
  SessionEventLike,
  SearchHit,
  HistoryItem,
  TrajectoryStep,
  TrajectoryTurn,
  TrajectoryResult,
} from "./session-read.js";

// --- session-lifecycle.ts: stateful operations ------------------------------
export {
  renameSession,
  forkSession,
  resumeSession,
  promptSession,
  deleteSession,
  selectSessionModel,
  currentSessionModel,
  releaseModelSelection,
  releaseAllModelSelections,
  listQueue,
  updateQueueItem,
  saveImageAttachment,
  readImageAttachment,
  releaseSavedAttachments,
  SessionLifecycle,
} from "./session-lifecycle.js";
export type {
  AttachmentRefLike,
  QueueItem,
  QueueAction,
  CreatedSession,
  SessionCreateOptions,
} from "./session-lifecycle.js";

export { MessageId } from "@deepseek-ai/dsh-llm";
