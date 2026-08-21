import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCurrent } from '../dist/harness/adapters/compact.js';
import { executeCommand } from '../dist/harness/adapters/commands.js';
import { discoverModels } from '../dist/harness/adapters/llm.js';

// ---------------------------------------------------------------------------
// 🟠-18: every backend await is bounded — a hung engine must not suspend
// Telegram command processing forever.
// ---------------------------------------------------------------------------

test('compactCurrent fails cleanly when the compaction engine hangs (🟠-18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborts = 0;
  const agent = { id: 'agent-1', status: 'idle' };
  const ctx = {
    agents: { list: () => [agent] },
    compaction: {
      compactNow(_agent, signal) {
        signal.addEventListener('abort', () => { aborts += 1; });
        return new Promise(() => {}); // hang forever
      },
    },
  };
  const pending = compactCurrent(ctx, 'agent-1');
  t.mock.timers.tick(120_000);
  const res = await pending;
  assert.equal(res.ok, false);
  assert.match(res.text, /compaction timed out after 120000ms/);
  assert.equal(aborts, 1, 'the caller-owned AbortController fires on timeout');
});

test('compactCurrent still succeeds when compaction finishes in time (🟠-18)', async () => {
  const agent = { id: 'agent-1', status: 'idle' };
  const ctx = {
    agents: { list: () => [agent] },
    compaction: {
      compactNow: async () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4200 }),
    },
  };
  const res = await compactCurrent(ctx, 'agent-1');
  assert.equal(res.ok, true);
  assert.match(res.text, /Compacted 3 items \(~4200 tokens\)/);
});

test('executeCommand fails cleanly when the commands backend hangs (🟠-18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const agent = { id: 'agent-1' };
  const ctx = {
    get: (name) => (name === 'commands' ? {
      execute: (_agent, _line, signal) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => {}); // hang forever
      },
    } : undefined),
  };
  const pending = executeCommand(ctx, agent, '/slow');
  t.mock.timers.tick(60_000);
  const res = await pending;
  assert.equal(res.ok, false);
  assert.match(res.text, /command execution timed out after 60000ms/);
  assert.equal(aborted, true, 'the dispatch-owned signal fires on timeout');
});

test('discoverModels passes a signal and fails cleanly when the endpoint hangs (🟠-18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let seenSignal;
  const ctx = {
    get: (name) => (name === 'llm' ? {
      discoverModels: (_ns, request) => {
        seenSignal = request.signal;
        return new Promise(() => {}); // hang forever
      },
    } : undefined),
  };
  const pending = discoverModels(ctx, 'ns', { baseURL: 'https://hung.example' });
  t.mock.timers.tick(60_000);
  const res = await pending;
  assert.equal(res.ok, false);
  assert.match(res.text, /model discovery timed out after 60000ms/);
  assert.ok(seenSignal instanceof AbortSignal, 'the discovery request carries an AbortSignal');
});
