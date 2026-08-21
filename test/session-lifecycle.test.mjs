import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle, selectSessionModel, currentSessionModel } from '../dist/harness/adapters/sessions.js';

function makeCtx({ liveAgents = [], defaultSelection = { provider: 'opencode-go', model: 'deepseek-v4-flash' } } = {}) {
  const created = [];
  return {
    created,
    agents: {
      list: () => liveAgents,
      async create(opts) {
        const handle = {
          agent: { id: `telegram-created-${created.length + 1}`, options: { provider: opts.agentOptions.provider, model: opts.agentOptions.model } },
          disposed: 0,
          dispose: async () => {
            handle.disposed += 1;
          },
        };
        created.push({ opts, handle });
        return handle;
      },
    },
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => defaultSelection } : undefined),
  };
}

test('SessionLifecycle.create falls back to agentDefaultModel on first new', async () => {
  const lifecycle = new SessionLifecycle();
  const ctx = makeCtx();
  const res = await lifecycle.create(ctx, '/tmp');
  assert.equal(res.result.ok, true);
  assert.equal(ctx.created[0].opts.agentOptions.provider, 'opencode-go');
  assert.equal(ctx.created[0].opts.agentOptions.model, 'deepseek-v4-flash');
  await lifecycle.dispose().catch(() => {});
});

test('SessionLifecycle.create never inherits the model of an unrelated live agent', async () => {
  // v0.6 multichat semantics: other chats' agents must not leak into this
  // chat's new session. Only the explicit model or the profile default wins.
  const lifecycle = new SessionLifecycle();
  const unrelated = { options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } };
  const ctx = makeCtx({ liveAgents: [unrelated] });
  const res = await lifecycle.create(ctx, '/tmp');
  assert.equal(res.result.ok, true);
  assert.equal(ctx.created[0].opts.agentOptions.provider, 'opencode-go');
  assert.equal(ctx.created[0].opts.agentOptions.model, 'deepseek-v4-flash');
  await lifecycle.dispose().catch(() => {});
});

test('SessionLifecycle.create honors an explicit Telegram model over the profile default', async () => {
  const lifecycle = new SessionLifecycle();
  const ctx = makeCtx();
  const res = await lifecycle.create(ctx, '/tmp', { provider: 'telegram-provider', model: 'telegram-model' });
  assert.equal(res.result.ok, true);
  assert.equal(ctx.created[0].opts.agentOptions.provider, 'telegram-provider');
  assert.equal(ctx.created[0].opts.agentOptions.model, 'telegram-model');
  await lifecycle.dispose().catch(() => {});
});

test('SessionLifecycle.create closes only the replaced chat-owned session', async () => {
  const lifecycle = new SessionLifecycle();
  const ctx = makeCtx();
  const first = await lifecycle.create(ctx, '/tmp');
  const second = await lifecycle.create(ctx, '/tmp', undefined, { replaceSessionId: first.agentId });
  assert.equal(second.result.ok, true);
  assert.notEqual(second.agentId, first.agentId);
  assert.equal(ctx.created[0].handle.disposed, 1, 'the replaced session is disposed');
  assert.equal(ctx.created[1].handle.disposed, 0, 'the new session stays alive');
  await lifecycle.dispose().catch(() => {});
  assert.equal(ctx.created[1].handle.disposed, 1, 'teardown disposes every tracked session');
});

test('SessionLifecycle.stop aborts only the current turn and keeps the inbox', () => {
  const lifecycle = new SessionLifecycle();
  const cancelCalls = [];
  const agent = { id: 's1', cancel: (cause, options) => cancelCalls.push({ cause, options }) };
  const ctx = { agents: { list: () => [agent] } };
  const res = lifecycle.stop(ctx, 's1');
  assert.equal(res.ok, true);
  assert.match(res.text, /Stopping the current turn/);
  assert.deepEqual(cancelCalls, [{ cause: { kind: 'user' }, options: { keepInbox: true } }]);
});

test('SessionLifecycle.create fails gracefully without agents service', async () => {
  const lifecycle = new SessionLifecycle();
  const res = await lifecycle.create({}, '/tmp');
  assert.equal(res.result.ok, false);
  await lifecycle.dispose().catch(() => {});
});

test('a hung agent dispose cannot wedge session close/create forever (#20)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = new SessionLifecycle();
  lifecycle.adopt({ agent: { id: 'hung' }, dispose: () => new Promise(() => {}) });

  const closing = lifecycle.close('hung');
  t.mock.timers.tick(10_000);
  const res = await closing;
  assert.equal(res.ok, true, 'close returns after the 10s dispose deadline');
  await lifecycle.dispose().catch(() => {});
});

test('SessionLifecycle.close releases the per-session model selection', async () => {
  // /model then close used to leak the selections entry and its dispose
  // closure; every destroy path through close() must release it exactly once.
  const agent = { id: 'sel-lc', options: { provider: 'default-p', model: 'default-m' }, ctx: { on: () => () => {} } };
  const ctx = {
    agents: { list: () => [], get: (id) => (String(id) === 'sel-lc' ? agent : undefined) },
    get: (name) => (name === 'llm' ? { resolveCallConfig: async (config) => config } : undefined),
  };
  const picked = await selectSessionModel(ctx, 'sel-lc', 'picked-p', 'picked-m');
  assert.equal(picked.ok, true);
  assert.equal(currentSessionModel(ctx, 'sel-lc').model, 'picked-m', 'selection is active before close');

  const lifecycle = new SessionLifecycle();
  lifecycle.adopt({ agent: { id: 'sel-lc' }, dispose: async () => {} });
  const res = await lifecycle.close('sel-lc');
  assert.equal(res.ok, true);
  assert.equal(
    currentSessionModel(ctx, 'sel-lc').model,
    'default-m',
    'close() releases the selection — the live agent default shows through again',
  );
});

// ---------------------------------------------------------------------------
// 🟠-17: stop without an explicit id must never cancel agents[0] of several
// ---------------------------------------------------------------------------

test('SessionLifecycle.stop refuses to guess among several live sessions (🟠-17)', () => {
  const lifecycle = new SessionLifecycle();
  const cancels = [];
  const make = (id) => ({ id, cancel: (...args) => cancels.push([id, ...args]) });
  const ctx = { agents: { list: () => [make('a'), make('b')] } };
  const res = lifecycle.stop(ctx);
  assert.equal(res.ok, false, 'ambiguous stop must fail, not pick agents[0]');
  assert.match(res.text, /explicit session id/);
  assert.deepEqual(cancels, [], 'no turn may be cancelled on an ambiguous stop');
});

test('SessionLifecycle.stop keeps the single-agent default working (🟠-17)', () => {
  const lifecycle = new SessionLifecycle();
  const cancels = [];
  const agent = { id: 'solo', cancel: (...args) => cancels.push([agent.id, ...args]) };
  const ctx = { agents: { list: () => [agent] } };
  const res = lifecycle.stop(ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(cancels, [['solo', { kind: 'user' }, { keepInbox: true }]]);
});
