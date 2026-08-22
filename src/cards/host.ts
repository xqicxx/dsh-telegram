/**
 * Host-domain cards for dsh-telegram.
 *
 * Host settings namespaces (openHostSettingsCard), one namespace's document
 * view (openSettingsNamespaceCard), the credential ref roster
 * (openCredentialsCard), the host overview (openHostCard) and the
 * breadcrumb host directory browser (openHostDirectoryCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { TelegramConfig } from "../config.js";
import { describeSettings } from "../harness/adapters/settings.js";
import { listCredentialRefs } from "../harness/adapters/credentials.js";
import { breadcrumbSegments, describeHost, listDirectory, parentOf } from "../harness/adapters/host.js";
import { plain, truncate } from "../telegram/html.js";
import { buildCredentialsKeyboard, buildHostKeyboard, buildProjectKeyboard, buildSettingsKeyboard } from "../telegram/keyboard.js";
import type { OpenCard } from "../core/cards.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface HostCardsStateSlice {
  /** Active project root (host card cwd context). */
  readonly workspaceRoot: string;
  /** Live config — security.browseRoots gates every directory listing. */
  readonly config: TelegramConfig;
}

export interface HostCardsDeps {
  state: HostCardsStateSlice;
  requireCtx(): Context;
  openCard: OpenCard;
  token(payload: Record<string, string>, chatId?: number): string;
}

/** Build the host-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createHostCards(deps: HostCardsDeps): {
  openHostSettingsCard(chatId: number): Promise<void>;
  openSettingsNamespaceCard(chatId: number, ns: string): Promise<void>;
  openCredentialsCard(chatId: number): Promise<void>;
  openHostCard(chatId: number): Promise<void>;
  openHostDirectoryCard(chatId: number, path: string, page?: number): Promise<void>;
} {
  const { state, requireCtx, openCard, token } = deps;

  async function openHostSettingsCard(chatId: number): Promise<void> {
    const { writable, hasDocument, documentPath, namespaces, internalNamespaces } = describeSettings(requireCtx());
    const lines = [`\u2699\uFE0F Host settings \u00B7 writable: ${writable} \u00B7 document: ${hasDocument ? plain(truncate(documentPath ?? "yes", 48)) : "none"}`, ""];
    for (const ns of namespaces.slice(0, 15)) {
      const secrets = ns.secrets.filter((secret) => secret.set).length;
      lines.push(`\u2022 ${plain(truncate(ns.ns, 36))} \u00B7 applies: ${plain(ns.applies)} \u00B7 rev ${ns.revision} \u00B7 secrets set: ${secrets}`);
    }
    if (namespaces.length === 0) lines.push("No settings namespaces registered.");
    if (internalNamespaces.length > 0) {
      lines.push("", `Outside the web boundary (not listed): ${internalNamespaces.slice(0, 8).map(plain).join(", ")}${internalNamespaces.length > 8 ? "\u2026" : ""}`);
    }
    lines.push("", "Describe: /settingsdescribe [ns] \u00B7 Update: /settingsupdate &lt;ns&gt; &lt;json patch&gt;");
    await openCard(chatId, lines.join("\n"), buildSettingsKeyboard(namespaces.map((ns) => ns.ns)));
  }

  async function openSettingsNamespaceCard(chatId: number, ns: string): Promise<void> {
    const { namespaces } = describeSettings(requireCtx());
    const view = namespaces.find((candidate) => candidate.ns === ns);
    if (!view) return openHostSettingsCard(chatId);
    const lines = [
      `\u2699\uFE0F ${plain(truncate(ns, 40))}`,
      "",
      `applies: ${plain(view.applies)} \u00B7 revision: ${view.revision}`,
      view.schema !== undefined ? `schema: ${plain(truncate(JSON.stringify(view.schema), 300))}` : "schema: (not declared)",
      // RF-3: the settings contract types value as unknown (undefined allowed);
      // JSON.stringify(undefined) returns undefined and truncate would crash
      // reading .length, so render null like every other JSON line.
      `value: ${plain(truncate(JSON.stringify(view.value ?? null), 300))}`,
      view.user !== undefined ? `user: ${plain(truncate(JSON.stringify(view.user), 200))}` : "",
      `secrets: ${view.secrets.map((secret) => `${plain(secret.path.join("."))}=${secret.set ? "set" : "unset"}`).join(", ") || "none"}`,
    ].filter((line) => line !== "");
    await openCard(chatId, lines.join("\n"), buildSettingsKeyboard([ns]));
  }

  async function openCredentialsCard(chatId: number): Promise<void> {
    const refs = await listCredentialRefs(requireCtx());
    const lines = [
      "\u{1F511} Credentials",
      "",
      "Describe: /credential &lt;REF&gt; [REF...] (configured/source/writable, value never shown)",
      "Set: /credentialset &lt;REF&gt; &lt;value&gt; \u00B7 Unset: /credentialunset &lt;REF&gt;",
      "",
      refs.length > 0 ? `Available refs (${refs.length}) \u2014 tap to describe:` : "This host exposes no ref roster (credentials are non-enumerable here).",
      ...refs.slice(0, 12).map((ref) => `\u2022 ${plain(ref)}`),
      refs.length > 12 ? `\u2026 +${refs.length - 12}` : "",
      "",
      "The secret value never rides back \u2014 same as the web form.",
    ].filter((line) => line !== "");
    await openCard(chatId, lines.join("\n"), buildCredentialsKeyboard(refs.slice(0, 12).map((ref) => ({ ref, cb: token({ action: "credential-show", ref }, chatId) }))));
  }

  async function openHostCard(chatId: number): Promise<void> {
    // No hardcoded version: the host version comes from the hostInfo seam or
    // DSH_VERSION; when the profile exposes neither, say so instead of showing
    // a bridge-owned number (the bridge version lives in About).
    const host = describeHost(requireCtx(), state.workspaceRoot);
    const lines = [
      "\u{1F5A5} Host",
      "",
      `version: ${host.version ? plain(host.version) : "unknown (not exposed to plugins)"} \u00B7 cwd: ${plain(truncate(host.cwd, 40))}`,
      `model default: ${host.provider ? `${plain(host.provider)}/` : ""}${host.model ? plain(host.model) : "default"}`,
      `attached sessions: ${host.attachedSessions} \u00B7 canOpenPath: ${host.canOpenPath}`,
      "",
      "Browse: pick a folder below \u00B7 Text: /ls [path] \u00B7 Mkdir: /mkdir &lt;path&gt;",
    ];
    await openCard(chatId, lines.join("\n"), buildHostKeyboard());
  }

  const HOST_BROWSE_PAGE_SIZE = 20;

  /** Telegram-native host.listDirectory: clickable breadcrumb browsing instead
   * of a raw `/ls` dump. Directories are buttons; files are only counted so a
   * large folder never overflows the callback keyboard. */
  async function openHostDirectoryCard(chatId: number, path: string, page = 0): Promise<void> {
    const target = resolve(path);
    const res = await listDirectory(target, state.config.security.browseRoots);
    const dirs = (res.entries ?? []).filter((entry) => entry.kind === "directory");
    const files = (res.entries ?? []).length - dirs.length;
    const totalPages = Math.max(1, Math.ceil(dirs.length / HOST_BROWSE_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageDirs = dirs.slice(safe * HOST_BROWSE_PAGE_SIZE, (safe + 1) * HOST_BROWSE_PAGE_SIZE);
    const lines = [
      res.ok ? `\u{1F4C2} ${plain(truncate(target, 80))}` : `\u274C ${plain(truncate(target, 80))}`,
      "",
      res.ok
        ? `${dirs.length} dirs \u00B7 ${files} files \u00B7 page ${safe + 1}/${totalPages}`
        : `Cannot list this path: ${plain(res.text)}`,
      "",
    ];
    if (res.ok && pageDirs.length === 0) lines.push("(this directory contains files only)");
    // Breadcrumb: every ancestor up to the current directory is one tap.
    const crumbs = breadcrumbSegments(target);
    if (res.ok && crumbs.length > 1) {
      const shown = crumbs.length > 3 ? [{ label: "\u2026", path: crumbs[crumbs.length - 3]!.path }, ...crumbs.slice(-2)] : crumbs.slice(0, -1);
      lines.splice(2, 0, shown.map((crumb) => plain(crumb.label)).join(" \u203A "));
    }
    await openCard(chatId, lines.join("\n"), buildProjectKeyboard(
      pageDirs.map((entry) => ({ label: entry.name, cb: token({ action: "host-open", path: join(target, entry.name) }, chatId) })),
      {
        up: token({ action: "host-open", path: parentOf(target) }, chatId),
        home: token({ action: "host-open", path: homedir() }, chatId),
        root: token({ action: "host-open", path: parse(target).root }, chatId),
        breadcrumb: (res.ok && crumbs.length > 1 ? (crumbs.length > 3 ? [{ label: "\u2026", path: crumbs[crumbs.length - 3]!.path }, ...crumbs.slice(-2)] : crumbs.slice(0, -1)) : []).map(
          (crumb) => ({ label: crumb.label, cb: token({ action: "host-open", path: crumb.path }, chatId) }),
        ),
        paging: [
          ...(safe > 0 ? [{ text: "\u2039 Prev", cb: token({ action: "host-page", path: target, page: String(safe - 1) }, chatId) }] : []),
          ...(safe + 1 < totalPages ? [{ text: "More \u203A", cb: token({ action: "host-page", path: target, page: String(safe + 1) }, chatId) }] : []),
        ],
        newFolder: token({ action: "host-mkdir-prompt", path: target }, chatId),
        close: "m:host",
      },
    ));
  }

  return { openHostSettingsCard, openSettingsNamespaceCard, openCredentialsCard, openHostCard, openHostDirectoryCard };
}
