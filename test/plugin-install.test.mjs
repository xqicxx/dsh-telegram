import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listDynamicCordis,
  defineDynamicCordis,
  runDynamicPlugin,
  stopDynamicPlugin,
  undefineDynamicPlugin,
} from '../dist/harness/adapters/dynamicCordis.js';
import { buildPluginLifecycleKeyboard } from '../dist/telegram/keyboard.js';

function makeRunner(overrides = {}) {
  const calls = { define: [], run: [], stop: [], undefine: [] };
  const runner = {
    calls,
    inventory: () => [
      {
        pluginId: 'plg-my-decoder',
        agentId: 'agent-1',
        packages: [{ packageId: 'pkg-1', name: 'v1' }, { packageId: 'pkg-2', name: 'v2' }],
        currentPackageId: 'pkg-1',
        activeRun: { pluginRunId: 'run-1', packageId: 'pkg-1' },
      },
    ],
    define: (request) => {
      calls.define.push(request);
      return { pluginId: 'plg-my-decoder', packageId: 'pkg-9', name: request.name, hasHostHalf: true, hasClientHalf: false };
    },
    run: async (agent, pluginId, packageId, mode) => {
      calls.run.push({ agent, pluginId, packageId, mode });
      return { ok: true, status: 'running' };
    },
    stop: async (agent, pluginId) => {
      calls.stop.push({ agent, pluginId });
      return { ok: true };
    },
    undefine: async (agent, pluginId) => {
      calls.undefine.push({ agent, pluginId });
      return { ok: true, stoppedActiveRun: true };
    },
    ...overrides,
  };
  return runner;
}

const ctxWith = (runner) => ({ get: (name) => (name === 'dynamicCordisRunner' ? runner : undefined) });

test('defineDynamicCordis posts a session-scoped new-plugin request and reports the receipt', async () => {
  const runner = makeRunner();
  const res = await defineDynamicCordis(ctxWith(runner), 'agent-1', {
    name: 'my-decoder',
    purpose: 'decode with my own model',
    host: '// js',
  });
  assert.equal(res.ok, true, res.text);
  assert.equal(res.pluginId, 'plg-my-decoder');
  assert.equal(res.packageId, 'pkg-9');
  assert.deepEqual(runner.calls.define, [{
    sessionId: 'agent-1',
    plugin: { kind: 'new', idPrefix: 'my-decoder' },
    name: 'my-decoder',
    purpose: 'decode with my own model',
    code: { host: '// js' },
  }]);
  assert.match(res.text, /Defined my-decoder/);
});

test('defineDynamicCordis appends to an existing plugin via pluginId', async () => {
  const runner = makeRunner();
  await defineDynamicCordis(ctxWith(runner), 'agent-1', { name: 'v2', purpose: 'next', client: '// browser' }, 'plg-existing');
  assert.deepEqual(runner.calls.define[0].plugin, { kind: 'existing', pluginId: 'plg-existing' });
  assert.deepEqual(runner.calls.define[0].code, { client: '// browser' });
});

test('defineDynamicCordis validates name, purpose, and at-least-one-half', async () => {
  const runner = makeRunner();
  const ctx = ctxWith(runner);
  assert.match((await defineDynamicCordis(ctx, 'a', { name: ' ', purpose: 'p', host: 'x' })).text, /name must not be blank/);
  assert.match((await defineDynamicCordis(ctx, 'a', { name: 'n', purpose: '', host: 'x' })).text, /purpose must not be blank/);
  assert.match((await defineDynamicCordis(ctx, 'a', { name: 'n', purpose: 'p' })).text, /At least one source half/);
  assert.match((await defineDynamicCordis(ctx, 'a', { name: 'n', purpose: 'p', host: '   ' })).text, /At least one source half/);
  assert.equal(runner.calls.define.length, 0, 'rejected inputs must not reach the runner');
});

test('plugin lifecycle degrades cleanly when the runner service is absent', async () => {
  const ctx = { get: () => undefined };
  assert.match((await defineDynamicCordis(ctx, 'a', { name: 'n', purpose: 'p', host: 'x' })).text, /not available/);
  assert.match((await runDynamicPlugin(ctx, {}, 'plg')).text, /not available/);
  assert.match((await stopDynamicPlugin(ctx, {}, 'plg')).text, /not available/);
  assert.match((await undefineDynamicPlugin(ctx, {}, 'plg')).text, /not available/);
});

test('runDynamicPlugin defaults to the newest package and upgrades mode when versions differ', async () => {
  const runner = makeRunner();
  const agent = { id: 'agent-1' };

  // No explicit package: inventory current is pkg-1 → target falls back to
  // last-known pkg-2 which differs from current → 'update'.
  const updated = await runDynamicPlugin(ctxWith(runner), agent, 'plg-my-decoder');
  assert.equal(updated.ok, true, updated.text);
  assert.deepEqual(runner.calls.run.at(-1), { agent, pluginId: 'plg-my-decoder', packageId: 'pkg-2', mode: 'update' });

  // Explicit current package id → plain 'run'.
  await runDynamicPlugin(ctxWith(runner), agent, 'plg-my-decoder', 'pkg-1');
  assert.equal(runner.calls.run.at(-1).mode, 'run');
});

test('runDynamicPlugin surfaces approval/starting statuses and failures', async () => {
  const awaiting = makeRunner({ run: async () => ({ ok: true, status: 'awaiting-approval' }) });
  assert.match((await runDynamicPlugin(ctxWith(awaiting), {}, 'plg-my-decoder')).text, /awaiting your approval/);

  const starting = makeRunner({ run: async () => ({ ok: true, status: 'starting' }) });
  assert.match((await runDynamicPlugin(ctxWith(starting), {}, 'plg-my-decoder')).text, /starting/);

  const refused = makeRunner({ run: async () => ({ ok: false, message: 'transition-in-flight' }) });
  assert.match((await runDynamicPlugin(ctxWith(refused), {}, 'plg-my-decoder')).text, /transition-in-flight/);

  const throwing = makeRunner({ run: async () => { throw new Error('boom'); } });
  assert.match((await runDynamicPlugin(ctxWith(throwing), {}, 'plg-my-decoder')).text, /boom/);

  assert.match((await runDynamicPlugin(ctxWith(makeRunner({ inventory: () => [] })), {}, 'plg-ghost')).text, /No package found/);
});

test('stop and undefine report receipts including failure reasons', async () => {
  const runner = makeRunner();
  assert.equal((await stopDynamicPlugin(ctxWith(runner), {}, 'plg-my-decoder')).ok, true);
  assert.match((await stopDynamicPlugin(ctxWith(makeRunner({ stop: async () => ({ ok: false, message: 'not-running' }) })), {}, 'p')).text, /not-running/);

  const removed = await undefineDynamicPlugin(ctxWith(runner), {}, 'plg-my-decoder');
  assert.equal(removed.ok, true);
  assert.match(removed.text, /active run stopped/);
  assert.match((await undefineDynamicPlugin(ctxWith(makeRunner({ undefine: async () => ({ ok: false, message: 'nope' }) })), {}, 'p')).text, /nope/);
});

test('listDynamicCordis drops malformed rows without a pluginId', () => {
  const ctx = ctxWith(makeRunner({ inventory: () => [{ pluginId: 'keep' }, { agentId: 'x' }] }));
  assert.deepEqual(listDynamicCordis(ctx).map((row) => row.pluginId), ['keep']);
});

test('buildPluginLifecycleKeyboard renders Add plus per-plugin Run/Stop/Remove tokens', () => {
  const rows = [
    { pluginId: 'short-id', running: false, callbacks: { run: 't:r1', stop: 't:s1', remove: 't:x1' } },
    { pluginId: 'a'.repeat(40), running: true, callbacks: { run: 't:r2', stop: 't:s2', remove: 't:x2' } },
  ];
  const kb = buildPluginLifecycleKeyboard(rows);
  const buttons = kb.inline_keyboard.flat();
  const byData = Object.fromEntries(buttons.map((b) => [b.callback_data, b.text]));

  assert.equal(byData['p:add'], '\u2795 Add plugin');
  assert.equal(byData['t:r1'], '\u25B6 Run short-id');
  assert.equal(byData['t:s2'], '\u23F8 Stop aaaaaaaaaaaaaaaaaaaaaaa\u2026');
  assert.equal(byData['t:x1'], '\u{1F5D1} Remove');
  assert.equal(kb.inline_keyboard.at(-1).at(-1).callback_data, 'm:back');

  // Callback data stays within Telegram's 64-byte limit even for long ids.
  for (const button of buttons) {
    if (button.callback_data !== undefined) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, `callback data too long: ${button.callback_data}`);
    }
  }
});
