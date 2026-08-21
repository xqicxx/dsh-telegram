/**
 * Settings domain (web ApiProxy settings.describe/openDocument/update/replace/
 * mutate) over ctx.settings. Secrets stay redacted, same as the web.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface SettingsNamespaceView {
  ns: string;
  /** Serialized schemastery envelope, when the registrant declared one. */
  schema?: unknown;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets: { path: string[]; set: boolean }[];
  revision: number;
}

export interface SettingsDescription {
  writable: boolean;
  hasDocument: boolean;
  documentPath?: string;
  namespaces: SettingsNamespaceView[];
  /** Namespaces the registrant marked outside the web boundary
   * (`exposed: false`) — filtered out of `namespaces`, listed here so the UI
   * can say what exists but is not web-addressable. */
  internalNamespaces: string[];
  error?: string;
}

interface SettingsDescriptorLike {
  ns: string;
  /** Web boundary marker: `false` = the web ApiProxy does not expose this
   * namespace (internal bookkeeping); absent = exposed like every other. */
  exposed?: boolean;
  schema?: unknown;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets?: { path: string[]; set: boolean }[];
  revision?: number;
}

interface SettingsProviderLike {
  writable?: boolean;
  documentPath?: string;
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>;
  mutate(ns: string, ops: readonly { op: "set" | "unset"; path: string[]; value?: unknown }[], expectedRevision?: number): Promise<void>;
}

function settingsOf(ctx: Context): SettingsProviderLike | undefined {
  return ctx.get("settings") as SettingsProviderLike | undefined;
}

/** Split a Telegram command argument of the form `<json> [expectedRevision]`
 * without disturbing whitespace inside JSON string values: full JSON first,
 * then a backwards scan for a trailing integer after the closing token. */
export function parseJsonWithRevision(raw: string): { json: string; revision?: number } | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    JSON.parse(trimmed);
    return { json: trimmed };
  } catch {
    /* try the optional revision suffix below */
  }
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(trimmed[index]!)) continue;
    const head = trimmed.slice(0, index).trimEnd();
    const tail = trimmed.slice(index).trim();
    if (!/^\d+$/.test(tail)) continue;
    try {
      JSON.parse(head);
      return { json: head, revision: Number(tail) };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function describeSettings(ctx: Context): SettingsDescription {
  const settings = settingsOf(ctx);
  if (!settings) return { writable: false, hasDocument: false, namespaces: [], internalNamespaces: [] };
  try {
    const descriptors = settings.describe({ redactSecrets: true });
    const internalNamespaces = descriptors.filter((d) => d.exposed === false).map((d) => String(d.ns));
    return {
      writable: settings.writable ?? true,
      hasDocument: settings.documentPath !== undefined,
      ...(settings.documentPath === undefined ? {} : { documentPath: settings.documentPath }),
      namespaces: descriptors.filter((descriptor) => descriptor.exposed !== false).map((descriptor) => ({
        ns: String(descriptor.ns),
        ...(descriptor.schema === undefined ? {} : { schema: descriptor.schema }),
        value: descriptor.value,
        ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
        ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
        applies: descriptor.applies,
        secrets: descriptor.secrets ?? [],
        revision: descriptor.revision ?? 0,
      })),
      internalNamespaces,
    };
  } catch (err) {
    return { writable: false, hasDocument: false, namespaces: [], internalNamespaces: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateSettings(ctx: Context, ns: string, patch: object, expectedRevision?: number): Promise<AdapterResult & { view?: SettingsNamespaceView }> {
  const settings = settingsOf(ctx);
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.update(ns, patch, expectedRevision);
    const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
    return { ok: true, text: `\u2699\uFE0F ${ns} updated`, ...(view === undefined ? {} : { view }) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function replaceSettings(ctx: Context, ns: string, section: object, expectedRevision?: number): Promise<AdapterResult & { view?: SettingsNamespaceView }> {
  const settings = settingsOf(ctx);
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.replace(ns, section, expectedRevision);
    const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
    return { ok: true, text: `\u2699\uFE0F ${ns} replaced`, ...(view === undefined ? {} : { view }) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function mutateSettings(
  ctx: Context,
  ns: string,
  ops: { op: "set" | "unset"; path: string[]; value?: unknown }[],
  expectedRevision?: number,
): Promise<AdapterResult & { view?: SettingsNamespaceView }> {
  const settings = settingsOf(ctx);
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.mutate(ns, ops, expectedRevision);
    const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
    return { ok: true, text: `\u2699\uFE0F ${ns} mutated`, ...(view === undefined ? {} : { view }) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
