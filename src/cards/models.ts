/**
 * Models / providers / reasoning-effort cards for dsh-telegram.
 *
 * The model picker chain: catalog overview (openModelsCard), per-provider
 * deployment facts (openProvidersCard), paginated per-provider model list
 * with the current selection (openProviderModelsCard) and the per-session
 * reasoning-effort picker (openModelThinkingCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TelegramConfig } from "../config.js";
import { REASONING_DEFAULT, REASONING_EFFORTS, isReasoningEffort, reasoningLabel } from "../reasoning.js";
import { currentSessionModel } from "../harness/adapters/sessions.js";
import { modelCatalog, providerCatalog } from "../harness/adapters/llm.js";
import { plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin, mono } from "../telegram/ui.js";
import { buildModelDetailKeyboard, buildModelsKeyboard, buildProvidersKeyboard, buildThinkingKeyboard } from "../telegram/keyboard.js";
import type { CardLoad, OpenCard } from "../core/cards.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface ModelCardsStateSlice {
  /** Live config (reasoning-effort default). */
  readonly config: TelegramConfig;
}

export interface ModelCardsDeps {
  state: ModelCardsStateSlice;
  requireCtx(): Context;
  currentAgent(chatId?: number): Agent | undefined;
  cardLoad: CardLoad;
  openCard: OpenCard;
  token(payload: Record<string, string>, chatId?: number): string;
  log(message: string, error?: unknown): void;
}

/** Build the model-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createModelCards(deps: ModelCardsDeps): {
  openModelsCard(chatId: number): Promise<void>;
  openProvidersCard(chatId: number): Promise<void>;
  openProviderModelsCard(chatId: number, providerId: string, page?: number): Promise<void>;
  openModelThinkingCard(chatId: number, providerId: string, modelId: string): Promise<void>;
  currentReasoningEffort(): "minimal" | "low" | "medium" | "high" | "max";
} {
  const { state, requireCtx, currentAgent, cardLoad, openCard, token, log } = deps;

  const MODELS_PAGE_SIZE = 12;

  async function openModelsCard(chatId: number): Promise<void> {
    const ctx = requireCtx();
    const agent = currentAgent(chatId);
    const current = agent ? currentSessionModel(ctx, agent.id) : {};
    const catalog = await cardLoad(chatId, "model catalog", () => modelCatalog(ctx, current));
    if (catalog === undefined) return;
    // Design language: bold header with the live selection in mono, provider
    // groups bold with mono model ids indented beneath.
    const currentModel = current.provider !== undefined || current.model !== undefined
      ? mono(`${current.provider !== undefined ? `${current.provider}/` : ""}${current.model ?? "default"}`)
      : undefined;
    const lines = [
      headerLine(
        "\u{1F9E9}",
        "Models",
        currentModel,
        current.reasoningEffort !== undefined ? mono(current.reasoningEffort) : undefined,
        catalog.routable ? undefined : "\u26A0\uFE0F not routable",
      ),
      "",
    ];
    for (const group of catalog.groups) {
      lines.push(`\u2022 ${bold(group.name)} ${mono(group.id)}`);
      for (const model of group.models.slice(0, 12)) lines.push(`  \u2212 ${mono(truncate(model.id, 40))}`);
      if (group.models.length > 12) lines.push(`  \u2026 +${group.models.length - 12}`);
    }
    for (const failure of catalog.failures) lines.push(`\u26A0\uFE0F ${plain(failure.provider)}: ${plain(failure.message)}`);
    lines.push("", "Tap a provider to switch the current session's model.");
    log(`models card: groups=${catalog.groups.map((g) => g.id).join(",")} failures=${catalog.failures.length}`);
    await openCard(chatId, lines.join("\n"), buildModelsKeyboard(catalog.groups, "m:providers", current.provider));
  }

  /** Standalone Providers view (llm.providers): deployment facts per provider
   * \u2014 where it is configured (settingsNs/settingsPath), whether an adapter is
   * mounted (active), and whether settings declared it (declared). */
  async function openProvidersCard(chatId: number): Promise<void> {
    const catalog = await cardLoad(chatId, "llm providers", () => providerCatalog(requireCtx()));
    if (catalog === undefined) return;
    const lines = [headerLine("\u{1F6F0}\uFE0F", "Providers", `${catalog.providers.length}`), ""];
    for (const provider of catalog.providers.slice(0, 20)) {
      lines.push(`\u2022 ${bold(provider.id)} \u00B7 ${plain(provider.name)}`);
      lines.push(
        metaJoin(
          `  settings ${mono(provider.settingsNs ?? "\u2014")}${provider.settingsPath !== undefined ? ` (${plain(truncate(provider.settingsPath, 40))})` : ""}`,
          `active ${provider.active === undefined ? "\u2014" : provider.active ? "yes" : "no"}`,
          `declared ${provider.declared === undefined ? "\u2014" : provider.declared ? "yes" : "no"}`,
        ),
      );
    }
    if (catalog.providers.length === 0) lines.push("No providers registered in the llm registry.");
    for (const failure of catalog.failures) lines.push(`\u26A0\uFE0F ${plain(failure.provider)}: ${plain(failure.message)}`);
    await openCard(chatId, lines.join("\n"), buildProvidersKeyboard(
      catalog.providers.slice(0, 20).map((provider) => ({
        label: `\u{1F4E1} ${provider.name}`,
        cb: token({ action: "provider", provider: provider.id }, chatId),
      })),
    ));
  }

  async function openProviderModelsCard(chatId: number, providerId: string, page = 0): Promise<void> {
    const ctx = requireCtx();
    const agent = currentAgent(chatId);
    const current = agent ? currentSessionModel(ctx, agent.id) : {};
    const catalog = await cardLoad(chatId, "model catalog", () => modelCatalog(ctx, current));
    if (catalog === undefined) return;
    const group = catalog.groups.find((candidate) => candidate.id === providerId);
    log(`provider card requested=${providerId} groups=${catalog.groups.map((g) => g.id).join(",")} found=${group !== undefined}`);
    if (!group) return openModelsCard(chatId);
    const totalPages = Math.max(1, Math.ceil(group.models.length / MODELS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageModels = group.models.slice(safe * MODELS_PAGE_SIZE, (safe + 1) * MODELS_PAGE_SIZE);
    const lines = [
      headerLine("\u{1F4E1}", truncate(group.name, 30), `page ${safe + 1}/${totalPages}`),
      "",
      metaJoin(
        "current",
        current.provider === providerId ? mono(current.model ?? "default") : "other provider",
      ),
      "",
    ];
    const models = pageModels.map((model) => ({
      id: model.id,
      name: model.name,
      cb: token({ action: "model-select", provider: providerId, model: model.id }, chatId),
    }));
    for (const model of models) {
      const selected = current.provider === providerId && current.model === model.id;
      lines.push(`${selected ? "\u2705" : "\u25CB"} ${mono(truncate(model.id, 40))}`);
      if (model.name !== model.id) lines.push(`   ${plain(truncate(model.name, 40))}`);
    }
    const selectedModel = current.provider === providerId && current.model !== undefined ? current.model : undefined;
    await openCard(chatId, lines.join("\n"), buildModelDetailKeyboard(
      models,
      selectedModel === undefined
        ? undefined
        : {
            label: reasoningLabel(isReasoningEffort(current.reasoningEffort) ? current.reasoningEffort : currentReasoningEffort()),
            cb: token({ action: "model-thinking", provider: providerId, model: selectedModel }, chatId),
          },
      {
        ...(safe > 0 ? { previous: token({ action: "model-page", provider: providerId, page: String(safe - 1) }, chatId) } : {}),
        ...(safe + 1 < totalPages ? { next: token({ action: "model-page", provider: providerId, page: String(safe + 1) }, chatId) } : {}),
      },
    ));
  }

  /** Current reasoning effort from the live config (default medium). */
  function currentReasoningEffort(): "minimal" | "low" | "medium" | "high" | "max" {
    const effort = state.config.reasoning?.effort;
    return effort !== undefined && isReasoningEffort(effort) ? effort : REASONING_DEFAULT;
  }

  /** Per-session reasoning picker for the selected model (web selectModel). */
  async function openModelThinkingCard(chatId: number, providerId: string, modelId: string): Promise<void> {
    const agent = currentAgent(chatId);
    const current = agent ? currentSessionModel(requireCtx(), agent.id) : {};
    const active = isReasoningEffort(current.reasoningEffort) ? current.reasoningEffort : currentReasoningEffort();
    const options = REASONING_EFFORTS.map((effort) => ({
      id: effort,
      name: reasoningLabel(effort),
      cb: token({ action: "model-effort", provider: providerId, model: modelId, effort }, chatId),
    }));
    await openCard(chatId, headerLine("\u{1F9E0}", "Thinking effort", mono(`${providerId}/${modelId}`)), buildThinkingKeyboard(options, active));
  }

  return { openModelsCard, openProvidersCard, openProviderModelsCard, openModelThinkingCard, currentReasoningEffort };
}
