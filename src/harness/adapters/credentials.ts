/**
 * Credentials domain (web ApiProxy credentials.describe/set/unset) over
 * ctx.credentials. Values never ride back — describe only reports
 * configured/source/writable, exactly like the web.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface CredentialView {
  ref: string;
  configured: boolean;
  source?: string;
  writable: boolean;
}

/** POSIX shell identifier — refs are used verbatim as credential-store /
 * env-file keys, so every entry point (describe/set/unset) enforces the same
 * shape (RG-4). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface CredentialProviderLike {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  /** Optional enumeration seam (web keeps credentials non-enumerable, but a
   * host may expose the ref roster so UIs can offer one-tap describe). */
  list?(): readonly string[] | Promise<readonly string[]>;
}

function credentialsOf(ctx: Context): CredentialProviderLike | undefined {
  return ctx.get("credentials") as CredentialProviderLike | undefined;
}

export async function describeCredential(ctx: Context, ref: string): Promise<AdapterResult & { view?: CredentialView }> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  if (!REF_PATTERN.test(ref)) return fail("credential ref must be a POSIX shell identifier");
  try {
    const info = await credentials.describe(ref);
    return {
      ok: true,
      text: `\u{1F511} ${ref}: ${info.configured ? `configured (${info.source ?? "unknown source"})` : "not configured"} \u00B7 writable: ${info.writable}`,
      view: { ref, ...info },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** credentials.describe batch: web accepts up to 64 refs; Telegram mirrors
 * that by fanning out the single-ref host seam and combining the views. */
export async function describeCredentials(ctx: Context, refs: readonly string[]): Promise<AdapterResult & { views?: CredentialView[] }> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  const unique = [...new Set(refs.map((ref) => ref.trim()).filter((ref) => ref !== ""))];
  if (unique.length === 0) return fail("usage: /credential <REF> [REF...]");
  if (unique.length > 64) return fail("at most 64 credential refs per request (web contract)");
  const invalid = unique.find((ref) => !REF_PATTERN.test(ref));
  if (invalid !== undefined) return fail(`credential ref must be a POSIX shell identifier: ${invalid}`);
  try {
    const views = await Promise.all(
      unique.map(async (ref) => {
        const info = await credentials.describe(ref);
        return { ref, ...info };
      }),
    );
    const text = views
      .map((view) => `\u{1F511} ${view.ref}: ${view.configured ? `configured (${view.source ?? "unknown source"})` : "not configured"} \u00B7 writable: ${view.writable}`)
      .join("\n");
    return { ok: true, text, views };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Enumerate the credential refs this host exposes (empty without the
 * optional seam — values never ride back either way). */
export async function listCredentialRefs(ctx: Context): Promise<string[]> {
  const credentials = credentialsOf(ctx);
  if (!credentials || typeof credentials.list !== "function") return [];
  try {
    const refs = await credentials.list();
    return [...new Set(refs.map((ref) => String(ref)))].sort();
  } catch {
    return [];
  }
}

export async function setCredential(ctx: Context, ref: string, value: string): Promise<AdapterResult> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  if (!REF_PATTERN.test(ref)) return fail("credential ref must be a POSIX shell identifier");
  if (!value) return fail("credential value must not be empty (use unset to remove)");
  try {
    await credentials.set(ref, value);
    return ok(`\u{1F511} ${ref} stored \u2014 the value itself never rides back`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function unsetCredential(ctx: Context, ref: string): Promise<AdapterResult> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  // RG-4: set/describe validate the ref shape; unset must not accept what the
  // others would have rejected (an invalid ref could never have been stored).
  if (!REF_PATTERN.test(ref)) return fail("credential ref must be a POSIX shell identifier");
  try {
    await credentials.unset(ref);
    return ok(`\u{1F511} ${ref} removed`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
