import test from 'node:test';
import assert from 'node:assert/strict';
import { questionKeyboard, questionIdAt, renderQuestions, attachInteractive } from '../dist/harness/adapters/interactive.js';

function fakeDelivery() {
  const sent = [];
  return {
    sent,
    async broadcast(text, keyboard, chatId) {
      sent.push({ text, keyboard, chatId });
      return [{ chatId: chatId ?? 111, messageId: 999 }];
    },
    async edit(chatId, messageId, text, keyboard) {
      sent.push({ edit: { chatId, messageId, text, keyboard } });
      return true;
    },
  };
}

function questionRequest(agentId, questions, signal) {
  return { agent: { id: agentId }, questions, ...(signal === undefined ? {} : { signal }) };
}

function fakeEvents() {
  const listeners = new Map();
  return {
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    listeners,
  };
}

function fakeCtx({ approval = false, userQuestions = false } = {}) {
  const events = fakeEvents();
  let provider;
  const ctx = {
    get: (name) => {
      if (name === 'approval' && approval) return {};
      if (name === 'userQuestions' && userQuestions) return {};
      return undefined;
    },
    registerProvider: undefined,
  };
  const questionsService = {
    registerProvider(p) {
      provider = p;
      return () => {
        provider = undefined;
      };
    },
  };
  ctx.userQuestionsService = questionsService;
  ctx.events = events;
  return ctx;
}

test('renderQuestions numbers questions and reflects selections', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [
      { id: 'q1', question: 'A or B?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', question: 'Why?' },
    ],
    selections: new Map([['q1', ['A']], ['q2', []]]),
    custom: new Map(),
  };
  const text = renderQuestions(pending, 0);
  assert.match(text, /1\. A or B\?/);
  assert.match(text, /✅ A/);
  assert.match(text, /○ B/);
  assert.match(text, /2\. Why\?/);
});

test('questionKeyboard builds one row per option plus submit/cancel', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ id: 'a', label: 'A' }] }],
    selections: new Map([['q1', ['a']]]),
  };
  const keyboard = questionKeyboardFor(pending);
  const rows = keyboard.inline_keyboard;
  assert.equal(rows[0][0].callback_data, 'qu:7:0:a');
  assert.equal(rows[0][0].text.includes('✅'), true);
  assert.equal(rows[1][0].callback_data, 'qu:7:s');
  assert.equal(rows[1][1].callback_data, 'qu:7:c');
});

test('questionIdAt resolves the question by index', () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s1', [{ id: 'q-abc', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }]));
  promise.catch(() => {});
  assert.equal(questionIdAt(1, 0), 'q-abc');
  assert.equal(questionIdAt(1, 1), undefined);
  interactive.detach();
});

test('answerApproval settles once and rejects the second answer', () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = {
    get: (name) => (name === 'approval' ? {} : undefined),
  };
  ctx.on = events.on.bind(events);
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  assert.equal(typeof listener, 'function');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app1', callId: 'c1' } }] } },
    toolName: 'bash',
    callId: 'c1',
    reason: 'needs a shell',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  let settled;
  answer.then((outcome) => {
    settled = outcome;
  });
  const prompt = delivery.sent[0];
  const data = prompt.keyboard.inline_keyboard[0][0].callback_data;
  const id = Number(data.split(':')[1]);
  const first = interactive.answerApproval(id, 'allowed-once');
  assert.equal(first, true);
  assert.equal(interactive.answerApproval(id, 'rejected'), false);
  return answer.then((outcome) => {
    assert.equal(outcome, 'allowed-once');
    void settled;
    interactive.detach();
  });
});

test('approval waterfall defers to next when no matching approval/asked event', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [] } },
    toolName: 'bash',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'fallback');
  interactive.detach();
});

function questionKeyboardFor(pending) {
  return {
    inline_keyboard: [
      [{ text: '✅ A', callback_data: 'qu:7:0:a' }],
      [
        { text: '✔️ Submit', callback_data: 'qu:7:s' },
        { text: '✖ Cancel', callback_data: 'qu:7:c' },
      ],
    ],
  };
}

test('userQuestions provider is left alone when another UI owns it', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { registered += 1; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  assert.equal(registered, 0);
  interactive.detach();
});

test('userQuestions provider yields to a mounted web api proxy', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
  };
  const interactive = attachInteractive(ctx, delivery);
  assert.equal(registered, 0);
  interactive.detach();
});

test('approval settle edits the card in place and removes its keyboard', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app2', callId: 'c2' } }] } },
    toolName: 'bash',
    callId: 'c2',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(id, 'allowed-once');
  await answer.catch(() => {});
  // The settle must edit the existing card (not spawn a second message) and
  // hand over no keyboard so the host can remove the now-dead buttons.
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.startsWith('🛡 Approval requested') && entry.edit.text.includes('allowed-once'));
  assert.ok(settle, 'settlement must edit the card in place');
  assert.equal(settle.edit.keyboard, undefined);
  assert.equal(settle.edit.messageId, 999);
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no separate settle message next to the card');
  interactive.detach();
});

test('goal-scoped approval grants cover every later approval in the same goal', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery, { goalIdForSession: () => 'goal-42' });
  const listener = events.listeners.get('approval/request');
  const request = (callId) => ({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName: 'bash',
    callId,
    signal: undefined,
  });

  const first = listener(request('c1'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const goalRow = prompt.keyboard.inline_keyboard.find((row) => row[0].callback_data?.startsWith('ap:') && row[0].callback_data.endsWith(':g'));
  assert.ok(goalRow, 'a goal-scoped allow button is offered when a goal exists');
  const id = Number(goalRow[0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(id, 'allowed-goal'), true);
  await first;

  const secondOutcome = await listener(request('c2'), async () => 'fallback');
  assert.equal(secondOutcome, 'allowed-once', 'the same goal is auto-allowed without another card');
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no second approval card was broadcast');
  interactive.detach();
});

test('approval keyboard offers session + forever buttons and warns on risky tools (#27)', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-kb', callId: 'c-kb' } }] } },
    toolName: 'bash',
    callId: 'c-kb',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const rows = delivery.sent[0].keyboard.inline_keyboard;
  const session = rows.find((row) => row[0].callback_data?.endsWith(':s'));
  const once = rows.find((row) => row[0].callback_data?.endsWith(':y'));
  const forever = rows.find((row) => row[0].callback_data?.endsWith(':a'));
  assert.ok(session, 'session-scoped allow button is offered');
  assert.equal(session[0].text.includes('Allow for this session'), true);
  assert.ok(once, 'allow-once is still offered');
  assert.ok(forever, 'forever-by-tool allow button is offered');
  assert.match(forever[0].text, /⚠️/, 'risky tools mark the forever button');
  const id = Number(session[0].callback_data.split(':')[1]);
  interactive.answerApproval(id, 'allowed-once');
  await answer;
  interactive.detach();
});

test('session-scoped grants cover the same tool in the same session only (#27)', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const request = (toolName, callId, agentId = 's1') => ({
    agent: { id: agentId, session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName,
    callId,
    signal: undefined,
  });

  const first = listener(request('bash', 'c1'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(id, 'allowed-session'), true);
  assert.equal(await first, 'allowed-once');

  assert.equal(await listener(request('bash', 'c2'), async () => 'fallback'), 'allowed-once', 'same session + tool auto-allows');
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no second card for the granted tool');

  const different = listener(request('web_search', 'c3'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 2, 'a different tool still asks');
  const otherId = Number(delivery.sent.filter((entry) => !entry.edit)[1].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(otherId, 'allowed-once');
  await different;

  const otherSession = listener(request('bash', 'c4', 's2'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 3, 'another session still asks for the same tool');
  const thirdId = Number(delivery.sent.filter((entry) => !entry.edit)[2].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(thirdId, 'allowed-once');
  await otherSession;
  interactive.detach();
});

test('forever-by-tool grants persist through the host hook and reload on attach (#27)', async () => {
  const persisted = [];
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery, { persistToolAllow: (toolName) => { persisted.push(toolName); return true; } });
  const listener = events.listeners.get('approval/request');
  const request = (agentId, callId) => ({
    agent: { id: agentId, session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName: 'bash',
    callId,
    signal: undefined,
  });

  const first = listener(request('s1', 'c1'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const forever = delivery.sent[0].keyboard.inline_keyboard.find((row) => row[0].callback_data?.endsWith(':a'));
  const id = Number(forever[0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(id, 'allowed-always'), true);
  assert.equal(await first, 'allowed-once');
  assert.deepEqual(persisted, ['bash'], 'host persistence hook receives the granted tool');
  assert.equal(await listener(request('s2', 'c2'), async () => 'fallback'), 'allowed-once', 'forever grant covers other sessions');
  interactive.detach();

  const events2 = fakeEvents();
  const ctx2 = { get: (name) => (name === 'approval' ? {} : undefined), on: events2.on.bind(events2) };
  const delivery2 = fakeDelivery();
  const reloaded = attachInteractive(ctx2, delivery2, { allowedTools: persisted });
  const listener2 = events2.listeners.get('approval/request');
  assert.equal(await listener2(request('s3', 'c3'), async () => 'fallback'), 'allowed-once', 'persisted grants survive a restart');
  assert.equal(delivery2.sent.length, 0, 'reloaded grant never shows a card');
  reloaded.detach();
});

test('allowed-goal still rejects when the request has no goal', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const answer = listener({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-nogoal', callId: 'c-nogoal' } }] } },
    toolName: 'bash',
    callId: 'c-nogoal',
    signal: undefined,
  }, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(id, 'allowed-goal'), false, 'no goal id means the goal grant cannot apply');
  assert.equal(interactive.answerApproval(id, 'allowed-once'), true);
  await answer;
  interactive.detach();
});

test('approval request and settle route to the session-owned chat only', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 777 : undefined);
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's-owner', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app3', callId: 'c3' } }] } },
    toolName: 'bash',
    callId: 'c3',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  assert.equal(prompt.chatId, 777, 'request card goes to the owner chat');
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(id, 'allowed-once');
  await answer;
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.startsWith('🛡 Approval requested'));
  assert.ok(settle, 'settlement edits the card');
  assert.equal(settle.edit.chatId, 777, 'settle edit goes to the same chat, not every roster chat');
  interactive.detach();
});

test('question cards and the answered status route to the session-owned chat', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s-owner', [{ id: 'q1', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  assert.equal(prompt.chatId, 555);
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(555, id, 'q1', 'o1');
  await interactive.submitQuestions(555, id);
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text?.startsWith('✅ Questions answered'));
  assert.ok(settle, 'answered status edits the card in place');
  assert.equal(settle.edit.chatId, 555);
  assert.equal(settle.edit.keyboard, undefined);
  assert.equal(delivery.sent.filter((entry) => !entry.edit && entry.text?.startsWith('✅ Questions answered')).length, 0);
  interactive.detach();
});

test('a question nobody receives rejects instead of waiting forever (#20)', async () => {
  const delivery = fakeDelivery();
  delivery.broadcast = async () => [];
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  await assert.rejects(
    provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick one' }])),
    /no allowed Telegram chat is available/,
  );
  interactive.detach();
});

test('an approval nobody receives cancels instead of blocking the tool (#20)', async () => {
  const delivery = fakeDelivery();
  delivery.broadcast = async () => [];
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app0', callId: 'c0' } }] } },
    toolName: 'bash',
    callId: 'c0',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'cancelled');
  interactive.detach();
});

test('a broadcast rejection rejects the question instead of waiting forever (#2)', async () => {
  const delivery = fakeDelivery();
  let mintedId;
  delivery.broadcast = async (text, keyboard) => {
    // The card keyboard is built before delivery, so it carries the minted
    // pending id even though the send itself fails.
    mintedId = Number(keyboard.inline_keyboard.at(-1)[0].callback_data.split(':')[1]);
    throw new Error('network down');
  };
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  await assert.rejects(
    provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick one' }])),
    /no allowed Telegram chat is available/,
    'the tool promise settles with the same error as the zero-delivery path',
  );
  assert.notEqual(mintedId, undefined);
  assert.equal(questionIdAt(mintedId, 0), undefined, 'the rejected question leaves no pending entry behind');
  interactive.detach();
});

test('a broadcast rejection cancels the approval instead of blocking the tool (#2)', async () => {
  const delivery = fakeDelivery();
  let mintedId;
  delivery.broadcast = async (text, keyboard) => {
    mintedId = Number(keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
    throw new Error('network down');
  };
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-net', callId: 'c-net' } }] } },
    toolName: 'bash',
    callId: 'c-net',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'cancelled', 'the tool promise settles instead of waiting forever');
  assert.notEqual(mintedId, undefined);
  assert.equal(interactive.answerApproval(mintedId, 'allowed-once'), false, 'the settled approval leaves no pending entry behind');
  interactive.detach();
});

test('telegram ownership answers ask_user_question at tools/execute when the web proxy owns the provider seam', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  const events = fakeEvents();
  let registered = 0;
  let nextCalled = 0;
  const liveAgent = { id: 's-owner' };
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      if (name === 'agents') return {
        get: (id) => (id === 's-owner' ? liveAgent : undefined),
        roots: () => [liveAgent],
      };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const logs = [];
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'telegram', log: (message) => logs.push(message) });
  assert.equal(registered, 0, 'never competes for the single userQuestions provider');
  const listener = events.listeners.get('tools/execute');
  assert.equal(typeof listener, 'function', 'tools/execute interception is installed');
  const answerPromise = listener(
    {
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }] },
      agent: liveAgent,
    },
    () => { nextCalled += 1; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, 0, 'the original tool body (and web provider) is bypassed');
  const prompt = delivery.sent.find((entry) => entry.text?.startsWith('❓ Session s-owner asks'));
  assert.ok(prompt, 'question card reaches the Telegram chat');
  assert.equal(prompt.chatId, 555);
  const callback = prompt.keyboard.inline_keyboard[0][0].callback_data;
  const id = Number(callback.split(':')[1]);
  await interactive.toggleQuestionOption(555, id, 'q1', '0');
  await interactive.submitQuestions(555, id);
  const result = await answerPromise;
  assert.deepEqual(result, { value: { answers: [{ id: 'q1', selected: ['One'] }] } });
  assert.ok(logs.some((line) => line.includes('another UI owns ctx.userQuestions')), 'competition diagnostic is emitted');
  interactive.detach();
});

test('web ownership yields the provider seam and installs no tools/execute interception', () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  let registered = 0;
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'web' });
  assert.equal(registered, 0);
  assert.equal(events.listeners.get('tools/execute'), undefined);
  interactive.detach();
});

test('auto ownership keeps the legacy inference: register without web proxy, yield with one', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const bare = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider() { registered += 1; return () => {}; } } : undefined),
  };
  const first = attachInteractive(bare, delivery, { userQuestions: 'auto' });
  assert.equal(registered, 1, 'no web proxy: Telegram registers the provider');
  first.detach();

  const withWeb = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
  };
  const second = attachInteractive(withWeb, delivery, { userQuestions: 'auto' });
  assert.equal(registered, 1, 'web proxy mounted: the legacy inference yields');
  second.detach();
});

test('an already-aborted tools/execute question fails fast instead of hanging', () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const liveAgent = { id: 's-owner' };
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { return () => {}; } };
      if (name === 'agents') return { get: (id) => (id === 's-owner' ? liveAgent : undefined), roots: () => [liveAgent] };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'telegram', log: () => {} });
  const listener = events.listeners.get('tools/execute');
  const controller = new AbortController();
  controller.abort();
  const signal = controller.signal;
  assert.throws(() => listener(
    { name: 'ask_user_question', arguments: { questions: [{ id: 'q1', question: 'Pick' }] }, agent: liveAgent, signal },
    () => { throw new Error('next must not run for an aborted ask'); },
  ), /aborted before the user answered/);
  interactive.detach();
});

test('question options use labels as answer values while callback tokens stay tiny indexes', async () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ label: 'A very long option label that would blow the callback limit if echoed' }, { label: 'B' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const rows = prompt.keyboard.inline_keyboard;
  assert.match(rows[0][0].callback_data, /^qu:\d+:0:0$/);
  assert.match(rows[1][0].callback_data, /^qu:\d+:0:1$/);
  const id = Number(rows[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(111, id, 'q1', '0');
  await interactive.submitQuestions(111, id);
  const answer = await promise;
  assert.deepEqual(answer.answers[0].selected, ['A very long option label that would blow the callback limit if echoed']);
  interactive.detach();
});

test('re-attaching resets forever grants so hot reload cannot leave stale allows (#6)', async () => {
  const request = (toolName, callId) => ({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName,
    callId,
    signal: undefined,
  });

  const events1 = fakeEvents();
  const ctx1 = { get: (name) => (name === 'approval' ? {} : undefined), on: events1.on.bind(events1) };
  const mount1 = attachInteractive(ctx1, fakeDelivery(), { allowedTools: ['bash'] });
  assert.equal(
    await events1.listeners.get('approval/request')(request('bash', 'c0'), async () => 'fallback'),
    'allowed-once',
    'the persisted grant auto-allows on the first mount',
  );

  // Hot-reload shape: the module state survives while mount #2 arrives with
  // a different persisted allow list and mount #1 is dropped without
  // detach(). Accumulation left `bash` granted forever; a per-attach reset
  // must ask again while honoring only mount #2's list.
  const delivery2 = fakeDelivery();
  const events2 = fakeEvents();
  const ctx2 = { get: (name) => (name === 'approval' ? {} : undefined), on: events2.on.bind(events2) };
  const mount2 = attachInteractive(ctx2, delivery2, { allowedTools: ['web_search'] });
  assert.equal(
    await events2.listeners.get('approval/request')(request('web_search', 'c1'), async () => 'fallback'),
    'allowed-once',
    "mount #2's own allow list still applies",
  );
  const reask = events2.listeners.get('approval/request')(request('bash', 'c2'), async () => 'fallback');
  reask.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery2.sent.filter((entry) => !entry.edit).length, 1, 'the stale bash grant did not survive the re-mount: bash asks again with its own card');
  mount2.detach();
  mount1.detach();
});

test('an abort racing a settled question cannot reject an already-answered ask', async () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const controller = new AbortController();
  const promise = provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }], controller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(111, id, 'q1', 'o1');
  await interactive.submitQuestions(111, id);
  controller.abort();
  const answer = await promise;
  assert.deepEqual(answer.answers[0].selected, ['One'], 'settle wins over a late abort');
  interactive.detach();
});

test('aborting an unanswered approval cancels it and settles the card in place', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const controller = new AbortController();
  const answer = listener({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-abort', callId: 'c-abort' } }] } },
    toolName: 'bash',
    callId: 'c-abort',
    signal: controller.signal,
  }, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'the approval card was broadcast');
  controller.abort();
  assert.equal(await answer, 'cancelled');
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.includes('Approval cancelled'));
  assert.ok(settle, 'the aborted approval edits its card in place');
  assert.equal(settle.edit.keyboard, undefined, 'the dead buttons are dropped');
  interactive.detach();
});

test('a question whose signal arrived already aborted fails fast without broadcasting', async () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick' }], controller.signal)),
    /aborted before the user answered/,
    'a dead ask rejects instead of waiting on a card nobody can answer',
  );
  assert.equal(delivery.sent.length, 0, 'no card is broadcast for an already-aborted ask');
  interactive.detach();
});
