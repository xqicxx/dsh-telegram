/**
 * opencode-go compatibility shim.
 *
 * The Go-tier gateway serves `gpt-5.6-luna` and `grok-4.5` through the
 * OpenAI **Responses** API, but pi-ai's installed opencode-go catalog routes
 * them through `chat/completions`, whose stream terminates with a bare
 * `{"choices":[]}` chunk and no `finish_reason` — every turn fails with
 * `TRANSPORT / Stream ended without finish_reason`.
 *
 * This module provisions one additive `opencode-go-responses` route in the
 * `llm-pi-ai` settings section (same api key, `/zen/go/v1/responses`,
 * cache retention disabled so no stateful session headers are sent) and
 * transparently repoints selections of the affected models to that route.
 */
import type { Context } from "@deepseek-ai/cordis";

export const OPENCODE_GO_RESPONSES_ROUTE = "opencode-go-responses";

/** Models the Go gateway only serves through the Responses API. */
const GO_RESPONSES_MODEL_IDS = new Set(["gpt-5.6-luna", "grok-4.5"]);

const GO_RESPONSES_MODEL_FACTS: Record<string, {
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: string[];
}> = {
  "gpt-5.6-luna": {
    name: "GPT 5.6 Luna",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    input: ["text", "image"],
  },
  "grok-4.5": {
    name: "Grok 4.5",
    contextWindow: 500_000,
    maxTokens: 500_000,
    input: ["text", "image"],
  },
};

interface SettingsLike {
  writable?: boolean;
  describe(options?: { redactSecrets?: boolean }): { ns: string; value: unknown; revision?: number }[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}

let provisioning: Promise<boolean> | undefined;

/** Map a model selection onto the Go Responses route when it is affected. */
export function normalizeOpencodeGoModel(provider: string | undefined, model: string | undefined): { provider: string; model: string } {
  if (provider === "opencode-go" && model !== undefined && GO_RESPONSES_MODEL_IDS.has(model)) {
    return { provider: OPENCODE_GO_RESPONSES_ROUTE, model };
  }
  return { provider: provider ?? "", model: model ?? "" };
}

/** Whether the model needs the Responses-route rewrite. */
export function opencodeGoModelUsesResponses(provider: string | undefined, model: string | undefined): boolean {
  return provider === "opencode-go" && model !== undefined && GO_RESPONSES_MODEL_IDS.has(model);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function adapterProviders(ctx: Context): string[] {
  const llm = ctx.get("llm") as { listProviders?(): { id: string }[] } | undefined;
  try {
    return (llm?.listProviders?.() ?? []).map((entry) => entry.id);
  } catch {
    return [];
  }
}

/** Provision the route and wait until the llm registry actually advertises it. */
async function provisionOnce(ctx: Context, log: (message: string, error?: unknown) => void): Promise<boolean> {
  const settings = ctx.get("settings") as SettingsLike | undefined;
  if (settings === undefined || settings.writable === false) {
    log(`skipped ${OPENCODE_GO_RESPONSES_ROUTE} provisioning: settings service is unavailable or read-only`);
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A throwing settings service must degrade probing to a clean no-op, not
    // reject the shared provisioning promise for every later model selection.
    let descriptor: { ns: string; value: unknown; revision?: number } | undefined;
    try {
      descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === "llm-pi-ai");
    } catch (err) {
      log(`skipped ${OPENCODE_GO_RESPONSES_ROUTE} provisioning: settings.describe failed`, err);
      return false;
    }
    if (descriptor === undefined) return false;
    const value = (descriptor.value ?? {}) as { providers?: Record<string, { apiKeyEnv?: string }> };
    const providers = value.providers ?? {};
    if (providers[OPENCODE_GO_RESPONSES_ROUTE] !== undefined) {
      if (adapterProviders(ctx).includes(OPENCODE_GO_RESPONSES_ROUTE)) return true;
      log(`${OPENCODE_GO_RESPONSES_ROUTE} exists in settings but the llm registry has not picked it up yet; retrying`);
      await sleep(300);
      continue;
    }
    const goRoute: unknown = (providers as Record<string, unknown>)["opencode-go"];
    if (goRoute === undefined) {
      log(`skipped ${OPENCODE_GO_RESPONSES_ROUTE} provisioning: no opencode-go provider is configured`);
      return false;
    }
    // RG-2: settings values are arbitrary user JSON — a null/scalar route
    // must degrade to the module's own clean skip instead of throwing a
    // TypeError out of provisionOnce past every degradation seam.
    if (typeof goRoute !== "object" || goRoute === null) {
      log(`skipped ${OPENCODE_GO_RESPONSES_ROUTE} provisioning: the opencode-go provider setting is malformed`);
      return false;
    }
    const patch = {
      providers: {
        [OPENCODE_GO_RESPONSES_ROUTE]: {
          apiKeyEnv: (goRoute as { apiKeyEnv?: string }).apiKeyEnv ?? "OPENCODE_GO_API_KEY",
          api: "openai-responses",
          baseURL: "https://opencode.ai/zen/go/v1",
          // The Go gateway does not maintain stateful Responses sessions;
          // disabling cache retention keeps `session_id` headers off the wire.
          cacheRetention: "none",
          models: Object.entries(GO_RESPONSES_MODEL_FACTS).map(([id, facts]) => ({
            id,
            name: facts.name,
            contextWindow: facts.contextWindow,
            maxTokens: facts.maxTokens,
            input: facts.input,
          })),
        },
      },
    };
    try {
      await settings.update("llm-pi-ai", patch, descriptor.revision);
      log(`provisioned ${OPENCODE_GO_RESPONSES_ROUTE} route for opencode-go Responses models`);
      await sleep(300);
    } catch (err) {
      log(`failed to provision ${OPENCODE_GO_RESPONSES_ROUTE} route (attempt ${attempt + 1}/3)`, err);
      await sleep(300);
    }
  }
  return adapterProviders(ctx).includes(OPENCODE_GO_RESPONSES_ROUTE);
}

/** Idempotently add the additive Responses route and wait for adapter
 * registration. Safe to call from model selection: it blocks until the route
 * is actually usable or a bounded retry budget is exhausted. The singleton
 * itself is also bounded (LOOP_AUDIT #7): a hung settings.update must never
 * make every later model selection await the same stuck promise. */
const PROVISION_DEADLINE_MS = 15_000;

export function ensureOpencodeGoResponsesRoute(ctx: Context, log: (message: string, error?: unknown) => void): Promise<boolean> {
  if (provisioning !== undefined) return provisioning;
  provisioning = (async () => {
    if (ctx.get("llm") === undefined) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provisionOnce(ctx, log),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            log(`skipped ${OPENCODE_GO_RESPONSES_ROUTE} provisioning: deadline exceeded after ${PROVISION_DEADLINE_MS}ms`);
            resolve(false);
          }, PROVISION_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  // Clear the singleton on BOTH outcomes (the old success-only clear left a
  // rejected probe pinned forever). The two-arg then keeps this bookkeeping
  // chain handled, so no unhandled rejection is raised here; callers still
  // receive the original outcome through the returned promise.
  void provisioning.then(
    () => {
      provisioning = undefined;
    },
    () => {
      provisioning = undefined;
    },
  );
  return provisioning;
}
