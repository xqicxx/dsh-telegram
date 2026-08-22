import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalProgressFeed } from '../dist/telegram/goal-progress.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = (type, data = {}) => ({ type, data });

function harness({ liveRenderer = false, pending = false, notify = { onComplete: true, onLongTask: true }, objective = 'research the market', send } = {}) {
  const listeners = new Map();
  const sends = [];
  const edits = [];
  const deps = {
    ops: {
      send: send ?? (async (chatId, text, options) => {
        sends.push({ chatId, text, options });
        return sends.length;
      }),
      edit: async (chatId, messageId, text, options) => {
        edits.push({ chatId, messageId, text, options });
        return true;
      },
      delete: async () => {},
    },
    log: () => {},
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    goalFor: () => ({ objective }),
    todosFor: () => [
      { content: 'collect data', status: 'completed' },
      { content: 'write report', status: 'in_progress' },
    ],
    statusStats: () => ({
      turns: 2, steps: 4, toolCalls: 3, llmMs: 1000, toolMs: 2000, ttftMs: 100, ttftSteps: 2, decodeMs: 500, decodeTokens: 100,
      uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0,
    }),
    liveRendererActive: () => liveRenderer,
    pendingInbound: () => pending,
    notifyOnComplete: () => notify.onComplete !== false,
    notifyOnLongTask: () => notify.onLongTask !== false,
  };
  const ctx = {
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
  };
  const feed = new GoalProgressFeed(deps);
  feed.attach(ctx);
  const emit = (sessionId, event) => {
    for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
  };
  return { feed, sends, edits, emit };
}

test('goal turn gets a progress card that finalizes into the openclaw receipt with hit rate', async () => {
  const { feed, sends, edits, emit } = harness();
  emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /research the market/);

  emit('agent-1', ev('step/start', { step: 2 }));
  emit('agent-1', ev('tool/call', { name: 'bash' }));
  emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0 } } }));
  await sleep(280);
  assert.ok(edits.length >= 1);
  assert.match(edits.at(-1).text, /step 2/);
  assert.match(edits.at(-1).text, /bash/);
  assert.match(edits.at(-1).text, /50%/, 'todo progress bar uses completed/total');

  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  const final = edits.at(-1).text;
  // (markup-tolerant: the objective may render bold in the receipt header)
  assert.match(final, /✅ (?:<b>)?research the market(?:<\/b>)?/);
  assert.match(final, /🛠️ 1 次工具/);
  assert.match(final, /💾 命中 44%/, 'openclaw receipt keeps the cache hit-rate line');
  assert.equal(feed.snapshot(7), undefined, 'turn end clears the running snapshot');
});

test('streaming renderer suppresses the card and inbound user turns stay silent', async () => {
  const withRenderer = harness({ liveRenderer: true });
  withRenderer.emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(withRenderer.sends.length, 0);

  const inbound = harness({ pending: true });
  inbound.emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.equal(inbound.sends.length, 0);
});

test('goal heartbeat keeps the elapsed timer moving and completion pushes a fresh receipt (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { feed, sends, edits, emit } = harness();
  emit('agent-1', ev('turn/start', { turn: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sends.length, 1, 'initial progress card');
  const editsBefore = edits.length;

  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.ok(edits.length > editsBefore, 'silent tool still gets a 30s heartbeat edit');
  assert.match(edits.at(-1).text, /⏱️ 30s/);

  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.equal(sends.length, 2, 'completion is a NEW message, not just an in-place edit');
  assert.equal(sends[1].options.disable_notification, false, 'completion push rings the user');
  // (markup-tolerant: the objective may render bold in the receipt header)
  assert.match(sends[1].text, /✅ (?:<b>)?research the market(?:<\/b>)?/);
  feed.detach();
});

test('notify.onLongTask/onComplete=false disables heartbeat and completion push (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { feed, sends, edits, emit } = harness({ notify: { onComplete: false, onLongTask: false } });
  emit('agent-1', ev('turn/start', { turn: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sends.length, 1, 'progress card still opens');
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(edits.length, 0, 'heartbeat switch off');
  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.equal(sends.length, 1, 'completion push switch off');
  feed.detach();
});

test('objective and current tool are HTML-escaped in card and receipt (RE-1)', async () => {
  const { feed, sends, edits, emit } = harness({ objective: 'fix a <b> & c > d' });
  emit('agent-1', ev('turn/start', { turn: 1 }));
  assert.match(sends[0].text, /fix a &lt;b&gt; &amp; c &gt; d/, 'card header shows the escaped objective');
  assert.doesNotMatch(sends[0].text, /<b> & c/, 'raw objective markup must not leak into the HTML card');

  emit('agent-1', ev('tool/call', { name: '<script>' }));
  await sleep(280);
  assert.match(edits.at(-1).text, /&lt;script&gt;/, 'current tool line escapes its name');

  emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.match(edits.at(-1).text, /✅ (?:<b>)?fix a &lt;b&gt; &amp; c &gt; d/, 'receipt keeps the objective literal');
  feed.detach();
});

test('a failed initial send must not delete a newer turn draft (RE-6)', async () => {
  const deferred = [];
  const { feed, emit } = harness({
    // every card send parks until this test resolves it manually
    send: () => new Promise((resolve) => deferred.push(resolve)),
  });

  emit('agent-1', ev('turn/start', { turn: 1 })); // turn A card -> deferred[0]
  emit('agent-1', ev('turn/start', { turn: 2 })); // turn B replaces A while A's send is in flight
  assert.ok(feed.snapshot(7), 'turn B owns the running state');

  deferred[0](undefined); // turn A's send "fails" (no message id) after B took over
  await sleep(20);
  assert.ok(feed.snapshot(7), 'stale failure callback must not delete the newer draft');

  deferred[1](5); // turn B's card lands with message id 5
  await sleep(20);
  emit('agent-1', ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await sleep(20);
  assert.ok(feed.snapshot(7) === undefined, 'turn B finalizes and clears normally');
  feed.detach();
});
