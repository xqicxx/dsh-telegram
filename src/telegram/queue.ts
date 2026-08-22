/**
 * Outbound send pipeline: per-chat FIFO serialization plus a global sliding
 * window rate limit (Telegram caps a bot at ~30 messages/second globally and
 * ~1/second per chat). Retries honor `retry_after` for 429 responses.
 *
 * Nothing here blocks the dsh agent loop: callers always get a promise, and
 * every operation is queued fire-and-forget style.
 */

import { serializePerKey } from "./serialize-per-key.js";

/** Retry base delay used wherever a consumer does not configure one
 * explicitly (audit R3-3: the default literal lives in exactly one place). */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

export interface QueueOptions {
  /** Max sends allowed per window. */
  maxPerWindow?: number;
  /** Window length in ms. */
  windowMs?: number;
  retry?: { attempts: number; baseDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RetryLike {
  error_code?: number;
  parameters?: { retry_after?: number };
}

function isRateLimited(err: unknown): err is RetryLike {
  return typeof err === "object" && err !== null && (err as RetryLike).error_code === 429;
}

function retryAfterMs(err: unknown): number | undefined {
  if (!isRateLimited(err)) return undefined;
  const seconds = err.parameters?.retry_after;
  return typeof seconds === "number" ? seconds * 1000 : undefined;
}

/** Only transient failures deserve a retry. A Telegram error code tells us
 * authoritatively: 429 (rate limit) and 5xx are transient, every other 4xx is
 * a permanent payload/permission problem that a retry can never fix. Without
 * an error code we retry only recognizable transport failures (network
 * TypeError or our own API timeout), never arbitrary Errors. */
function isRetryable(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    const code = (err as { error_code?: unknown }).error_code;
    if (typeof code === "number") return code === 429 || code >= 500;
    if ((err as { name?: unknown }).name === "AbortError") return false;
  }
  if (err instanceof TypeError) return true;
  return err instanceof Error && err.message.startsWith("telegram api timeout after ");
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class SendQueue {
  private maxPerWindow: number;
  private windowMs: number;
  private retryAttempts: number;
  private retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private readonly stamps: number[] = [];
  private readonly chains = new Map<number | string, Promise<unknown>>();
  private queued = 0;
  private active = 0;

  constructor(options: QueueOptions = {}) {
    // `takeSlot` spins until `stamps.length < maxPerWindow`; a non-positive
    // window/budget would make that condition mathematically unreachable.
    // Clamp here so a misconfigured queue degrades instead of hanging forever.
    this.maxPerWindow = positiveNumber(options.maxPerWindow, 20);
    this.windowMs = positiveNumber(options.windowMs, 1000);
    this.retryAttempts = nonNegativeNumber(options.retry?.attempts, 3);
    this.retryBaseDelayMs = nonNegativeNumber(options.retry?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Hot-update the limiter while in-flight sends keep flowing. */
  configure(options: QueueOptions): void {
    if (options.maxPerWindow !== undefined) this.maxPerWindow = positiveNumber(options.maxPerWindow, this.maxPerWindow);
    if (options.windowMs !== undefined) this.windowMs = positiveNumber(options.windowMs, this.windowMs);
    if (options.retry?.attempts !== undefined) this.retryAttempts = nonNegativeNumber(options.retry.attempts, this.retryAttempts);
    if (options.retry?.baseDelayMs !== undefined) this.retryBaseDelayMs = nonNegativeNumber(options.retry.baseDelayMs, this.retryBaseDelayMs);
  }

  /** Wait until the global sliding window admits one more send. */
  async takeSlot(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
      if (this.stamps.length < this.maxPerWindow) {
        this.stamps.push(this.now());
        return;
      }
      await this.sleep(Math.max(1, this.stamps[0]! + this.windowMs - this.now()));
    }
  }

  /** Serialize per chat, then rate-limit globally, then run with retries. */
  push<T>(key: number | string, fn: () => Promise<T>): Promise<T> {
    this.queued += 1;
    return serializePerKey(this.chains, key, () => this.execute(fn));
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.queued -= 1;
    this.active += 1;
    let attempt = 0;
    try {
      for (;;) {
        await this.takeSlot();
        try {
          return await fn();
        } catch (err) {
          attempt += 1;
          if (attempt > this.retryAttempts || !isRetryable(err)) throw err;
          const delay = retryAfterMs(err) ?? this.retryBaseDelayMs * 2 ** (attempt - 1);
          await this.sleep(Math.min(delay, 30_000));
        }
      }
    } finally {
      this.active -= 1;
    }
  }

  /** Ops not yet started plus ops in flight. */
  pendingCount(): number {
    return this.queued + this.active;
  }
}
