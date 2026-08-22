/**
 * Agent-preset cards for dsh-telegram.
 *
 * The preset picker chain: the new-session preset chooser (web
 * session.create's agentPreset), the presets roster (openPresetsCard) and the
 * per-preset action sheet (openPresetDetailCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { listAgentPresets } from "../harness/adapters/presets.js";
import { plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin } from "../telegram/ui.js";
import { buildNewSessionKeyboard, buildPresetDetailKeyboard, buildPresetsKeyboard } from "../telegram/keyboard.js";
import type { CardLoad, OpenCard } from "../core/cards.js";

export interface PresetCardsDeps {
  requireCtx(): Context;
  currentAgent(chatId?: number): Agent | undefined;
  cardLoad: CardLoad;
  openCard: OpenCard;
  token(payload: Record<string, string>): string;
}

/** Build the preset-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createPresetCards(deps: PresetCardsDeps): {
  openNewSessionCard(chatId: number): Promise<void>;
  openPresetsCard(chatId: number): Promise<void>;
  openPresetDetailCard(chatId: number, presetId: string): Promise<void>;
} {
  const { requireCtx, currentAgent, cardLoad, openCard, token } = deps;

  /** New-session preset picker (web session.create's agentPreset): use the
   * roster's default preset with one tap, or pick a specific preset. Profiles
   * without presets fall straight through to creation. */
  async function openNewSessionCard(chatId: number): Promise<void> {
    const presetsView = await cardLoad(chatId, "agent presets", () => listAgentPresets(requireCtx()));
    if (presetsView === undefined) return;
    const { presets } = presetsView;
    const lines = [
      headerLine("\u2728", "New session"),
      "",
      presets.length > 0
        ? "Compose the session from a preset, or use the roster default:"
        : "This profile composes no agent presets \u2014 the new session uses the profile default.",
      "",
      ...presets.slice(0, 12).map((preset) => `${preset.isDefault ? "\u2B50" : "\u2022"} ${bold(preset.id)}${preset.isDefault ? " \u00B7 default" : ""}`),
    ];
    await openCard(chatId, lines.join("\n"), buildNewSessionKeyboard(
      token({ action: "new-default" }),
      presets.slice(0, 12).map((preset) => ({ id: preset.id, isDefault: preset.isDefault, cb: token({ action: "preset-new", presetId: preset.id }) })),
    ));
  }

  async function openPresetsCard(chatId: number): Promise<void> {
    const presetsView = await cardLoad(chatId, "agent presets", () => listAgentPresets(requireCtx()));
    if (presetsView === undefined) return;
    const { presets, authorable, hasDocument } = presetsView;
    const lines = [
      headerLine("\u{1F3AD}", "Agent presets", `${presets.length}`, `authorable ${authorable ? "yes" : "no"}`, `document ${hasDocument ? "yes" : "no"}`),
      "",
    ];
    for (const preset of presets.slice(0, 20)) {
      const flags = [preset.trust, ...(preset.broken ? ["\u26A0\uFE0F broken"] : [])];
      lines.push(metaJoin(`${preset.isDefault ? "\u2B50" : "\u2022"} ${bold(preset.id)}`, ...flags));
      if (preset.description) lines.push(`  ${plain(truncate(preset.description, 60))}`);
    }
    if (presets.length === 0) lines.push("This profile composes no agent presets.");
    const rows = presets.slice(0, 12).map((preset) => ({ id: preset.id, cb: token({ action: "preset", presetId: preset.id }) }));
    await openCard(chatId, lines.join("\n"), buildPresetsKeyboard(rows), () => openPresetsCard(chatId));
  }

  async function openPresetDetailCard(chatId: number, presetId: string): Promise<void> {
    const agent = currentAgent(chatId);
    const lines = [
      headerLine("\u{1F3AD}", truncate(presetId, 40)),
      "",
      "Blank session: applies in place. Started session: forks it, applies the preset to the fork, and closes the original.",
    ];
    const callbacks = {
      select: token({ action: "preset-select", presetId, sessionId: agent?.id ?? "" }),
      read: token({ action: "preset-read", presetId }),
      create: token({ action: "preset-new", presetId }),
      copy: token({ action: "preset-copy", presetId }),
      remove: token({ action: "preset-remove", presetId }),
      open: token({ action: "preset-open", presetId }),
      default: token({ action: "preset-default", presetId }),
    };
    await openCard(chatId, lines.join("\n"), buildPresetDetailKeyboard(callbacks));
  }

  return { openNewSessionCard, openPresetsCard, openPresetDetailCard };
}
