/**
 * Media admissions beyond images (issue #9): OpenAI-compatible voice
 * transcription and durable document storage under the session directory.
 * The web attachment seam only accepts images, so documents land on disk
 * where the agent's read tool can reach them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { dshHome } from "./mode.js";
import { fail, type AdapterResult } from "./types.js";

/** Default OpenAI-compatible voice-transcription model; also the config
 * default in config.ts so both call sites share one source of truth
 * (review 🟡-6). */
export const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";

export interface TranscribeConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

interface TranscribeResponse {
  text?: string;
  error?: { message?: string };
}

export async function transcribeVoice(
  data: Uint8Array,
  filename: string,
  config: TranscribeConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResult & { transcript?: string }> {
  const apiKey = config?.apiKey ?? env["OPENAI_API_KEY"] ?? env["TELEGRAM_VOICE_API_KEY"];
  if (!apiKey) return fail("voice transcription needs an api key \u2014 /config set media.transcribe.apiKey \"<OPENAI key>\" (or set OPENAI_API_KEY)");
  const baseUrl = (config?.baseUrl ?? env["TELEGRAM_VOICE_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config?.model ?? env["TELEGRAM_VOICE_MODEL"] ?? DEFAULT_TRANSCRIBE_MODEL;
  try {
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([data as BlobPart], { type: "audio/ogg" }), basename(filename) || "voice.ogg");
    const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await response.json()) as TranscribeResponse;
    if (!response.ok) return fail(`transcription failed (${response.status}): ${payload.error?.message ?? "unknown error"}`);
    const text = payload.text?.trim() ?? "";
    if (!text) return fail("transcription returned no text");
    return { ok: true, text, transcript: text };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Store one document under `~/.dsh/sessions/<id>/attachments/<safe-name>`. */
export async function saveDocumentAttachment(sessionId: string, data: Uint8Array, filename: string, now = Date.now()): Promise<AdapterResult & { path?: string }> {
  const safe = basename(filename).replace(/[^A-Za-z0-9._\-\u4E00-\u9FFF]/g, "_").slice(0, 80) || "document.bin";
  const safeSession = sessionId.replace(/[/\\]/g, "_").slice(0, 200) || "session";
  const dir = join(dshHome(), "sessions", safeSession, "attachments");
  const path = join(dir, `${now}-${safe}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, data);
    return { ok: true, text: `\u{1F4CE} Saved ${safe} (${data.byteLength} bytes) to ${path}`, path };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
