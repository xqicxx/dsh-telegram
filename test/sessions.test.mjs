import test from 'node:test';
import assert from 'node:assert/strict';
import { listQueue, updateQueueItem, searchSessions, readHistory, promptSession, listSessionDetails, saveImageAttachment, readImageAttachment, releaseSavedAttachments, displayTitleFor, groupSessionsByProject, orderProjectGroups, sortProjectSessions, selectSessionModel, UNGROUPED_KEY } from '../dist/harness/adapters/sessions.js';

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
