/**
 * LLM domain (web ApiProxy llm.providers/models/discoverModels + the catalog
 * shape behind session.models) over ctx.llm.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface ModelEntry {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  };
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelEntry[];
}

export interface ModelCatalog {
  groups: ModelGroup[];
  failures: { provider: string; message: string }[];
  current: { provider?: string; model?: string; reasoningEffort?: string };
  /** Web SessionModels.routable: whether an adapter currently serves the
   * selected provider (no llm registry = cannot judge, so report true). */
  routable: boolean;
}

/** One llm.providers row: the web also reports where the provider is
 * configured (settingsNs/settingsPath), whether an adapter is currently
 * mounted (active), and whether the provider was declared by settings
 * (declared) as opposed to discovered at runtime. */
export interface ProviderEntry {
  id: string;
  name: string;
  settingsNs?: string;
  settingsPath?: string;
  active?: boolean;
  declared?: boolean;
}

export interface ProviderCatalog {
  providers: ProviderEntry[];
  failures: { provider: string; message: string }[];
}

interface LlmLike {
  listProviders(): { id: string; name: string; settingsNs?: string; settingsPath?: string; active?: boolean; declared?: boolean }[];
  listModels(provider: string): Promise<{ id: string; name: string; description?: string }[]>;
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string };
  }>;
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string; signal?: AbortSignal },
  ): Promise<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }[]>;
}

function llmOf(ctx: Context): LlmLike | undefined {
  return ctx.get("llm") as LlmLike | undefined;
}

/** Model discovery dials a draft baseURL; a hung endpoint must not suspend
 * Telegram command processing forever (the request used to carry no signal).
 * Same race shape as host.ts's withFsTimeout; the signal is also passed so
 * fetch-based adapters abort their connection immediately. Matches media.ts's
 * transcription budget. */
const DISCOVER_TIMEOUT_MS = 60_000;

/** Build the web's exact model catalog shape (groups + failures + routable). */
export async function modelCatalog(ctx: Context, current?: { provider?: string; model?: string; reasoningEffort?: string }): Promise<ModelCatalog> {
  const llm = llmOf(ctx);
  if (!llm) return { groups: [], failures: [], current: current ?? {}, routable: true };
  const providers = llm.listProviders();
  // Two-level fan-out (providers × models), matching models.ts: both loops
  // used to await one entry at a time, so a slow adapter serialized the whole
  // catalog. Promise.all gathers positionally, so group/failure order still
  // follows listProviders() regardless of completion order.
  const settled = await Promise.all(
    providers.map(async (provider): Promise<{ group?: ModelGroup; failure?: { provider: string; message: string } }> => {
      try {
        const models = await llm.listModels(provider.id);
        const entries = await Promise.all(
          models.map(async (model): Promise<ModelEntry> => {
            let reasoning: ModelEntry["reasoning"];
            try {
              const resolved = await llm.resolveModelInfo(provider.id, model.id);
              reasoning = resolved.reasoning;
            } catch {
              /* offline adapter must not hide the rest of the catalog */
            }
            return {
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(reasoning === undefined ? {} : { reasoning }),
            };
          }),
        );
        return { group: { id: provider.id, name: provider.name, models: entries } };
      } catch (err) {
        return { failure: { provider: provider.id, message: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );
  const groups: ModelGroup[] = settled.flatMap((entry) => (entry.group === undefined ? [] : [entry.group]));
  const failures = settled.flatMap((entry) => (entry.failure === undefined ? [] : [entry.failure]));
  return {
    groups,
    failures,
    current: current ?? {},
    routable: current?.provider === undefined || providers.some((entry) => entry.id === current.provider),
  };
}

/** llm.providers: the provider roster with deployment facts, failures kept
 * separate so one broken registration never hides the rest. */
export async function providerCatalog(ctx: Context): Promise<ProviderCatalog> {
  const llm = llmOf(ctx);
  if (!llm) return { providers: [], failures: [] };
  try {
    return {
      providers: llm.listProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        ...(provider.settingsNs === undefined ? {} : { settingsNs: provider.settingsNs }),
        ...(provider.settingsPath === undefined ? {} : { settingsPath: provider.settingsPath }),
        ...(provider.active === undefined ? {} : { active: provider.active }),
        ...(provider.declared === undefined ? {} : { declared: provider.declared }),
      })),
      failures: [],
    };
  } catch (err) {
    return { providers: [], failures: [{ provider: "*", message: err instanceof Error ? err.message : String(err) }] };
  }
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** llm.discoverModels: interrogate a draft endpoint, never storing the key. */
export async function discoverModels(
  ctx: Context,
  settingsNs: string,
  request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
): Promise<AdapterResult & { models?: DiscoveredModel[] }> {
  const llm = llmOf(ctx);
  if (!llm) return fail("llm service is unavailable in this profile");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      llm.discoverModels(settingsNs, { ...request, signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`model discovery timed out after ${DISCOVER_TIMEOUT_MS}ms`)), DISCOVER_TIMEOUT_MS);
      }),
    ]);
    const lines = models.map((model) => `${model.id}${model.name === undefined ? "" : ` \u00B7 ${model.name}`}${model.contextWindow === undefined ? "" : ` \u00B7 ctx ${model.contextWindow}`}`);
    return { ok: true, text: `\u{1F50D} ${models.length} model(s) discovered:\n${lines.join("\n").slice(0, 3500)}`, models };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
