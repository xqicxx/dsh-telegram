import test from 'node:test';
import assert from 'node:assert/strict';
import { listQueue, updateQueueItem, searchSessions, readHistory, promptSession, listSessionDetails, saveImageAttachment, readImageAttachment, releaseSavedAttachments, displayTitleFor, groupSessionsByProject, orderProjectGroups, sortProjectSessions, selectSessionModel, resumeSession, UNGROUPED_KEY } from '../dist/harness/adapters/sessions.js';

function queueAgent(id, nextTurn, nextStep, status = 'idle') {
  const make = (items) => items.map((item) => ({ id: item.id, content: [{ type: 'text', text: item.text }] }));
  const nextTurnList = make(nextTurn);
  const nextStepList = make(nextStep);
  const inbox = {
    nextTurn: nextTurnList,
    nextStep: nextStepList,
    replace(id, message) {
      const list = nextTurnList.some((m) => m.id === id) ? nextTurnList : nextStepList;
      const index = list.findIndex((m) => m.id === id);
      if (index === -1) return false;
      list[index] = message;
      return true;
    },
    remove(id) {
      const list = nextTurnList.some((m) => m.id === id) ? nextTurnList : nextStepList;
      const index = list.findIndex((m) => m.id === id);
      if (index === -1) return false;
      list.splice(index, 1);
      return true;
    },
  };
  const agent = { id, inbox, status, steerCalls: [] };
  agent.steer = (message) => agent.steerCalls.push(message);
  return agent;
}

function fakeCtx(agent) {
  return {
    agents: {
      get: () => agent,
      list: () => (agent ? [agent] : []),
    },
    get: () => undefined,
    sessions: undefined,
    llm: undefined,
  };
}

test('listQueue projects both inbox targets in order', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], [{ id: 'b', text: 'two' }]);
  const items = listQueue(fakeCtx(agent), 's1');
  assert.deepEqual(items.map((item) => [item.itemId, item.target]), [['a', 'next-turn'], ['b', 'next-step']]);
  assert.equal(items[0].text, 'one');
});

test('updateQueueItem removes a pending item', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], []);
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'remove' });
  assert.equal(res.ok, true);
  assert.equal(agent.inbox.nextTurn.length, 0);
});

test('updateQueueItem edits a pending item in place', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], []);
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'edit', content: 'changed' });
  assert.equal(res.ok, true);
  const text = agent.inbox.nextTurn[0].content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  assert.equal(text, 'changed');
});

test('updateQueueItem steering is refused while idle', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], [], 'idle');
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'steer' });
  assert.equal(res.ok, false);
  assert.match(res.text, /steer-unavailable/);
});

test('updateQueueItem steering works while running', () => {
  const agent = queueAgent('s1', [{ id: 'a', text: 'one' }], [], 'running');
  const res = updateQueueItem(fakeCtx(agent), 's1', 'a', { kind: 'steer' });
  assert.equal(res.ok, true);
  assert.equal(agent.steerCalls.length, 1);
  assert.equal(agent.inbox.nextTurn.length, 0);
});

test('updateQueueItem reports a missing item', () => {
  const agent = queueAgent('s1', [], []);
  const res = updateQueueItem(fakeCtx(agent), 's1', 'nope', { kind: 'remove' });
  assert.equal(res.ok, false);
  assert.match(res.text, /queue-item-not-found/);
});

test('searchSessions scans live logs with snippet cap', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'needle here' }] } },
    { seq: 1, type: 'assistant/message', data: { content: [{ type: 'text', text: 'another' }] } },
  ];
  const ctx = {
    sessions: { list: () => [{ id: 's9', events, header: { cwd: '/tmp' } }], get: (id) => ({ id, events, header: { cwd: '/tmp' } }) },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
  };
  const hits = await searchSessions(ctx, 'needle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 's9');
  assert.equal(hits[0].seq, 0);
  assert.equal(hits[0].snippet, 'needle here');
});

test('readHistory returns the requested window with roles', async () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    seq: i,
    type: i % 2 === 0 ? 'user/message' : 'assistant/message',
    data: { content: [{ type: 'text', text: `msg ${i}` }] },
  }));
  const ctx = {
    sessions: { list: () => [{ id: 's1', events, header: {} }], get: () => ({ id: 's1', events, header: {} }) },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
  };
  const items = await readHistory(ctx, 's1', 4);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.seq), [6, 7, 8, 9]);
  assert.equal(items[0].role, 'user');
  assert.equal(items[1].role, 'assistant');
});

test('promptSession queues without waking', () => {
  const calls = [];
  const agent = { id: 's1', send(message, target, wakeup) { calls.push([target, wakeup]); }, followup() { throw new Error('must not followup'); }, steer() {} };
  const ctx = { agents: { get: () => agent, list: () => [agent] }, get: () => undefined, sessions: undefined, llm: undefined };
  const res = promptSession(ctx, 's1', 'later', 'queue');
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ['next-turn', false]);
});


test('listSessionDetails sorts by most recent prompt and keeps the web title fallback chain', async () => {
  const sessions = {
    list: () => [
      { id: 'old', header: { cwd: '/proj/alpha' }, events: [{ seq: 0, type: 'user/message', at: 100, data: { content: [{ type: 'text', text: 'old prompt' }] } }] },
      { id: 'new', header: { cwd: '/proj/alpha' }, events: [{ seq: 0, type: 'user/message', at: 300, data: { content: [{ type: 'text', text: 'new prompt' }] } }] },
      { id: 'never', header: { cwd: '/proj/alpha' }, events: [] },
    ],
  };
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? sessions : undefined),
  };
  const details = await listSessionDetails(ctx);
  assert.deepEqual(details.map((d) => d.id), ['new', 'old', 'never']);
  assert.equal(details[0].lastPromptAt, 300);
  assert.equal(details[1].title, undefined, 'no title event: the caller falls back to the cwd basename');
  assert.equal(displayTitleFor(details[1].title, details[1].cwd, details[1].id), 'alpha');
  assert.equal(details[2].lastPromptAt, undefined);
});

test('listSessionDetails marks running by agent status and carries cold cwd', async () => {
  const sessions = {
    list: () => [
      { id: 's-run', header: { cwd: '/proj/a' }, events: [{ seq: 0, type: 'user/message', at: 10, data: { content: [{ type: 'text', text: 'go' }] } }] },
      { id: 's-idle', header: { cwd: '/proj/a' }, events: [{ seq: 0, type: 'user/message', at: 20, data: { content: [{ type: 'text', text: 'go' }] } }] },
    ],
  };
  const agents = new Map([
    ['s-run', { id: 's-run', status: 'running' }],
    ['s-idle', { id: 's-idle', status: 'idle' }],
  ]);
  const persistence = {
    list: async () => [{ id: 'cold', cwd: '/proj/b' }],
    readRaw: async (id) => (id === 'cold'
      ? { events: [{ seq: 0, type: 'session/title', data: { title: 'Cold work' } }] }
      : undefined),
  };
  const ctx = {
    agents: { list: () => [...agents.values()], get: (id) => agents.get(String(id)) },
    get: (name) => {
      if (name === 'sessions') return sessions;
      if (name === 'sessionPersistence') return persistence;
      return undefined;
    },
  };
  const details = await listSessionDetails(ctx);
  const run = details.find((detail) => detail.id === 's-run');
  const idle = details.find((detail) => detail.id === 's-idle');
  const cold = details.find((detail) => detail.id === 'cold');
  assert.equal(run.running, true);
  assert.equal(idle.running, false, 'an attached idle agent is not running');
  assert.equal(cold.cwd, '/proj/b', 'cold cwd comes from the persistence header');
  assert.equal(cold.title, 'Cold work');
});

test('listSessionDetails parses the real readRaw JSONL content shape for cold titles', async () => {
  const sessions = { list: () => [] };
  const persistence = {
    list: async () => [{ id: 'cold', cwd: '/proj/beta' }],
    readRaw: async (id) => (id === 'cold' ? {
      content: [
        JSON.stringify({ seq: 0, type: 'session', data: {} }),
        JSON.stringify({ seq: 1, type: 'user/message', at: 500, data: { content: [{ type: 'text', text: 'build it' }] } }),
        JSON.stringify({ seq: 2, type: 'session/title', data: { title: 'Build the bridge' } }),
      ].join('\n'),
    } : undefined),
  };
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    get: (name) => {
      if (name === 'sessions') return sessions;
      if (name === 'sessionPersistence') return persistence;
      return undefined;
    },
  };
  const details = await listSessionDetails(ctx);
  assert.equal(details.length, 1);
  assert.equal(details[0].title, 'Build the bridge', 'title comes from the JSONL content, not events');
  assert.equal(details[0].lastPromptAt, 500);
  assert.equal(details[0].eventCount, 3);
  assert.equal(details[0].cwd, '/proj/beta');
});

test('cold-session history and search parse the real readRaw JSONL content shape', async () => {
  // Production `readRaw` returns `{ meta, filename, content }` — verbatim
  // JSONL text with no `events` field. Cold /history and cold-log search
  // must parse that text instead of silently returning empty.
  const content = [
    JSON.stringify({ seq: 0, type: 'user/message', at: 100, data: { content: [{ type: 'text', text: 'needle in a cold log' }] } }),
    JSON.stringify({ seq: 1, type: 'assistant/message', at: 200, data: { content: [{ type: 'text', text: 'cold answer' }] } }),
    JSON.stringify({ seq: 2, type: 'tool/call', at: 300, data: { name: 'bash', arguments: '{"command":"ls"}' } }),
  ].join('\n');
  const persistence = {
    list: async () => [{ id: 'cold', cwd: '/proj/cold' }],
    readRaw: async () => ({ meta: {}, filename: 'session.jsonl', content }),
  };
  const ctx = {
    sessions: { list: () => [], get: () => undefined },
    agents: { list: () => [], get: () => undefined },
    get: (name) => {
      if (name === 'sessions') return ctx.sessions;
      if (name === 'sessionPersistence') return persistence;
      return undefined;
    },
  };
  const history = await readHistory(ctx, 'cold');
  assert.deepEqual(history.map((item) => item.seq), [0, 1, 2], '/history reads the parsed cold log');
  assert.equal(history[0].role, 'user');
  assert.match(history[2].text, /bash/);

  const hits = await searchSessions(ctx, 'needle in a cold log');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'cold');
  assert.equal(hits[0].seq, 0);
  assert.equal(hits[0].live, false);
});

test('displayTitleFor mirrors the web title → cwd basename → id chain', () => {
  assert.equal(displayTitleFor('  Continue  ', '/proj/alpha', 's1'), 'Continue');
  assert.equal(displayTitleFor(undefined, '/proj/alpha/', 's1'), 'alpha');
  assert.equal(displayTitleFor('   ', '/proj/alpha/', 's1'), 'alpha');
  assert.equal(displayTitleFor(undefined, '\\\\server\\share\\beta\\', 's1'), 'beta');
  assert.equal(displayTitleFor(undefined, undefined, 's1'), 's1');
});

test('groupSessionsByProject groups by workspace membership then cwd pseudo-projects', () => {
  const detail = (id, cwd, running = false, lastPromptAt = 0) => ({ id, cwd, running, lastPromptAt, live: true, title: undefined, blank: false, eventCount: 1, archived: false });
  const details = [
    detail('s1', '/proj/alpha', true, 10),
    detail('s2', '/proj/beta', false, 20),
    detail('s3', '/other/beta', false, 30),
    detail('s4', undefined, false, 40),
    detail('s5', '/proj/alpha', false, 50),
  ];
  const groups = groupSessionsByProject(details, [
    { workspaceId: 'w1', title: 'Alpha', path: '/proj/alpha', sessionIds: ['s1', 's5'] },
  ]);
  assert.deepEqual(groups.map((group) => group.key), ['w1', '/proj/beta', '/other/beta', UNGROUPED_KEY]);
  assert.equal(groups[0].runningCount, 1);
  assert.deepEqual(groups[0].sessions.map((session) => session.id), ['s1', 's5'], 'running sessions first');
  assert.equal(groups[1].label, 'beta');
  assert.equal(groups[2].label, 'beta (other)', 'same-basename pseudo projects are disambiguated');
  assert.equal(groups[3].label, '未分组');
});

test('orderProjectGroups ranks bound running, running, bound, recency, ungrouped', () => {
  const group = (key, label, runningCount, latestPromptAt, sessionIds) => ({ key, label, runningCount, latestPromptAt, sessions: sessionIds.map((id) => ({ id, running: false })) });
  const groups = [
    group('w-a', 'A', 0, 100, ['s-a']),
    group('w-b', 'B', 1, 50, ['s-b']),
    group('w-c', 'C', 1, 200, ['s-c']),
    group(UNGROUPED_KEY, '未分组', 0, 400, ['s-u']),
  ];
  const ordered = orderProjectGroups(groups, 's-b');
  assert.deepEqual(ordered.map((g) => g.key), ['w-b', 'w-c', 'w-a', UNGROUPED_KEY]);
});

test('sortProjectSessions sorts running first then recent prompt then id', () => {
  const session = (id, running, lastPromptAt) => ({ id, running, lastPromptAt });
  const sorted = sortProjectSessions([
    session('old', false, 100),
    session('run', true, 1),
    session('new', false, 300),
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ['run', 'new', 'old']);
});


test('saved photo attachments read back through their exact durable ref', async () => {
  const ref = { attachmentId: 'img-1', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 };
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'attachments' ? {
      saveImage: async () => ref,
      readImage: async (received) => {
        assert.equal(received, ref, 'readImage must receive the real ref, not a reconstructed one');
        return { ref, data: new Uint8Array([1, 2, 3]) };
      },
    } : undefined),
  };
  const saved = await saveImageAttachment(ctx, new Uint8Array([1, 2, 3]), 'image/jpeg');
  assert.equal(saved.ok, true);
  const read = await readImageAttachment(ctx, 'img-1');
  assert.equal(read.ok, true);
  assert.equal(read.data, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(read.mediaType, 'image/jpeg');

  const missing = await readImageAttachment(ctx, 'other');
  assert.equal(missing.ok, false);
  assert.match(missing.text, /not saved by this bridge/);
  releaseSavedAttachments();
  assert.equal((await readImageAttachment(ctx, 'img-1')).ok, false);
});

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('selectSessionModel uses ctx.get("llm") so a strict context without llm inject does not throw', async () => {
  const agent = queueAgent('s1', [], []);
  agent.ctx = { on: () => () => {} };
  const resolved = { provider: 'opencode-go', model: 'gpt-x', reasoningEffort: 'medium' };
  const ctx = {
    agents: {
      get: (id) => (id === 's1' ? agent : undefined),
      list: () => [agent],
    },
    get: (name) => (name === 'llm' ? { resolveCallConfig: async () => resolved } : undefined),
  };
  Object.defineProperty(ctx, 'llm', {
    get() {
      throw new Error('cannot get property "llm" without inject');
    },
  });
  const res = await selectSessionModel(ctx, 's1', 'opencode-go', 'gpt-x');
  assert.equal(res.ok, true);
  assert.match(res.text, /opencode-go\/gpt-x/);
});

test('selectSessionModel repoints opencode-go Responses-native models automatically', async () => {
  const agent = queueAgent('s1', [], []);
  agent.ctx = { on: () => () => {} };
  const seen = [];
  const ctx = {
    agents: {
      get: (id) => (id === 's1' ? agent : undefined),
      list: () => [agent],
    },
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'opencode-go-responses' }],
        resolveCallConfig: async (config) => {
          seen.push(config);
          return config;
        },
      };
      if (name === 'settings') return {
        writable: true,
        describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go-responses': {} } }, revision: 1 }],
        update: async () => {},
      };
      return undefined;
    },
  };
  const res = await selectSessionModel(ctx, 's1', 'opencode-go', 'gpt-5.6-luna');
  assert.equal(res.ok, true);
  assert.deepEqual(seen[0], { provider: 'opencode-go-responses', model: 'gpt-5.6-luna' });
});

test('deleteSession removes both raw and wrapped session directories', async () => {
  const { deleteSession } = await import('../dist/harness/adapters/sessions.js');
  const home = mkdtempSync(join(tmpdir(), 'dsh-delete-session-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const project = join(home, 'sessions', '--proj--');
    const raw = join(project, 'session-abc-123');
    const wrapped = join(project, '--~session-wrapped--');
    const untouched = join(project, 'session-keep');
    mkdirSync(raw, { recursive: true });
    mkdirSync(wrapped, { recursive: true });
    mkdirSync(untouched, { recursive: true });
    writeFileSync(join(raw, 'session.jsonl'), 'x');
    const ctx = { agents: { get: () => undefined } };
    await deleteSession(ctx, 'session-abc-123');
    await deleteSession(ctx, 'session-wrapped');
    assert.equal(existsSync(raw), false, 'raw id dir removed');
    assert.equal(existsSync(wrapped), false, 'wrapped id dir removed');
    assert.equal(existsSync(untouched), true, 'other sessions untouched');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 🟠-17: resumeSession must never guess provider/model from agents[0]
// ---------------------------------------------------------------------------

function resumeCtx(liveAgents) {
  const resumeCalls = [];
  return {
    resumeCalls,
    agents: {
      list: () => liveAgents,
      get: (id) => liveAgents.find((a) => String(a.id) === String(id)),
      resume: async (options) => {
        resumeCalls.push(options);
        return { agent: { id: String(options.resumeSessionId), options: options.agentOptions ?? {} }, dispose: async () => {} };
      },
    },
    get: () => undefined,
  };
}

test('resumeSession refuses to guess whose model to inherit among several live agents (🟠-17)', async () => {
  const ctx = resumeCtx([
    { id: 'a-chat', options: { provider: 'chat-a', model: 'model-a' } },
    { id: 'b-chat', options: { provider: 'chat-b', model: 'model-b' } },
  ]);
  const res = await resumeSession(ctx, 'persisted-1');
  assert.equal(res.ok, false);
  assert.match(res.text, /live sessions are running/);
  assert.deepEqual(ctx.resumeCalls, [], 'no resume may run on an ambiguous inheritance');
});

test('resumeSession inherits provider/model only from the explicitly named live agent (🟠-17)', async () => {
  const ctx = resumeCtx([
    { id: 'a-chat', options: { provider: 'chat-a', model: 'model-a' } },
    { id: 'b-chat', options: { provider: 'chat-b', model: 'model-b' } },
  ]);
  const res = await resumeSession(ctx, 'persisted-1', 'b-chat');
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(ctx.resumeCalls[0]?.agentOptions, { provider: 'chat-b', model: 'model-b' });
});

test('resumeSession keeps single-agent behavior: the only live agent is the inherit source', async () => {
  const ctx = resumeCtx([{ id: 'only', options: { provider: 'solo', model: 'solo-model' } }]);
  const res = await resumeSession(ctx, 'persisted-1');
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(ctx.resumeCalls[0]?.agentOptions, { provider: 'solo', model: 'solo-model' });
});

test('resumeSession fails cleanly when the named inherit source is not live', async () => {
  const ctx = resumeCtx([{ id: 'a-chat', options: { provider: 'chat-a', model: 'model-a' } }]);
  const res = await resumeSession(ctx, 'persisted-1', 'gone-agent');
  assert.equal(res.ok, false);
  assert.match(res.text, /no live agent/);
  assert.deepEqual(ctx.resumeCalls, []);
});

// ---------------------------------------------------------------------------
// Review 🔵-3: listSessionDetails reads cold logs with bounded concurrency
// and a per-id cache keyed by header mtime/id, invalidated on roster change.
// ---------------------------------------------------------------------------

function coldRosterCtx({ roster, mtimes, reads, inFlightBox }) {
  const persistence = {
    list: async () => roster.ids.map((id) => ({ id, cwd: '/proj/cold-roster', mtimeMs: mtimes.get(id) ?? 100 })),
    readRaw: async (id) => {
      inFlightBox.inFlight += 1;
      inFlightBox.max = Math.max(inFlightBox.max, inFlightBox.inFlight);
      await new Promise((resolve) => setTimeout(resolve, (Number(String(id).split('-')[1]) % 3) * 5));
      inFlightBox.inFlight -= 1;
      reads.push(String(id));
      const suffix = String(id).split('-')[1];
      const n = /^\d+$/.test(suffix) ? Number(suffix) : 999; // non-numeric ids (roster-change probe) sort newest
      const events = [{ seq: 0, type: 'user/message', at: n, data: { content: [{ type: 'text', text: `prompt ${suffix}` }] } }];
      // A bumped mtime means the log grew: append work that only a fresh
      // read can see, so stale-cache bugs cannot pass as fresh content.
      if ((mtimes.get(id) ?? 100) >= 500) {
        events.push({ seq: 1, type: 'user/message', at: 900 + n, data: { content: [{ type: 'text', text: 'work while resident' }] } });
      }
      return { meta: {}, filename: 'session.jsonl', events };
    },
  };
  return {
    persistence,
    ctx: {
      agents: { list: () => [], get: () => undefined },
      get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    },
  };
}

test('listSessionDetails reads cold logs concurrently (≤4 in flight) and keeps the sorted order stable', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `cold-${String(i).padStart(2, '0')}`);
  const reads = [];
  const inFlightBox = { inFlight: 0, max: 0 };
  const { ctx } = coldRosterCtx({ roster: { ids: [...ids] }, mtimes: new Map(), reads, inFlightBox });
  const details = await listSessionDetails(ctx);
  assert.equal(details.length, 12, 'every cold log lands in the roster');
  assert.ok(inFlightBox.max <= 4, `cold reads stay within the 4-way pool (observed ${inFlightBox.max})`);
  assert.ok(inFlightBox.max > 1, `reads actually overlap instead of serializing (observed ${inFlightBox.max})`);
  assert.equal(reads.length, 12, 'each log read exactly once');
  // Staggered completion times must not disturb the web order: most recent
  // prompt first.
  assert.deepEqual(details.map((d) => d.id), [...ids].reverse());
  assert.equal(details[0].lastPromptAt, 11);
  assert.equal(details[0].cwd, '/proj/cold-roster');
  assert.equal(details[0].eventCount, 1);
});

test('listSessionDetails caches cold logs across refreshes; mtime bumps re-read one log, roster changes invalidate all', async () => {
  const ids = ['cold-0', 'cold-1', 'cold-2'];
  const roster = { ids: [...ids] };
  const mtimes = new Map(ids.map((id) => [id, 100]));
  const reads = [];
  const inFlightBox = { inFlight: 0, max: 0 };
  const { ctx, persistence } = coldRosterCtx({ roster, mtimes, reads, inFlightBox });

  const first = await listSessionDetails(ctx);
  assert.equal(reads.length, 3);
  const second = await listSessionDetails(ctx);
  assert.equal(reads.length, 3, 'unchanged roster + unchanged mtime serves entirely from cache');
  assert.deepEqual(second, first, 'cached refresh returns the identical roster');

  mtimes.set('cold-1', 200);
  await listSessionDetails(ctx);
  assert.deepEqual(reads.slice(3), ['cold-1'], 'an mtime bump re-reads exactly the changed log');

  reads.length = 0;
  roster.ids = [...ids, 'cold-new'];
  await listSessionDetails(ctx);
  assert.equal(reads.length, 4, 'a roster change drops the cache: every log is re-read once');
  const refreshed = await listSessionDetails(ctx);
  assert.deepEqual(refreshed.map((d) => d.id), ['cold-new', 'cold-2', 'cold-1', 'cold-0']);
  assert.equal(reads.length, 4, 'the refilled cache serves the next refresh again');

  // A cached cold session that goes LIVE (resume), logs more work, and is
  // disposed again must be re-read after disposal — never serve the pre-live
  // snapshot just because the roster itself did not change.
  let liveIds = [];
  const mixedCtx = {
    agents: { list: () => [], get: () => undefined },
    get: (name) => {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessions') return { list: () => liveIds.map((id) => ({ id, events: [], header: {} })), get: (id) => undefined };
      return undefined;
    },
  };
  await listSessionDetails(mixedCtx); // warm cache for cold-0/1/2
  reads.length = 0;
  liveIds = ['cold-0'];
  const whileLive = await listSessionDetails(mixedCtx);
  assert.equal(whileLive.find((d) => d.id === 'cold-0').live, true, 'live roster wins over the cold cache');
  mtimes.set('cold-0', 500); // "work happened while resident"
  reads.length = 0;
  liveIds = [];
  const afterDispose = await listSessionDetails(mixedCtx);
  assert.deepEqual(reads, ['cold-0'], 'only the re-disposed session is re-read');
  assert.equal(afterDispose.find((d) => d.id === 'cold-0').lastPromptAt, 900, 'the post-live work is visible (fresh read, not the stale snapshot)');
});

// ---------------------------------------------------------------------------
// Review 🔵-4: searchSessions stops scanning at the hit limit (the check used
// to sit outside the loops, so a full hit list still walked every remaining
// session — and could even push past the limit).
// ---------------------------------------------------------------------------

function searchHitEvent(id) {
  return [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: `needle ${id}` }] } }];
}

test('searchSessions returns exactly limit hits even with many more live matches', async () => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({
    id: `live-${i}`,
    events: searchHitEvent(i),
    header: {},
  }));
  const ctx = {
    sessions: { list: () => sessions, get: (id) => sessions.find((s) => s.id === id) },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
  };
  const hits = await searchSessions(ctx, 'needle', 3);
  assert.equal(hits.length, 3, 'the scan stops at the limit instead of overflowing');
  assert.ok(hits.every((hit) => hit.live && hit.snippet.includes('needle')));
});

test('searchSessions stops opening cold logs once the hit limit is full', async () => {
  const coldReads = [];
  const persistence = {
    list: async () => Array.from({ length: 8 }, (_, i) => ({ id: `cold-${i}` })),
    readRaw: async (id) => {
      coldReads.push(String(id));
      return { events: searchHitEvent(String(id)) };
    },
  };
  const ctx = {
    sessions: { list: () => [], get: () => undefined },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
  };
  const hits = await searchSessions(ctx, 'needle', 3);
  assert.equal(hits.length, 3);
  assert.deepEqual(coldReads, ['cold-0', 'cold-1', 'cold-2'], 'log #4 onward is never read');
});

// ---------------------------------------------------------------------------
// Review 四 (encodeSegment): the private encoder in session-lifecycle.ts
// hand-mirrors the dsh JSONL persistence backend's path-segment encoder:
// safe chars [A-Za-z0-9._-] kept verbatim, everything else escaped as `~XXXX`
// uppercase hex, filesystem separator runs folded into one `~`, wrapped in
// `--…--`, inner run bounded at 251 chars ("root" when empty).
//
// DRIFT RISK: the mirror is hand-copied, NOT imported from the backend (the
// current harness encoder has already diverged — it neither wraps in `--` nor
// folds separators), and it cannot be pinned by a decode round-trip either:
// separator folding is lossy and `/1234` collides with the escape syntax.
// The only exported surface that observes the mirror is deleteSession's
// directory-candidate list, so the known vectors below are pinned through it:
// if the private encoder ever drifts, deleteSession stops recognizing the
// directories created here and fails loudly instead of silently leaving
// wrapped directories behind on /del.
// ---------------------------------------------------------------------------

test('deleteSession recognizes directories named by the pinned encodeSegment vectors', async () => {
  const { deleteSession } = await import('../dist/harness/adapters/sessions.js');
  const vectors = [
    ['session-abc-123', '--~session-abc-123--'], // initial separator run emits the leading ~
    ['a/b\\c', '--~a~b~c--'], // separator runs fold to a single ~ each
    ['a b', '--~a~0020b--'], // space escapes as uppercase hex
    ['café', '--~caf~00E9--'], // non-ASCII escapes by code point
    ['a~b', '--~a~007Eb--'], // literal ~ always escapes
    ['x'.repeat(300), `--~${'x'.repeat(250)}--`], // inner bound: 251 chars between the -- wrappers
  ];
  const home = mkdtempSync(join(tmpdir(), 'dsh-encode-segment-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    for (const [id, expectedDir] of vectors) {
      const dir = join(home, 'sessions', '--proj--', expectedDir);
      mkdirSync(dir, { recursive: true });
      try {
        await deleteSession({ agents: { get: () => undefined } }, id);
        assert.equal(existsSync(dir), false, `encodeSegment(${JSON.stringify(id.slice(0, 16))}) must produce ${expectedDir}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
