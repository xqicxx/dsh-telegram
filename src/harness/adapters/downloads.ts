/**
 * Downloads domain (web ApiProxy downloads.sessionLog GET). Telegram cannot
 * carry files over 50 MB, so we stream the same ZIP through the web's own
 * export seam and either send it as a document or hand over the guidance.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";
import { dshHome } from "./mode.js";

export const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;
/** The ZIP is capped at 50 MB, so 120s is generous even on slow links; a
 * stalled stream must fail the command instead of hanging /sessionlog. */
const SESSION_LOG_EXPORT_TIMEOUT_MS = 120_000;

interface ExportDepsLike {
  sessionQuery?: unknown;
  sessionPersistence?: unknown;
  attachments?: unknown;
  sessions?: unknown;
}

type StreamZip = (deps: ExportDepsLike, root: unknown, sessionId: string, includeDescendants: boolean, level: number, signal: AbortSignal) => ReadableStream<Uint8Array>;

interface ExportSeam {
  streamSessionLogZip: StreamZip;
  sessionLogExportDeps(ctx: Context): ExportDepsLike;
  flushLiveSessionLog(deps: ExportDepsLike, id: string, signal: AbortSignal): Promise<void>;
}

/** Blue-7: one probe costs readdirSync + require.resolve + a dynamic import.
 * The resolution promise is cached at module level so every export after the
 * first — including concurrent calls and permanent misses (negative cache;
 * profile dependencies do not appear mid-process) — reuses that single
 * result instead of re-walking the filesystem on each /sessionlog. */
let exportSeamPromise: Promise<ExportSeam | undefined> | undefined;

async function probeExportSeam(): Promise<ExportSeam | undefined> {
  // The web session-export seam lives inside `@deepseek-ai/dsh-host-apiproxy`,
  // which is a PROFILE dependency, not a dependency of this plugin. Resolve it
  // from plausible profile roots (workspace cwd, DSH_HOME or the ~/.dsh
  // default — same fallback as mode.ts dshHome(), each profile dir)
  // instead of only this plugin's node_modules.
  const bases = new Set<string>([process.cwd()]);
  const home = dshHome();
  if (home !== "") {
    bases.add(home);
    try {
      for (const entry of readdirSync(join(home, "profiles"))) {
        bases.add(join(home, "profiles", entry));
      }
    } catch {
      /* no profiles dir */
    }
  }
  for (const base of bases) {
    try {
      const require = createRequire(join(base, "noop.js"));
      const pkg = require.resolve("@deepseek-ai/dsh-host-apiproxy/package.json");
      const moduleUrl = pathToFileURL(pkg.replace(/package\.json$/, "lib/types/session-export.js")).href;
      const seam = (await import(moduleUrl)) as ExportSeam;
      if (typeof seam.streamSessionLogZip === "function") return seam;
    } catch {
      /* try the next profile root */
    }
  }
  return undefined;
}

function loadExportSeam(): Promise<ExportSeam | undefined> {
  if (exportSeamPromise === undefined) {
    exportSeamPromise = probeExportSeam().catch(() => undefined);
  }
  return exportSeamPromise;
}

/** Oversize guidance: the web URL path and the host-side location, so a
 * >50 MB log is still reachable instead of a dead end. */
export function oversizeGuidance(sessionId: string, totalBytes: number): string {
  const mb = Math.max(1, Math.round(totalBytes / 1024 / 1024));
  return [
    `session log ZIP exceeds the 50 MB Telegram limit (${mb} MB).`,
    `Web: open the web UI \u2192 Sessions \u2192 ${sessionId} \u2192 Log download.`,
    "Host: the same archive lives under $DSH_HOME/sessions (default ~/.dsh/sessions).",
  ].join("\n");
}

export interface SessionLogExport {
  result: AdapterResult;
  buffer?: Uint8Array;
}

/** sessionLog download: same ZIP the web serves, buffered for Telegram. */
export async function exportSessionLog(ctx: Context, sessionId: string, includeDescendants: boolean): Promise<SessionLogExport> {
  const seam = await loadExportSeam();
  if (!seam) {
    return {
      result: fail(
        `session log ZIP is served by the web profile \u2014 this profile cannot build the archive. Open the web UI's session download for ${sessionId}.`,
      ),
    };
  }
  const deps = seam.sessionLogExportDeps(ctx);
  if (!deps.sessionPersistence) return { result: fail("session persistence is unavailable in this profile \u2014 the session log cannot be exported") };
  const signal = AbortSignal.timeout(SESSION_LOG_EXPORT_TIMEOUT_MS);
  try {
    await seam.flushLiveSessionLog(deps, sessionId, signal);
    const raw = await (deps.sessionPersistence as { readRaw(id: string, signal?: AbortSignal): Promise<unknown> }).readRaw(sessionId, signal);
    if (raw === undefined) return { result: fail(`session ${sessionId} not found`) };
    const stream = seam.streamSessionLogZip(deps, raw, sessionId, includeDescendants, 6, signal);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let readResult: { done: boolean; value?: Uint8Array };
      try {
        readResult = await reader.read();
      } catch (err) {
        void reader.cancel().catch(() => {});
        if (signal.aborted) throw new Error(`session log ZIP export timed out after ${Math.round(SESSION_LOG_EXPORT_TIMEOUT_MS / 1000)}s`);
        throw err;
      }
      const { done, value } = readResult;
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > TELEGRAM_DOCUMENT_LIMIT_BYTES) {
          void reader.cancel().catch(() => {});
          return { result: fail(oversizeGuidance(sessionId, total)) };
        }
        chunks.push(value);
      }
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { result: ok(`\u{1F4E6} ${sessionId}.zip \u00B7 ${Math.round(buffer.byteLength / 1024)} KB`), buffer };
  } catch (err) {
    return { result: fail(err instanceof Error ? err.message : String(err)) };
  }
}
