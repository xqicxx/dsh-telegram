import test from 'node:test';
import assert from 'node:assert/strict';
import { copyAgentPreset, listAgentPresets, selectAgentPreset, sessionHasStarted, switchAgentPresetMidSession } from '../dist/harness/adapters/presets.js';

function key(id) {
  return typeof id === 'object' && id !== null ? String(id.value ?? id) : String(id);
}

function fakeCtx({ blank = true, recomposeImpl } = {}) {
  const appends = [];
  const agent = {
    session: {
      events: blank ? [] : [{ type: 'turn/start' }],
      append: (type, data) => appends.push({ type, data }),
    },
    ctx: {},
  };
  return {
    ctx: {
      agents: { get: () => agent },
      get: () => ({
        recompose: recomposeImpl ?? (async () => ({ id: 'preset-a' })),
      }),
    },
    agent,
    appends,
  };
}

test('selectAgentPreset recomposes a blank session via the repeat-safe seam', async () => {
  let called = 0;
  const { ctx, appends } = fakeCtx({ recomposeImpl: async () => { called += 1; return { id: 'preset-a' }; } });
  const res = await selectAgentPreset(ctx, 's1', 'preset-a');
  assert.equal(res.ok, true);
  assert.equal(called, 1);
  assert.deepEqual(appends, [{ type: 'agent-preset/selected', data: { agentPreset: 'preset-a' } }]);
});

test('selectAgentPreset rejects a started session', async () => {
  const { ctx } = fakeCtx({ blank: false });
  const res = await selectAgentPreset(ctx, 's1', 'preset-a');
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('agent-preset-locked'));
});

test('selectAgentPreset propagates recompose errors', async () => {
  const { ctx } = fakeCtx({ recomposeImpl: async () => { throw new Error('boom'); } });
  const res = await selectAgentPreset(ctx, 's1', 'preset-a');
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('boom'));
});

test('sessionHasStarted mirrors the web sessionBlank inverse', () => {
  const { ctx } = fakeCtx({ blank: true });
  assert.equal(sessionHasStarted(ctx, 's1'), false);
  const started = fakeCtx({ blank: false });
  assert.equal(sessionHasStarted(started.ctx, 's1'), true);
});

function midSessionCtx({ sourceEvents }) {
  const sourceAppends = [];
  const childAppends = [];
  const sourceAgent = {
    id: 'source-session',
    session: { events: sourceEvents, append: (type, data) => sourceAppends.push({ type, data }) },
    ctx: { scope: 'source' },
  };
  const childAgent = {
    id: 'child-session',
    session: { events: [...sourceEvents], append: (type, data) => childAppends.push({ type, data }) },
    ctx: { scope: 'child' },
  };
  const calls = { fork: [], resume: [], recompose: [] };
  const sessionsStore = {
    get: (id) => (key(id) === 'source-session' ? { id: 'source-session', events: sourceEvents } : undefined),
    fork: (source, boundary, childId) => {
      calls.fork.push({ source: key(source), boundary, child: key(childId) });
      return { id: key(childId), events: [...sourceEvents] };
    },
  };
  const ctx = {
    agents: {
      get: (id) => (key(id) === 'source-session' ? sourceAgent : key(id) === 'child-session' ? childAgent : undefined),
      // 🟠-17: the inherit source is resolved by id — the roster entry carries it.
      list: () => [{ id: 'source-session', options: { provider: 'opencode-go', model: 'deepseek-v4-pro' } }],
      resume: async (options) => {
        calls.resume.push({ resumeSessionId: key(options.resumeSessionId), agentOptions: options.agentOptions });
        return { agent: childAgent, dispose: async () => {} };
      },
    },
    get: (name) => {
      if (name === 'sessions') return sessionsStore;
      if (name === 'agentPresets') return {
        recompose: async (agentCtx, id) => {
          calls.recompose.push({ scope: agentCtx.scope, id });
          return { id };
        },
      };
      return undefined;
    },
  };
  return { ctx, calls, childAppends };
}

test('mid-session switch forks through the last turn end, resumes, recomposes, and records', async () => {
  const { ctx, calls, childAppends } = midSessionCtx({
    sourceEvents: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'assistant/message' },
      { seq: 3, type: 'turn/end' },
    ],
  });
  const res = await switchAgentPresetMidSession(ctx, 'source-session', 'preset-b');
  assert.equal(res.ok, true, res.text);
  assert.equal(res.childId, 'child-session');
  assert.ok(res.handle, 'resume handle is surfaced for adoption');
  assert.equal(calls.fork.length, 1);
  assert.equal(calls.fork[0].source, 'source-session');
  assert.equal(calls.fork[0].boundary, 3);
  assert.equal(typeof calls.fork[0].child, 'string');
  assert.ok(calls.fork[0].child.startsWith('telegram-'), 'fork child id is generated');
  assert.deepEqual(calls.resume, [{
    resumeSessionId: calls.fork[0].child,
    // 🟠-17: the fork inherits the SOURCE session's provider/model explicitly.
    agentOptions: { provider: 'opencode-go', model: 'deepseek-v4-pro' },
  }]);
  assert.deepEqual(calls.recompose, [{ scope: 'child', id: 'preset-b' }]);
  assert.deepEqual(childAppends, [{ type: 'agent-preset/selected', data: { agentPreset: 'preset-b' } }]);
});

test('mid-session switch refuses while the current turn is still open', async () => {
  const { ctx, calls } = midSessionCtx({
    sourceEvents: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'turn/start' },
    ],
  });
  const res = await switchAgentPresetMidSession(ctx, 'source-session', 'preset-b');
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('current turn has not finished'));
  assert.equal(calls.fork.length, 0);
});

test('mid-session switch surfaces fork failures without touching the source', async () => {
  const { ctx, calls } = midSessionCtx({
    sourceEvents: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'turn/end' },
    ],
  });
  ctx.get = (name) => {
    if (name === 'sessions') return {
      get: (id) => (key(id) === 'source-session' ? { id: 'source-session', events: [{ seq: 0, type: 'user/message' }, { seq: 1, type: 'turn/start' }, { seq: 2, type: 'turn/end' }] } : undefined),
      fork: () => { throw new Error('open turn'); },
    };
    if (name === 'agentPresets') return { recompose: async () => ({ id: 'preset-b' }) };
    return undefined;
  };
  const res = await switchAgentPresetMidSession(ctx, 'source-session', 'preset-b');
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('open turn'));
  assert.equal(calls.resume.length, 0);
  assert.equal(calls.recompose.length, 0);
});

test('mid-session switch disposes the resumed fork when recompose fails', async () => {
  const { ctx, calls } = midSessionCtx({
    sourceEvents: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'turn/end' },
    ],
  });
  const sessionsStore = ctx.get('sessions');
  let disposed = 0;
  const originalResume = ctx.agents.resume;
  ctx.agents.resume = async (options) => {
    const resumed = await originalResume(options);
    return { ...resumed, dispose: async () => { disposed += 1; } };
  };
  ctx.get = (name) => {
    if (name === 'sessions') return sessionsStore;
    if (name === 'agentPresets') return { recompose: async () => { throw new Error('preset conflict'); } };
    return undefined;
  };
  const res = await switchAgentPresetMidSession(ctx, 'source-session', 'preset-b');
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('preset conflict'));
  assert.equal(disposed, 1);
  assert.equal(calls.fork.length, 1);
});


test('copyAgentPreset forwards the user-chosen new preset id', async () => {
  const calls = [];
  const ctx = { get: (name) => (name === 'agentPresets' ? { copy: async (from, to, name) => { calls.push({ from, to, name }); } } : undefined) };
  const res = await copyAgentPreset(ctx, 'source-preset', 'my-copy');
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ from: 'source-preset', to: 'my-copy', name: undefined }]);
  assert.match(res.text, /my-copy/);
});

test('copyAgentPreset degrades without the presets service', async () => {
  const res = await copyAgentPreset({ get: () => undefined }, 'source', 'copy');
  assert.equal(res.ok, false);
});


test('listAgentPresets reports authorable and hasDocument deployment facts', async () => {
  const ctx = {
    get: (name) => (name === 'agentPresets' ? {
      defaultId: 'standard',
      authorable: true,
      hasDocument: true,
      list: async () => [{ id: 'standard', trust: 'system' }, { id: 'custom', trust: 'user', broken: 'missing plugin' }],
    } : undefined),
  };
  const view = await listAgentPresets(ctx);
  assert.equal(view.authorable, true);
  assert.equal(view.hasDocument, true);
  assert.equal(view.presets[0].isDefault, true);
  assert.equal(view.presets[1].broken, 'missing plugin');
  const empty = await listAgentPresets({ get: () => undefined });
  assert.deepEqual(empty, { presets: [], authorable: false, hasDocument: false });
});
