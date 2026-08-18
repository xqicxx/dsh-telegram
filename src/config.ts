import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REASONING_EFFORTS } from './reasoning.js';

/** How inbound chat text is treated before it ever reaches the agent. */
export type InboundMode = 'auto-handle' | 'queue-only' | 'muted';

/** Which channel owns `ask_user_question` when more than one UI is mounted. */
export type QuestionOwnership = 'telegram' | 'web' | 'auto';

/** Context-pressure compaction policy (issue #8). */
export type CompactionPolicy = 'auto' | 'ask' | 'never';

/** Ordered inbound rule; the first matching rule wins, otherwise `inbound.defaultMode`. */
export interface InboundRule {
  /** Optional numeric Telegram chat id. */
  chatId?: number;
  /** Optional case-insensitive substring; matches when the message text contains it. */
  pattern?: string;
  mode: InboundMode;
}

export interface TelegramConfig {
  security: {
    /** Chat id whitelist for inbound traffic. Empty means ALL inbound chat is rejected. */
    allowedChatIds: number[];
  };
  watch: {
    /** Start long-polling automatically when the plugin mounts. */
    autoStart: boolean;
  };
  inbound: {
    defaultMode: InboundMode;
    rules: InboundRule[];
  };
  outbound: {
    /** Telegram parse mode for assistant output. Model Markdown is normalized
     * to valid Telegram HTML before sending; internal cards are always HTML. */
    parseMode: 'HTML';
    disableNotification: boolean;
    /** Per-message send retries on 429 / network errors. */
    maxRetries: number;
    /** Global send budget: messages per second (Bot API safe bound is 30). */
    sendRatePerSecond: number;
    /** Hard cap for one outbound text payload; longer text is split into parts. */
    maxMessageLength: number;
    /** Live reasoning/tool feed: one message edited in place while a turn
     * streams (web-style thinking + tool-call visibility). */
    liveFeed?: boolean;
  };
  /** Context-pressure auto compaction: when the latest request uses more than
   * `threshold` of the model context window, the bridge compacts automatically
   * (`auto`), asks first (`ask`), or stays quiet (`never`). */
  compact: {
    threshold: number;
    policy: CompactionPolicy;
    /** Minimum interval between two triggers for one session, ms. */
    cooldownMs: number;
  };
  /** Active project folder (Codex-style); new sessions are created under it. */
  workspace: {
    /** Absolute folder picked via /project; absent = boot directory. */
    activePath?: string;
  };
  /** Optional display facts surfaced in the status card. */
  mode?: {
    name?: string;
  };
  /** Telegram-owned default model (overrides the profile default so the bot
   * can run a different model than the web keeps). */
  model?: {
    provider?: string;
    model?: string;
  };
  /** Per-chat reasoning effort (codex-telegram-bot semantics): a directive is
   * prepended to inbound messages. Absent = medium. */
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high" | "max";
  };
  /** Telegram media handling (issue #9): OpenAI-compatible voice
   * transcription. Missing apiKey = transcription disabled with guidance. */
  media?: {
    transcribe?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
  };
  /** Interactive question/approval channel routing. */
  interactive?: {
    /**
     * Which UI answers `ask_user_question`:
     * - `telegram`: Telegram owns the question card, even when the web API
     *   proxy is mounted (web profile included).
     * - `web`: yield to the web API proxy's user-questions provider.
     * - `auto`: register the Telegram provider only when no enabled web API
     *   proxy loader entry is mounted (the legacy inference).
     */
    userQuestions?: QuestionOwnership;
    /** Tool names permanently auto-allowed after the user taps
     * "Allow forever (by tool)" on an approval card. Revoke with
     * `/config set interactive.allowByTool [...]`. */
    allowByTool?: string[];
  };
  /** Long-task notifications (issue #18): goal completion push + periodic
   * liveness heartbeat while a silent tool keeps running. */
  notify?: {
    /** Send a fresh receipt message (with sound) when a goal turn finishes. */
    onComplete?: boolean;
    /** Edit the progress card every 30s so elapsed time keeps moving. */
    onLongTask?: boolean;
  };
}

export const DEFAULT_CONFIG: TelegramConfig = Object.freeze({
  security: { allowedChatIds: [] },
  watch: { autoStart: false },
  inbound: {
    defaultMode: 'auto-handle' as InboundMode,
    rules: [],
  },
  outbound: {
    parseMode: 'HTML' as const,
    disableNotification: false,
    maxRetries: 3,
    sendRatePerSecond: 20,
    maxMessageLength: 4096,
    liveFeed: true,
  },
  compact: {
    threshold: 0.8,
    policy: 'ask' as CompactionPolicy,
    cooldownMs: 5 * 60_000,
  },
  workspace: {},
  mode: { name: '' },
  reasoning: { effort: 'medium' as const },
  model: {},
  media: { transcribe: { model: 'whisper-1' } },
  interactive: { userQuestions: 'telegram' as const, allowByTool: [] },
  notify: { onComplete: true, onLongTask: true },
});

/** Config errors carry a JSON-pointer-ish path so humans can fix `.pi/telegram.json`. */
export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

const INBOUND_MODES: readonly InboundMode[] = ['auto-handle', 'queue-only', 'muted'];
const QUESTION_OWNERSHIPS: readonly QuestionOwnership[] = ['telegram', 'web', 'auto'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`${path}.${key}`, 'must be a string');
  return value;
}

function readNumber(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${path}.${key}`, 'must be a finite number');
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ConfigError(`${path}.${key}`, 'must be a boolean');
  return value;
}

function readIdArray(record: Record<string, unknown>, key: string, path: string): number[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ConfigError(`${path}.${key}`, 'must be an array of chat ids');
  return value.map((item, index) => {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      throw new ConfigError(`${path}.${key}[${index}]`, 'must be an integer chat id');
    }
    return item;
  });
}

function readStringArray(record: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ConfigError(`${path}.${key}`, 'must be an array of strings');
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${path}.${key}[${index}]`, 'must be a non-empty string');
    }
    return item.trim();
  });
}

/** Merge raw (possibly partial) user config over defaults, validating every field. */
export function normalizeConfig(raw: unknown): TelegramConfig {
  if (raw === undefined || raw === null) return cloneDefault();
  if (!isRecord(raw)) throw new ConfigError('$', 'config root must be an object');
  const base = cloneDefault();

  const security = raw['security'];
  if (security !== undefined) {
    if (!isRecord(security)) throw new ConfigError('security', 'must be an object');
    const ids = readIdArray(security, 'allowedChatIds', 'security');
    if (ids !== undefined) base.security.allowedChatIds = ids;
  }

  const watch = raw['watch'];
  if (watch !== undefined) {
    if (!isRecord(watch)) throw new ConfigError('watch', 'must be an object');
    const autoStart = readBoolean(watch, 'autoStart', 'watch');
    if (autoStart !== undefined) base.watch.autoStart = autoStart;
  }

  const inbound = raw['inbound'];
  if (inbound !== undefined) {
    if (!isRecord(inbound)) throw new ConfigError('inbound', 'must be an object');
    const mode = readString(inbound, 'defaultMode', 'inbound');
    if (mode !== undefined) {
      if (!INBOUND_MODES.includes(mode as InboundMode)) {
        throw new ConfigError('inbound.defaultMode', `must be one of ${INBOUND_MODES.join(' | ')}`);
      }
      base.inbound.defaultMode = mode as InboundMode;
    }
    const rules = inbound['rules'];
    if (rules !== undefined) {
      if (!Array.isArray(rules)) throw new ConfigError('inbound.rules', 'must be an array');
      base.inbound.rules = rules.map((rule, index) => {
        if (!isRecord(rule)) throw new ConfigError(`inbound.rules[${index}]`, 'must be an object');
        const chatId = readNumber(rule, 'chatId', `inbound.rules[${index}]`);
        if (chatId !== undefined && !Number.isInteger(chatId)) {
          throw new ConfigError(`inbound.rules[${index}].chatId`, 'must be an integer chat id');
        }
        const pattern = readString(rule, 'pattern', `inbound.rules[${index}]`);
        if (pattern !== undefined && pattern.length === 0) {
          throw new ConfigError(`inbound.rules[${index}].pattern`, 'must not be empty');
        }
        const mode = readString(rule, 'mode', `inbound.rules[${index}]`);
        if (mode === undefined || !INBOUND_MODES.includes(mode as InboundMode)) {
          throw new ConfigError(`inbound.rules[${index}].mode`, `must be one of ${INBOUND_MODES.join(' | ')}`);
        }
        return { chatId, pattern, mode: mode as InboundMode };
      });
    }
  }

  const outbound = raw['outbound'];
  if (outbound !== undefined) {
    if (!isRecord(outbound)) throw new ConfigError('outbound', 'must be an object');
    const liveFeed = readBoolean(outbound, 'liveFeed', 'outbound');
    if (liveFeed !== undefined) base.outbound.liveFeed = liveFeed;
    const parseMode = readString(outbound, 'parseMode', 'outbound');
    if (parseMode !== undefined) {
      if (parseMode !== 'HTML') throw new ConfigError('outbound.parseMode', "only 'HTML' is supported \u2014 assistant Markdown is normalized to HTML automatically");
      base.outbound.parseMode = 'HTML';
    }
    const disableNotification = readBoolean(outbound, 'disableNotification', 'outbound');
    if (disableNotification !== undefined) base.outbound.disableNotification = disableNotification;
    const maxRetries = readNumber(outbound, 'maxRetries', 'outbound');
    if (maxRetries !== undefined) {
      if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
        throw new ConfigError('outbound.maxRetries', 'must be an integer between 0 and 10');
      }
      base.outbound.maxRetries = maxRetries;
    }
    const rate = readNumber(outbound, 'sendRatePerSecond', 'outbound');
    if (rate !== undefined) {
      if (!(rate >= 1 && rate <= 30)) {
        throw new ConfigError('outbound.sendRatePerSecond', 'must be between 1 and 30');
      }
      base.outbound.sendRatePerSecond = rate;
    }
    const maxLength = readNumber(outbound, 'maxMessageLength', 'outbound');
    if (maxLength !== undefined) {
      if (!Number.isInteger(maxLength) || maxLength < 512 || maxLength > 4096) {
        throw new ConfigError('outbound.maxMessageLength', 'must be an integer between 512 and 4096');
      }
      base.outbound.maxMessageLength = maxLength;
    }
  }

  const compact = raw['compact'];
  if (compact !== undefined) {
    if (!isRecord(compact)) throw new ConfigError('compact', 'must be an object');
    const threshold = readNumber(compact, 'threshold', 'compact');
    if (threshold !== undefined) {
      if (!(threshold > 0 && threshold < 1)) throw new ConfigError('compact.threshold', 'must be between 0 and 1 (exclusive)');
      base.compact.threshold = threshold;
    }
    const policy = readString(compact, 'policy', 'compact');
    if (policy !== undefined) {
      if (!['auto', 'ask', 'never'].includes(policy)) throw new ConfigError('compact.policy', 'must be one of auto | ask | never');
      base.compact.policy = policy as CompactionPolicy;
    }
    const cooldownMs = readNumber(compact, 'cooldownMs', 'compact');
    if (cooldownMs !== undefined) {
      if (!Number.isInteger(cooldownMs) || cooldownMs < 0) throw new ConfigError('compact.cooldownMs', 'must be a non-negative integer (ms)');
      base.compact.cooldownMs = cooldownMs;
    }
  }

  const workspace = raw['workspace'];
  if (workspace !== undefined) {
    if (!isRecord(workspace)) throw new ConfigError('workspace', 'must be an object');
    const activePath = readString(workspace, 'activePath', 'workspace');
    if (activePath !== undefined) base.workspace.activePath = activePath;
  }

  const mode = raw['mode'];
  if (mode !== undefined) {
    if (!isRecord(mode)) throw new ConfigError('mode', 'must be an object');
    const name = readString(mode, 'name', 'mode');
    if (name !== undefined) base.mode!.name = name;
  }

  const reasoning = raw['reasoning'];
  if (reasoning !== undefined) {
    if (!isRecord(reasoning)) throw new ConfigError('reasoning', 'must be an object');
    const effort = readString(reasoning, 'effort', 'reasoning');
    if (effort !== undefined) {
      if (!REASONING_EFFORTS.includes(effort as never)) {
        throw new ConfigError('reasoning.effort', 'must be one of minimal | low | medium | high | max');
      }
      base.reasoning = { effort: effort as 'minimal' | 'low' | 'medium' | 'high' | 'max' };
    }
  }

  const model = raw['model'];
  if (model !== undefined) {
    if (!isRecord(model)) throw new ConfigError('model', 'must be an object');
    const provider = readString(model, 'provider', 'model');
    const name = readString(model, 'model', 'model');
    base.model = {
      ...(provider === undefined ? {} : { provider }),
      ...(name === undefined ? {} : { model: name }),
    };
  }

  const media = raw['media'];
  if (media !== undefined) {
    if (!isRecord(media)) throw new ConfigError('media', 'must be an object');
    const transcribe = media['transcribe'];
    if (transcribe !== undefined) {
      if (!isRecord(transcribe)) throw new ConfigError('media.transcribe', 'must be an object');
      const baseUrl = readString(transcribe, 'baseUrl', 'media.transcribe');
      const apiKey = readString(transcribe, 'apiKey', 'media.transcribe');
      const model = readString(transcribe, 'model', 'media.transcribe');
      base.media = {
        transcribe: {
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(model === undefined ? {} : { model }),
        },
      };
    }
  }

  const interactive = raw['interactive'];
  if (interactive !== undefined) {
    if (!isRecord(interactive)) throw new ConfigError('interactive', 'must be an object');
    const userQuestions = readString(interactive, 'userQuestions', 'interactive');
    if (userQuestions !== undefined && !QUESTION_OWNERSHIPS.includes(userQuestions as QuestionOwnership)) {
      throw new ConfigError('interactive.userQuestions', `must be one of ${QUESTION_OWNERSHIPS.join(' | ')}`);
    }
    const allowByTool = readStringArray(interactive, 'allowByTool', 'interactive');
    base.interactive = {
      userQuestions: (userQuestions ?? base.interactive!.userQuestions) as QuestionOwnership,
      allowByTool: allowByTool === undefined ? [...base.interactive!.allowByTool!] : [...new Set(allowByTool)],
    };
  }

  const notify = raw['notify'];
  if (notify !== undefined) {
    if (!isRecord(notify)) throw new ConfigError('notify', 'must be an object');
    const onComplete = readBoolean(notify, 'onComplete', 'notify');
    const onLongTask = readBoolean(notify, 'onLongTask', 'notify');
    base.notify = {
      onComplete: onComplete ?? base.notify!.onComplete,
      onLongTask: onLongTask ?? base.notify!.onLongTask,
    };
  }

  return base;
}

function cloneDefault(): TelegramConfig {
  return {
    security: { allowedChatIds: [...DEFAULT_CONFIG.security.allowedChatIds] },
    watch: { autoStart: DEFAULT_CONFIG.watch.autoStart },
    inbound: {
      defaultMode: DEFAULT_CONFIG.inbound.defaultMode,
      rules: [...DEFAULT_CONFIG.inbound.rules],
    },
    outbound: { ...DEFAULT_CONFIG.outbound },
    compact: { ...DEFAULT_CONFIG.compact },
    workspace: { ...DEFAULT_CONFIG.workspace },
    mode: { ...DEFAULT_CONFIG.mode },
    reasoning: { ...DEFAULT_CONFIG.reasoning },
    model: { ...DEFAULT_CONFIG.model },
    media: { transcribe: { ...DEFAULT_CONFIG.media!.transcribe } },
    interactive: { userQuestions: DEFAULT_CONFIG.interactive!.userQuestions, allowByTool: [...DEFAULT_CONFIG.interactive!.allowByTool!] },
    notify: { ...DEFAULT_CONFIG.notify },
  };
}

/** First matching inbound rule for (chatId, text), otherwise the default mode. */
export function resolveInboundMode(config: TelegramConfig, chatId: number, text: string): InboundMode {
  for (const rule of config.inbound.rules) {
    if (rule.chatId !== undefined && rule.chatId !== chatId) continue;
    if (rule.pattern !== undefined && !text.toLowerCase().includes(rule.pattern.toLowerCase())) continue;
    return rule.mode;
  }
  return config.inbound.defaultMode;
}

/** Whether inbound messages from this chat are accepted at all. */
export function isChatAllowed(config: TelegramConfig, chatId: number): boolean {
  return config.security.allowedChatIds.includes(chatId);
}

/** Bot token comes only from the environment; it is never persisted. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env['TELEGRAM_BOT_TOKEN'];
  if (token === undefined || token.trim() === '') return undefined;
  return token.trim();
}

/** Path of the config file for a workspace root. */
export function configFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.pi', 'telegram.json');
}

/** Read + normalize config from a workspace root; missing file returns defaults. */
export function readConfig(workspaceRoot: string): TelegramConfig {
  const file = configFilePath(workspaceRoot);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneDefault();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(file, `invalid JSON: ${(error as Error).message}`);
  }
  return normalizeConfig(parsed);
}

/** Persist config (pretty-printed) under `<root>/.pi/telegram.json`. */
export function writeConfig(workspaceRoot: string, config: TelegramConfig): string {
  const file = configFilePath(workspaceRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

export type ConfigSection = "security" | "watch" | "inbound" | "outbound" | "compact" | "mode" | "workspace" | "reasoning" | "model" | "media" | "interactive" | "notify";
const CONFIG_SECTIONS: readonly ConfigSection[] = ["security", "watch", "inbound", "outbound", "compact", "mode", "workspace", "reasoning", "model", "media", "interactive", "notify"];

/**
 * Overlay a raw loader-provided config (from `ctx.config` / `internal/update`)
 * on top of an already-normalized config. Only keys present in the raw patch
 * are touched — the rest of the running config stays untouched (hot update).
 */
export function overlayConfig(current: TelegramConfig, raw: unknown): { config: TelegramConfig; changed: ConfigSection[] } {
  if (raw === undefined || raw === null || !isRecord(raw)) return { config: current, changed: [] };
  const normalized = normalizeConfig(raw);
  const changed = CONFIG_SECTIONS.filter((section) => isRecord(raw[section]));
  const merged: TelegramConfig = { ...current };
  for (const section of changed) {
    const rawSection = raw[section] as Record<string, unknown>;
    const normalizedSection = normalized[section] as Record<string, unknown>;
    const out: Record<string, unknown> = { ...(current[section] as Record<string, unknown>) };
    for (const key of Object.keys(rawSection)) out[key] = normalizedSection[key];
    merged[section] = out as never;
  }
  return { config: merged, changed };
}

/** Read a config leaf by dot path (e.g. `outbound.sendRatePerSecond`). */
export function getConfigPath(config: TelegramConfig, path: string): unknown {
  const parts = path.split(".").filter((part) => part !== "");
  let node: unknown = config;
  for (const part of parts) {
    if (!isRecord(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Build a nested patch object from a dot path + parsed JSON value. */
export function patchFromPath(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".").filter((part) => part !== "");
  const root: Record<string, unknown> = {};
  let node = root;
  for (const part of parts.slice(0, -1)) node = node[part] = {};
  if (parts.length === 0) return root;
  node[parts[parts.length - 1]] = value;
  return root;
}
