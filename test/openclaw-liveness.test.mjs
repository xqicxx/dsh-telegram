import test from 'node:test';
import assert from 'node:assert/strict';

function makeHost({ goal } = {}) {
  const host = {
    sends: [],
    edits: [],
    deletes: [],
    nextId: 100,
    inboundPending: false,
    liveFeed: true,
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    goalForChat: (chatId) => (chatId === 7 ? goal : undefined),
    liveFeedEnabled: () => true,
    bindAgent: () => {},
    unbindChat: () => {},
    send: async (chatId, text, options) => {
      const id = host.nextId++;
      host.sends.push({ chatId, text, options, id });
      return id;
    },
    editMessage: async (chatId, messageId, text, options) => {
      host.edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      host.deletes.push({ chatId, messageId });
    },
    attachFeedback: () => {},
    statusStats: () => undefined,
    setAssistantConsumer: (consumer) => {
      host.consumer = consumer;
    },
    pendingInbound: () => false,
    inboundMessageId: () => undefined,
    markInboundReplied: () => {},
  };
  return host;
}

function makeCtx(host) {
  const listeners = new Map();
  return {
    host,
    telegram: host,
    logger: { info: () => {} },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
    emit: (sessionId, event) => {
      for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
    },
  };
}

async function setup(goal) {
  const host = makeHost({ goal });
  const ctx = makeCtx(host);
  const { apply } = await import('../dist/extensions/openclaw.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data = {}) => ({ type, data });

test('openclaw heartbeat edits the elapsed title every 30s for a silent tool (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await Promise.resolve();
  assert.equal(host.sends.length, 1);
  assert.equal(host.sends[0].text, '⚙️ Working…', 'normal placeholder stays diff-stable');
  assert.equal(host.edits.length, 0);

  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(host.edits.length, 1, 'heartbeat is an immediate liveness edit');
  assert.match(host.edits[0].text, /⚙️ Working · ⏱️ 30s/);

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.equal(host.sends.length, 1, 'ordinary turns do not spam a second completion message');
});

test('goal turn completion pushes a fresh receipt message (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { host, ctx } = await setup({ objective: 'process the dataset' });
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_1', name: 'python', arguments: 'work' }));
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(host.sends.length, 1, 'goal placeholder only');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await Promise.resolve();
  assert.equal(host.sends.length, 2, 'completion receipt is a fresh push');
  // (markup-tolerant: the objective renders bold in the receipt header)
  assert.match(host.sends[1].text, /✅ (?:<b>)?process the dataset(?:<\/b>)?/);
  assert.equal(host.sends[1].options.disable_notification, false);
});
