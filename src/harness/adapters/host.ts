/**
 * Host domain (web ApiProxy host.describe/listDirectory/createDirectory/
 * openPath/pickDirectory) over process facts and the filesystem. Native
 * dialogs and platform openers do not exist on a phone, so those two degrade
 * to path-based flows with the same data.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

/** Node's fs.promises typings in this profile predate `signal`; the timeout
 * race gives the same bounded behaviour for readdir/stat/mkdir (LOOP_AUDIT #3). */
const FS_TIMEOUT_MS = 10_000;

function withFsTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`filesystem operation timed out after ${FS_TIMEOUT_MS}ms`);
        err.name = "AbortError";
        reject(err);
      }, FS_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface HostView {
  /** The real host version when the profile exposes one; never a guessed or
   * bridge-owned number (the bridge version lives in About). */
  version?: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}

/** Best-effort host version discovery: an explicit `hostInfo` seam first,
 * then the launcher's DSH_VERSION env. Plugins cannot see the host package
 * version, so absence is reported as `undefined` instead of a fake number. */
export function hostVersionOf(ctx: Context, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const info = ctx.get("hostInfo") as { version?: unknown } | undefined;
  if (info && typeof info.version === "string" && info.version.trim() !== "") return info.version;
  const fromEnv = env.DSH_VERSION;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return undefined;
}

export function describeHost(
  ctx: Context,
  activeCwd: string = process.cwd(),
  version: string | undefined = hostVersionOf(ctx),
): HostView {
  // Same source as web host.describe and session.create's fallback: the
  // saved default selection is what the NEXT session will start from.
  const selection = (
    ctx.get("agentDefaultModel") as { currentSelection(): { provider: string; model: string } } | undefined
  )?.currentSelection();
  const agent = ctx.agents?.list()[0];
  return {
    version,
    cwd: activeCwd,
    provider: selection?.provider ?? agent?.options.provider,
    model: selection?.model ?? agent?.options.model,
    attachedSessions: ctx.agents?.list().length ?? 0,
    canOpenPath: false,
  };
}

export async function listDirectory(path: string): Promise<AdapterResult & { entries?: { name: string; kind: "file" | "directory"; size?: number }[] }> {
  try {
    const target = resolve(path);
    // Bad disks/NFS can hang readdir/stat forever and wedge the UI lane;
    // degrade to an error card after 10s instead (LOOP_AUDIT #3).
    const names = await withFsTimeout(readdir(target));
    const entries = await Promise.all(
      names.slice(0, 200).map(async (name) => {
        try {
          const info = await withFsTimeout(stat(join(target, name)));
          return { name, kind: (info.isDirectory() ? "directory" : "file") as "file" | "directory", ...(info.isFile() ? { size: info.size } : {}) };
        } catch {
          return { name, kind: "file" as const };
        }
      }),
    );
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    const lines = entries.map((entry) => `${entry.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"} ${entry.name}${entry.size === undefined ? "" : ` (${entry.size} B)`}`);
    return { ok: true, text: `\u{1F4C2} ${target}\n${lines.join("\n").slice(0, 3500)}`, entries };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return fail(`directory listing timed out after 10s: ${path}`);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Breadcrumb segments for host.listDirectory navigation: root first, then
 * every ancestor up to and including the path itself. */
export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const abs = resolve(path);
  const root = parse(abs).root;
  const segments: { label: string; path: string }[] = [{ label: "/", path: root }];
  let current = root;
  for (const part of abs.slice(root.length).split(/[/\\]+/).filter(Boolean)) {
    current = join(current, part);
    segments.push({ label: part, path: current });
  }
  return segments;
}

/** True only when the path exists and resolves to a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await withFsTimeout(stat(resolve(path)));
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function createDirectory(path: string): Promise<AdapterResult> {
  try {
    await withFsTimeout(mkdir(resolve(path), { recursive: false }));
    return ok(`\u{1F4C1} Created ${path}`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return fail(`directory creation timed out after 10s: ${path}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** host.openPath: a phone cannot open a host file — return the resolved path. */
export function openPath(path: string): AdapterResult {
  try {
    return ok(`\u{1F4C2} ${resolve(path)} \u2014 open it on the host (a phone client cannot launch host apps).`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** host.pickDirectory: native picker unavailable — prompt for a text path. */
export function pickDirectoryHint(current: string): AdapterResult {
  return ok(`\u{1F4C1} Native directory picker is unavailable on Telegram \u2014 reply with the path (current: ${current}) or use /mkdir.`);
}

export function parentOf(path: string): string {
  return dirname(resolve(path));
}
