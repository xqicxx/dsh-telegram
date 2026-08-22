import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDocumentAttachment, transcribeVoice } from '../dist/harness/adapters/media.js';
import { makeAttachmentHandlers } from '../dist/media/attachments.js';

test('transcribeVoice posts multipart form data to an OpenAI-compatible endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body, signal: init.signal });
    return new Response(JSON.stringify({ text: '  hello from voice  ' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = await transcribeVoice(new Uint8Array([1, 2, 3]), 'voice.ogg', { baseUrl: 'https://example.test/v1/', apiKey: 'key', model: 'whisper-1' }, {}, fetchImpl);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hello from voice');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/audio/transcriptions');
  assert.equal(calls[0].headers.Authorization, 'Bearer key');
  assert.ok(calls[0].body instanceof FormData);
  assert.ok(calls[0].signal instanceof AbortSignal, 'transcription fetch is bounded by an abort timeout');
});

test('transcribeVoice degrades cleanly without a key and on provider errors', async () => {
  const missing = await transcribeVoice(new Uint8Array([1]), 'voice.ogg', {}, {}, async () => new Response('{}'));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /api key/);

  const failing = await transcribeVoice(
    new Uint8Array([1]),
    'voice.ogg',
    { apiKey: 'k' },
    {},
    async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
  );
  assert.equal(failing.ok, false);
  assert.match(failing.text, /401/);
  assert.match(failing.text, /bad key/);
});

test('saveDocumentAttachment stores bytes under the session attachments directory', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-media-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const res = await saveDocumentAttachment('session-a', new Uint8Array([9, 9, 9]), '../../notes-中文.txt', 1234);
    assert.equal(res.ok, true);
    assert.match(res.path, /\/session-a\/attachments\/1234-notes/);
    assert.equal(existsSync(res.path), true);
    assert.deepEqual(await readFile(res.path), Buffer.from([9, 9, 9]));
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(base, { recursive: true, force: true });
  }
});

function attachmentDeps({ failSaveOnCall = 0 } = {}) {
  const sent = [];
  const deliveries = [];
  const barSyncs = [];
  const agent = { id: 'agent-1' };
  let saveCalls = 0;
  const deps = {
    state: {
      chats: new Set([100]),
      workspaceRoot: '/tmp/ws',
      config: {},
      bridge: {
        deliverImages: (chatId, attachments, caption, messageId) => {
          deliveries.push({ chatId, attachments, caption, messageId });
          return { ok: true, text: 'Images delivered.' };
        },
      },
    },
    requireTransport: () => ({ downloadFile: async () => new Uint8Array([1, 2, 3]) }),
    requireCtx: () => ({
      get: (name) => (name === 'attachments'
        ? {
            saveImage: async (input) => {
              saveCalls += 1;
              if (failSaveOnCall > 0 && saveCalls === failSaveOnCall) throw new Error('admission rejected');
              return { attachmentId: `att-${saveCalls}`, mediaType: 'image/jpeg', bytes: input.data.byteLength, width: 1, height: 1 };
            },
          }
        : undefined),
    }),
    uiSend: async (chatId, text) => {
      sent.push({ chatId, text });
      return 42;
    },
    currentAgent: () => agent,
    createSessionForChat: async () => { throw new Error('should not create a session'); },
    bindCreatedSession: () => false,
    scheduleBarSync: (chatId, delayMs) => { barSyncs.push({ chatId, delayMs }); },
  };
  return { deps, sent, deliveries, barSyncs };
}

test('dispatchPhotos delivers a fully-saved media group as one turn', async () => {
  const { deps, sent, deliveries, barSyncs } = attachmentDeps();
  const handlers = makeAttachmentHandlers(deps);
  await handlers.dispatchPhotos(100, [
    { fileId: 'f1', caption: '' },
    { fileId: 'f2', caption: 'look' },
    { fileId: 'f3', caption: '' },
  ]);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].attachments.map((a) => a.attachmentId), ['att-1', 'att-2', 'att-3']);
  assert.equal(deliveries[0].caption, 'look');
  assert.match(sent[0].text, /3 images/);
  assert.deepEqual(barSyncs, [{ chatId: 100, delayMs: 0 }]);
});

test('dispatchPhotos surfaces already-saved refs when a later photo fails to save', async () => {
  const { deps, sent, deliveries } = attachmentDeps({ failSaveOnCall: 2 });
  const handlers = makeAttachmentHandlers(deps);
  await handlers.dispatchPhotos(100, [
    { fileId: 'f1', caption: '' },
    { fileId: 'f2', caption: '' },
    { fileId: 'f3', caption: '' },
  ]);
  // Nothing was delivered: the failed batch must not enqueue a partial turn.
  assert.equal(deliveries.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /admission rejected/);
  // The first photo was already committed before the second failed — its ref
  // is surfaced so it stays reachable instead of becoming a silent orphan.
  assert.match(sent[0].text, /att-1/);
  assert.doesNotMatch(sent[0].text, /att-2/);
});
