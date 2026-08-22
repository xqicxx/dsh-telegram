import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSessionLog, TELEGRAM_DOCUMENT_LIMIT_BYTES } from '../dist/harness/adapters/downloads.js';

test('Telegram document limit is exactly the Bot API 50 MB bound', () => {
  assert.equal(TELEGRAM_DOCUMENT_LIMIT_BYTES, 50 * 1024 * 1024);
});

test('exportSessionLog degrades with web guidance when the export seam is absent', async () => {
  // Hermetic on every host: even where ~/.dsh really carries the web
  // profile's apiproxy package, DSH_HOME points at an empty dir here so the
  // probe must fail closed with guidance instead of throwing. (The adapter
  // falls back to the default home when DSH_HOME is unset — mode.ts
  // dshHome() — so deleting the env var alone is not enough to hide a real
  // default home.)
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-downloads-'));
  mkdirSync(join(base, 'profiles'), { recursive: true });
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const res = await exportSessionLog({ get: () => undefined }, 'session-1', false);
    assert.equal(res.result.ok, false);
    assert.match(res.result.text, /web UI/);
    assert.equal(res.buffer, undefined);

    // Module-level negative cache: a repeat resolution in the same process
    // stays fail-closed and never re-throws, instead of re-probing the
    // filesystem (readdir + resolve + import) on every /sessionlog call.
    const again = await exportSessionLog({ get: () => undefined }, 'session-2', true);
    assert.equal(again.result.ok, false);
    assert.match(again.result.text, /web UI/);
    assert.equal(again.buffer, undefined);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(base, { recursive: true, force: true });
  }
});
