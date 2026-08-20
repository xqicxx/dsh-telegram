import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTransport() {
  const sent = [];
  return {
    sent,
    sendText: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
    },
  };
}

function makeBridge(transport) {
  const agent = { id: 'agent-1', send: () => {}, followup: () => {} };
  const listeners = new Map();
  const ctx = {
    agents: {
      get: (id) => (id === 'agent-1' ? agent : undefined),
      list: () => [agent],
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
  return { agent, ctx };
}

async function setup() {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  return { bridge, transport, ctx };
}

const am = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const turnEnd = (reason = { kind: 'completed' }) => ({ type: 'turn/end', data: { reason } });

test('legacy mode (no consumer): assistant text is forwarded immediately as a native reply', async () => {
  const { bridge, transport, ctx } = await setup();
  assert.equal(bridge.deliver(7, 'hi', 501).ok, true);
  ctx.emit('session/event', { id: 'agent-1' }, am('thinking out loud'));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, 7);
  assert.equal(transport.sent[0].text, 'thinking out loud');
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
  assert.equal(bridge.hasPendingInbound(), false, 'prose reply satisfies the inbound');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 1, 'no reminder after a prose reply');
});

test('legacy mode normalizes model Markdown to Telegram HTML', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.deliver(7, 'hi', 501);
  ctx.emit('session/event', { id: 'agent-1' }, am('**bold** and *italic*\n\n- item'));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, '<b>bold</b> and <i>italic</i>\n\n\u2022 item');
  assert.equal(transport.sent[0].extra.parse_mode, 'HTML');
});

test('legacy mode keeps the reminder when nothing answered', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.ok(transport.sent[0].text.includes('The turn ended without a telegram_reply'));
});

test('consumer mode: assistant text goes to the consumer, not the chat', async () => {
  const { bridge, transport, ctx } = await setup();
  const consumed = [];
  bridge.setAssistantConsumer((chatId, text) => consumed.push({ chatId, text }));
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, am('first'));
  ctx.emit('session/event', { id: 'agent-1' }, am('second'));
  await sleep(10);
  assert.equal(transport.sent.length, 0);
  assert.deepEqual(consumed, [
    { chatId: 7, text: 'first' },
    { chatId: 7, text: 'second' },
  ]);
  assert.equal(bridge.hasPendingInbound(), true, 'consumer owns the answered bookkeeping');
});

test('consumer mode: core suppresses the reminder and honors markInboundReplied', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.setAssistantConsumer(() => {});
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  await sleep(10);
  assert.equal(transport.sent.length, 0, 'core reminder is suppressed while a consumer is mounted');
  bridge.markInboundReplied();
  assert.equal(bridge.hasPendingInbound(), false);
});

test('autonomous turn errors reach the chat even without an inbound message', async () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  bridge.bindAgent(7, 'agent-1');
  // No deliver(): this is a goal/maintenance turn, not a reply to a message.
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd({ kind: 'error', error: { message: 'Stream ended without finish_reason' } }));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, 7);
  assert.ok(transport.sent[0].text.startsWith('\u274C'));
  assert.ok(transport.sent[0].text.includes('Stream ended without finish_reason'));
  assert.equal(transport.sent[0].extra.reply_parameters, undefined);
});

test('consumer mode still surfaces turn errors verbatim', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.setAssistantConsumer(() => {});
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd({ kind: 'error', error: { message: 'boom <fail>' } }));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.ok(transport.sent[0].text.startsWith('\u274C'));
  assert.ok(transport.sent[0].text.includes('boom &lt;fail&gt;'));
});

test('unregistering the consumer restores legacy forwarding', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.setAssistantConsumer(() => {});
  bridge.setAssistantConsumer(undefined);
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, am('back to legacy'));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, 'back to legacy');
});

test('turn lifecycle notifies the typing callbacks (start -> end)', async () => {
  const calls = [];
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onTurnRunning: (chatId, running) => calls.push({ chatId, running }),
    log: () => {},
  });
  bridge.attach();
  bridge.deliver(7, 'hi');
  ctx.emit('session/event', { id: 'agent-1' }, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  assert.deepEqual(calls, [
    { chatId: 7, running: true },
    { chatId: 7, running: false },
  ]);
  assert.equal(transport.sent.length, 1, 'no typing-hook chat message; only the legacy turn-end reminder');
  assert.ok(transport.sent[0].text.includes('telegram_reply'));
});

test('legacy delivery reports the Telegram message id for feedback buttons', async () => {
  const transport = makeTransport();
  transport.sendText = async (chatId, text, extra) => {
    transport.sent.push({ chatId, text, extra });
    return 321;
  };
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const deliveries = [];
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onAssistantDelivered: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      deliveries.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    log: () => {},
  });
  bridge.attach();
  bridge.deliver(7, 'hi', 501);
  ctx.emit('session/event', { id: 'agent-1' }, {
    type: 'assistant/message',
    data: { message: { id: 'assistant-message-42', content: [{ type: 'text', text: 'answer' }] } },
  });
  await sleep(10);
  assert.deepEqual(deliveries, [
    { chatId: 7, telegramMessageId: 321, sessionId: 'agent-1', assistantMessageId: 'assistant-message-42' },
  ]);
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
});

test('outbound.liveFeed=false ignores a mounted stream consumer and restores legacy forwarding', async () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML', liveFeed: false } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  const consumed = [];
  bridge.setAssistantConsumer((chatId, text) => consumed.push({ chatId, text }));
  assert.equal(bridge.deliver(7, 'hi', 501).ok, true);
  ctx.emit('session/event', { id: 'agent-1' }, am('answer'));
  await sleep(10);
  assert.deepEqual(consumed, [], 'consumer is registered but disabled by config');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, 'answer');
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
  assert.equal(bridge.hasPendingInbound(), false);
});

test('a failed telegram_reply leaves the inbound pending for the error path', async () => {
  const transport = {
    sent: [],
    sendText: async () => { throw new Error('send failed'); },
  };
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.deliver(7, 'hi', 501);
  await assert.rejects(bridge.sendOutbound(7, 'reply', { replyToInbound: true }));
  assert.equal(bridge.hasPendingInbound(7), true, 'failed send must not mark the inbound answered');
});

test('deliver binds the chat and installs the inbound before followup can emit synchronously', async () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const running = [];
  const agent = ctx.agents.get('agent-1');
  agent.followup = () => {
    ctx.emit('session/event', { id: 'agent-1' }, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', { id: 'agent-1' }, am('synchronous answer'));
    ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
  };
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onTurnRunning: (chatId, isRunning) => running.push({ chatId, isRunning }),
    log: () => {},
  });
  bridge.attach();
  assert.equal(bridge.deliver(7, 'hi', 501).ok, true);
  assert.equal(bridge.chatIdForAgent('agent-1'), 7, 'binding must exist before followup runs');
  assert.equal(bridge.inboundMessageIdValue(7), 501, 'inbound quote must exist before followup runs');
  await sleep(10);
  assert.deepEqual(running, [
    { chatId: 7, isRunning: true },
    { chatId: 7, isRunning: false },
  ], 'synchronous turn lifecycle events are routed, not dropped');
  assert.equal(transport.sent.length, 1, 'only the synchronous answer, no reminder');
  assert.equal(transport.sent[0].chatId, 7);
  assert.equal(transport.sent[0].text, 'synchronous answer');
  assert.deepEqual(transport.sent[0].extra.reply_parameters, { message_id: 501 });
  assert.equal(bridge.hasPendingInbound(7), false);
});

test('events for an unbound agent are logged as dropped with a per-agent summary', () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const logs = [];
  return import('../dist/harness/bridge.js').then(async ({ Bridge }) => {
    const bridge = new Bridge({
      ctx,
      transport,
      getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
      onStateChange: () => {},
      log: (message) => logs.push(message),
    });
    bridge.attach();
    bridge.setCurrentAgent('agent-unknown'); // Telegram-touched agent without a chat binding
    ctx.emit('session/event', { id: 'agent-unknown' }, am('orphan prose'));
    ctx.emit('session/event', { id: 'agent-unknown' }, turnEnd());
    assert.equal(logs.length, 2, 'first drop logs, and turn/end repeats so a lost final answer stays visible');
    assert.match(logs[0], /event dropped: no chat for agent agent-unknown/);
    assert.match(logs[1], /2 total dropped/);
  });
});

// ---- issue #37: classified, user-readable upstream failures ----

test('formatTurnFailure classifies opaque 429 literals as a transient rate limit (#37)', async () => {
  const { formatTurnFailure } = await import('../dist/harness/bridge.js');
  const text = formatTurnFailure('429 status code (no body)');
  assert.ok(text.startsWith('\u23F3'), 'rate-limited tone, not a hard ❌');
  assert.ok(text.includes('Rate limited'), 'says what happened');
  assert.equal(text.includes('no body'), false, 'the opaque SDK literal is dropped');
});

test('formatTurnFailure keeps informative rate-limit details alongside the tone (#37)', async () => {
  const { formatTurnFailure } = await import('../dist/harness/bridge.js');
  const text = formatTurnFailure('429 You exceeded your current quota, please check your plan');
  assert.ok(text.startsWith('\u23F3'));
  assert.ok(text.includes('quota'), 'the provider detail survives');
});

test('formatTurnFailure classifies 5xx as provider-side trouble (#37)', async () => {
  const { formatTurnFailure } = await import('../dist/harness/bridge.js');
  const text = formatTurnFailure('500 status code (no body)');
  assert.ok(text.startsWith('\u26A0\uFE0F'), 'server-error tone');
  assert.ok(text.includes('temporarily unavailable'));
  assert.equal(text.includes('no body'), false);
});

test('formatTurnFailure keeps verbatim escaped text for unknown failures (#37)', async () => {
  const { formatTurnFailure } = await import('../dist/harness/bridge.js');
  const text = formatTurnFailure('boom <fail>');
  assert.ok(text.startsWith('\u274C'));
  assert.ok(text.includes('boom &lt;fail&gt;'));
});

test('a 429 turn error surfaces the rate-limit tone in the chat (#37)', async () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  bridge.bindAgent(7, 'agent-1');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd({ kind: 'error', error: { message: '429 status code (no body)' } }));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.ok(transport.sent[0].text.startsWith('\u23F3'), 'rate limit reads as transient, not a crash');
  assert.equal(transport.sent[0].text.includes('429 status code (no body)'), false, 'the opaque literal never reaches the user');
});

test('a 5xx turn error surfaces the provider-error tone in the chat (#37)', async () => {
  const transport = makeTransport();
  const { ctx } = makeBridge(transport);
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    log: () => {},
  });
  bridge.attach();
  bridge.bindAgent(7, 'agent-1');
  ctx.emit('session/event', { id: 'agent-1' }, turnEnd({ kind: 'error', error: { message: '503 Service Unavailable' } }));
  await sleep(10);
  assert.equal(transport.sent.length, 1);
  assert.ok(transport.sent[0].text.startsWith('\u26A0\uFE0F'), '5xx reads as provider-side breakage');
  assert.ok(transport.sent[0].text.includes('503 Service Unavailable'), 'the provider detail survives');
});
