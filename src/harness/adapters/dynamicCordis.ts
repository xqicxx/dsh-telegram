/**
 * Dynamic Cordis domain: the web exposes 12 dynamicCordisRunner methods. The
 * read-only inventory predates issue #50; Telegram now also mirrors the
 * lifecycle half (define / run / stop / undefine) so a user can install their
 * own plugin — for example a decode plugin backed by their own model — and
 * activate it straight from the phone. Client-half activation still flows
 * through the standard approval channel, exactly like the web panel.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface DynamicCordisRow {
  pluginId: string;
  packageId?: string;
  status?: string;
  [key: string]: unknown;
}

/** User-supplied definition for one immutable Package (issue #50). */
export interface DynamicCordisDefineInput {
  /** Package label. */
  name: string;
  /** User-facing purpose. */
  purpose: string;
  /** Host-half source (JS program). Optional; at least one half is required. */
  host?: string;
  /** Client-half source (browser program). Optional. */
  client?: string;
}

export interface DynamicCordisResult {
  ok: boolean;
  text: string;
}

interface DynamicCordisInventoryPackageLike {
  packageId?: string;
  name?: string;
}

interface DynamicCordisRunnerLike {
  inventory(): Array<{
    pluginId?: string;
    agentId?: string;
    packages?: readonly DynamicCordisInventoryPackageLike[];
    currentPackageId?: string;
    nextPackageId?: string;
    activeRun?: { pluginRunId?: string; packageId?: string } | null;
    [key: string]: unknown;
  }>;
}

interface DynamicCordisLifecycleRunnerLike extends DynamicCordisRunnerLike {
  define(request: {
    sessionId: string;
    plugin: { kind: "new"; idPrefix: string } | { kind: "existing"; pluginId: string };
    name: string;
    purpose: string;
    code: { host?: string; client?: string };
  }): { pluginId: string; packageId: string; name: string; hasHostHalf?: boolean; hasClientHalf?: boolean };
  run(
    agent: unknown,
    pluginId: string,
    packageId: string,
    mode: "run" | "update",
    signal?: AbortSignal,
  ): Promise<{ ok: true; status: string } | { ok: false; message: string }>;
  stop(agent: unknown, pluginId: string): Promise<{ ok: true } | { ok: false; message: string }>;
  undefine(agent: unknown, pluginId: string): Promise<{ ok: boolean; stoppedActiveRun?: boolean; message?: string }>;
}

function runnerOf(ctx: Context): DynamicCordisLifecycleRunnerLike | undefined {
  return ctx.get("dynamicCordisRunner") as DynamicCordisLifecycleRunnerLike | undefined;
}

export function listDynamicCordis(ctx: Context): DynamicCordisRow[] {
  const runner = runnerOf(ctx);
  if (!runner) return [];
  try {
    return runner.inventory()
      .filter((row) => typeof row.pluginId === "string" && row.pluginId !== "")
      .map((row) => ({ ...row, pluginId: String(row.pluginId) }));
  } catch {
    return [];
  }
}

function fail(text: string): DynamicCordisResult {
  return { ok: false, text };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Define a new dynamic Plugin's first Package (or append to an existing one
 * when `pluginId` is given). Mirrors web define semantics: the request is
 * session-scoped and returns Host-minted identities.
 */
export async function defineDynamicCordis(
  ctx: Context,
  agentId: string,
  input: DynamicCordisDefineInput,
  existingPluginId?: string,
): Promise<DynamicCordisResult & { pluginId?: string; packageId?: string }> {
  const runner = runnerOf(ctx);
  if (!runner?.define) return fail("dynamicCordisRunner service is not available in this profile.");
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  if (!name) return fail("Plugin name must not be blank.");
  if (!purpose) return fail("Plugin purpose must not be blank.");
  const host = typeof input.host === "string" ? input.host : undefined;
  const client = typeof input.client === "string" ? input.client : undefined;
  if ((host === undefined || host.trim() === "") && (client === undefined || client.trim() === "")) {
    return fail('At least one source half is required: {"host": "..."} or {"client": "..."}.');
  }
  try {
    const receipt = runner.define({
      sessionId: agentId,
      plugin: existingPluginId ? { kind: "existing", pluginId: existingPluginId } : { kind: "new", idPrefix: name },
      name,
      purpose,
      code: { ...(host !== undefined && host.trim() !== "" ? { host } : {}), ...(client !== undefined && client.trim() !== "" ? { client } : {}) },
    });
    const halves = [
      receipt.hasHostHalf === false ? undefined : "host",
      receipt.hasClientHalf ? "client" : undefined,
    ].filter(Boolean);
    return {
      ok: true,
      text: `Defined ${receipt.name} → plugin ${receipt.pluginId} · package ${receipt.packageId} (${halves.join("+")} half).`,
      pluginId: receipt.pluginId,
      packageId: receipt.packageId,
    };
  } catch (err) {
    return fail(`Define failed: ${describeError(err)}`);
  }
}

/** Newest known package for a plugin. Prefering the last-defined version is
 * what makes "define a v2 via /pluginadd, tap ▶ Run" activate that v2; the
 * transition lands as an update when it differs from the current activation. */
function latestPackageOf(runner: DynamicCordisRunnerLike, pluginId: string): string | undefined {
  try {
    const row = runner.inventory().find((candidate) => String(candidate.pluginId) === pluginId);
    if (!row) return undefined;
    const packages = row.packages ?? [];
    return packages.at(-1)?.packageId ?? row.nextPackageId ?? row.currentPackageId;
  } catch {
    return undefined;
  }
}

/**
 * Activate (or update to) a Package. With no explicit packageId the latest
 * known version is used. An unauthorized Client half parks in approval — the
 * interactive card flow settles it, same as the web.
 */
export async function runDynamicPlugin(
  ctx: Context,
  agent: unknown,
  pluginId: string,
  packageId?: string,
): Promise<DynamicCordisResult> {
  const runner = runnerOf(ctx);
  if (!runner?.run) return fail("dynamicCordisRunner service is not available in this profile.");
  const target = packageId ?? latestPackageOf(runner, pluginId);
  if (!target) return fail(`No package found for plugin ${pluginId} — define one first (/pluginadd).`);
  let mode: "run" | "update" = "run";
  try {
    const row = runner.inventory().find((candidate) => String(candidate.pluginId) === pluginId);
    if (row?.currentPackageId !== undefined && String(row.currentPackageId) !== target) mode = "update";
  } catch {
    // Inventory read failure keeps the safe default ('run').
  }
  try {
    const response = await runner.run(agent, pluginId, target, mode);
    if (!response.ok) return fail(`Run failed (${response.message})`);
    if (response.status === "awaiting-approval") return { ok: true, text: `Activation awaiting your approval — watch for the approval card.` };
    if (response.status === "starting") return { ok: true, text: `Activation starting — the client half is loading.` };
    return { ok: true, text: `Running ${pluginId} @ ${target}.` };
  } catch (err) {
    return fail(`Run failed: ${describeError(err)}`);
  }
}

/** Stop the active run while keeping every immutable version. */
export async function stopDynamicPlugin(ctx: Context, agent: unknown, pluginId: string): Promise<DynamicCordisResult> {
  const runner = runnerOf(ctx);
  if (!runner?.stop) return fail("dynamicCordisRunner service is not available in this profile.");
  try {
    const response = await runner.stop(agent, pluginId);
    return response.ok
      ? { ok: true, text: `Stopped ${pluginId} (versions retained).` }
      : fail(`Stop failed (${response.message})`);
  } catch (err) {
    return fail(`Stop failed: ${describeError(err)}`);
  }
}

/** Remove a Plugin, its active run, and all Packages. Irreversible. */
export async function undefineDynamicPlugin(ctx: Context, agent: unknown, pluginId: string): Promise<DynamicCordisResult> {
  const runner = runnerOf(ctx);
  if (!runner?.undefine) return fail("dynamicCordisRunner service is not available in this profile.");
  try {
    const receipt = await runner.undefine(agent, pluginId);
    return receipt.ok
      ? { ok: true, text: `Removed ${pluginId}${receipt.stoppedActiveRun ? " (active run stopped)" : ""}.` }
      : fail(`Remove failed (${receipt.message ?? "unknown reason"})`);
  } catch (err) {
    return fail(`Remove failed: ${describeError(err)}`);
  }
}
