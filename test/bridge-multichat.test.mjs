import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTransport() {
  const sent = [];
  return {
    sent,
    sendText: async (chatId, text, extra) => {
      const messageId = sent.length + 1;
      sent.push({ chatId, text, extra, messageId });
      return messageId;
    },
  };
}

function makeCtx(agents) {
  const listeners = new Map();
  return {
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      list: () => agents,
    },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
    emit: (name, ...args) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
}

const am = (text, id) => ({
  type: 'assistant/message',
  data: { message: { id, content: [{ type: 'text', text }] } },
});
const turnEnd = () => ({ type: 'turn/end', data: { reason: { kind: 'completed' } } });

test('per-chat bindings route concurrent turns without cross-talk', async () => {
  const transport = makeTransport();
  const agent1 = { id: 'agent-1', send: () => {}, followup: () => {} };
  const agent2 = { id: 'agent-2', send: () => {}, followup: () => {} };
  const ctx = makeCtx([agent1, agent2]);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const delivered = [];
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onAssistantDelivered: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      delivered.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    log: () => {},
  });
  bridge.attach();

  bridge.bindAgent(7, 'agent-1');
  bridge.bindAgent(8, 'agent-2');
  assert.equal(bridge.agentIdForChat(7), 'agent-1');
  assert.equal(bridge.agentIdForChat(8), 'agent-2');
  assert.equal(bridge.chatIdForAgent('agent-1'), 7);
  assert.equal(bridge.chatIdForAgent('agent-2'), 8);

  assert.equal(bridge.deliver(7, 'from chat 7', 701).ok, true);
  assert.equal(bridge.deliver(8, 'from chat 8', 801).ok, true);
  assert.equal(bridge.hasPendingInbound(7), true);
  assert.equal(bridge.hasPendingInbound(8), true);
  assert.equal(bridge.inboundForAgent('agent-1').chatId, 7, 'agent-scoped inbound lookup ignores the most recent touch');
  assert.equal(bridge.inboundForAgent('agent-2').chatId, 8);

  ctx.emit('session/event', { id: 'agent-1' }, am('answer for seven', 'msg-7'));
  ctx.emit('session/event', { id: 'agent-2' }, am('answer for eight', 'msg-8'));
  await sleep(10);

  assert.deepEqual(transport.sent.map((entry) => ({ chatId: entry.chatId, text: entry.text })), [
    { chatId: 7, text: 'answer for seven' },
    { chatId: 8, text: 'answer for eight' },
  ]);
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 701 });
  assert.deepEqual(transport.sent[1].extra.reply_parameters, { message_id: 801 });
  assert.deepEqual(delivered, [
    { chatId: 7, telegramMessageId: 1, sessionId: 'agent-1', assistantMessageId: 'msg-7' },
    { chatId: 8, telegramMessageId: 2, sessionId: 'agent-2', assistantMessageId: 'msg-8' },
  ]);

  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  ctx.emit('session/event', { id: 'agent-2' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 2, 'both prose replies satisfied their own inbound; no cross reminders');
});

test('a chat binding is cleared without disturbing another chat', async () => {
  const transport = makeTransport();
  const agent1 = { id: 'agent-1', send: () => {}, followup: () => {} };
  const agent2 = { id: 'agent-2', send: () => {}, followup: () => {} };
  const ctx = makeCtx([agent1, agent2]);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.bindAgent(7, 'agent-1');
  bridge.bindAgent(8, 'agent-2');
  bridge.bindAgent(7, undefined);
  assert.equal(bridge.agentIdForChat(7), undefined);
  assert.equal(bridge.agentIdForChat(8), 'agent-2');
  assert.equal(bridge.chatIdForAgent('agent-2'), 8);
});

test('one agent stays bound to one chat: a newer bind/touch evicts the previous chat', async () => {
  const transport = makeTransport();
  const agents = [{ id: 'agent-1', send: () => {}, followup: () => {} }];
  const ctx = makeCtx(agents);
  const bridge = await makeBridge(ctx, transport);
  bridge.attach();

  bridge.bindAgent(7, 'agent-1');
  bridge.deliver(7, 'from chat 7', 701);
  bridge.bindAgent(8, 'agent-1');
  assert.equal(bridge.agentIdForChat(7), undefined, 'bind must evict the previous chat owning the agent');
  assert.equal(bridge.chatIdForAgent('agent-1'), 8);

  ctx.emit('session/event', { id: 'agent-1' }, am('answer', 'msg-1'));
  await sleep(10);
  assert.deepEqual(transport.sent.map((entry) => entry.chatId), [8], 'events route to the new owner only');

  bridge.deliver(9, 'steal attempt');
  assert.equal(bridge.agentIdForChat(8), undefined, 'touch keeps the index exclusive too');
  assert.equal(bridge.chatIdForAgent('agent-1'), 9);
});

function makeBridge(ctx, transport) {
  return import('../dist/harness/bridge.js').then(({ Bridge }) =>
    new Bridge({
      ctx,
      transport,
      getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
      onStateChange: () => {},
      log: () => {},
    }),
  );
}

test('a chat with a dead bound agent never borrows another chat live agent', async () => {
  const transport = makeTransport();
  const calls = [];
  const agents = [
    { id: 'agent-1', send: () => {}, followup: () => {} },
    { id: 'agent-2', send: () => {}, followup: () => calls.push('agent-2') },
  ];
  const ctx = makeCtx(agents);
  const bridge = await makeBridge(ctx, transport);
  bridge.bindAgent(7, 'agent-1');
  bridge.bindAgent(8, 'agent-2');
  agents.splice(0, 1); // chat 7's agent is disposed while chat 8 stays live
  const res = bridge.deliver(7, 'should not cross chats');
  assert.equal(res.ok, false);
  assert.deepEqual(calls, [], 'chat 7 must fail closed instead of stealing agent-2');
});

test('rebinding a chat to a new session clears the old inbound quote state', async () => {
  const transport = makeTransport();
  const agents = [
    { id: 'agent-1', send: () => {}, followup: () => {} },
    { id: 'agent-2', send: () => {}, followup: () => {} },
  ];
  const ctx = makeCtx(agents);
  const bridge = await makeBridge(ctx, transport);
  bridge.attach();

  bridge.bindAgent(7, 'agent-1');
  assert.equal(bridge.deliver(7, 'old inbound', 701).ok, true);
  bridge.bindAgent(7, 'agent-2');
  assert.equal(bridge.inboundMessageIdValue(7), undefined, 'stale inbound id must not survive a rebind');

  assert.equal(bridge.deliver(7, 'new inbound', 702).ok, true);
  ctx.emit('session/event', { id: 'agent-2' }, am('answer for the new session', 'msg-new'));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, 7);
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 702 });
});

test('malformed assistant events never throw inside the bridge listener', async () => {
  const transport = makeTransport();
  const agents = [{ id: 'agent-1', send: () => {}, followup: () => {} }];
  const ctx = makeCtx(agents);
  const bridge = await makeBridge(ctx, transport);
  bridge.attach();
  bridge.bindAgent(7, 'agent-1');
  bridge.deliver(7, 'hello', 710);
  assert.doesNotThrow(() => {
    ctx.emit('session/event', { id: 'agent-1' }, { type: 'assistant/message', data: undefined });
  });
  await sleep(5);
  assert.equal(transport.sent.length, 0);
});

test('detach clears bindings and inbound state', async () => {
  const transport = makeTransport();
  const agents = [{ id: 'agent-1', send: () => {}, followup: () => {} }];
  const ctx = makeCtx(agents);
  const bridge = await makeBridge(ctx, transport);
  bridge.attach();
  bridge.bindAgent(7, 'agent-1');
  bridge.deliver(7, 'hello', 710);
  bridge.detach();
  assert.equal(bridge.agentIdForChat(7), undefined);
  assert.equal(bridge.chatIdForAgent('agent-1'), undefined);
  assert.equal(bridge.hasPendingInbound(7), false);
});

test('state-change notifications call the callback exactly once (no self-recursion)', async () => {
  const transport = makeTransport();
  const agents = [{ id: 'agent-1', send: () => {}, followup: () => {} }];
  const ctx = makeCtx(agents);
  let calls = 0;
  const bridge = await import('../dist/harness/bridge.js').then(({ Bridge }) =>
    new Bridge({
      ctx,
      transport,
      getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
      onStateChange: () => { calls += 1; },
      log: () => {},
    }),
  );
  bridge.bindAgent(7, 'agent-1');
  bridge.bindAgent(7, undefined);
  assert.equal(calls, 2, 'bindAgent must forward to the callback exactly once per state change');
});

test('a throwing state-change callback is contained and logged with its stack', async () => {
  const transport = makeTransport();
  const agents = [{ id: 'agent-1', send: () => {}, followup: () => {} }];
  const ctx = makeCtx(agents);
  const logs = [];
  const bridge = await import('../dist/harness/bridge.js').then(({ Bridge }) =>
    new Bridge({
      ctx,
      transport,
      getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
      onStateChange: () => { throw new Error('panel boom'); },
      log: (message, error) => { logs.push({ message, error }); },
    }),
  );
  assert.doesNotThrow(() => bridge.bindAgent(7, 'agent-1'));
  assert.equal(logs.length, 1, 'a single failure must log once instead of overflowing the stack');
  assert.equal(logs[0].message, 'state change handler failed');
  assert.match(String(logs[0].error), /panel boom/);
  assert.match(String(logs[0].error), /bridge-multichat\.test\.mjs|at /);
});
