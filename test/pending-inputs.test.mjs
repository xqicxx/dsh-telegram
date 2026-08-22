/**
 * B-4r regression suite: the seven single-slot pending inputs became a
 * per-chat pending-input store (`core/chat-hub.ts`) with a lazy 5-minute TTL.
 *
 * Covered here:
 * - store semantics at the hub level (per-chat isolation, supersede-on-arm,
 *   lazy expiry with an injectable clock, kind-filtered take, cancel kinds,
 *   disposeChat/disposeAll);
 * - /cancel coverage for all seven kinds with their exact reply texts
 *   (unit level, through the real cancelCommand + real hub API);
 * - end-to-end arming/consumption through the booted plugin: two chats
 *   arming /rename do not clobber each other, an expired input falls back
 *   to normal session delivery, a live input is consumed exactly once,
 *   the rename and steer consumption branch bodies still fire, and a
 *   cancelled flow stops hijacking subsequent ordinary messages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';
import { createChatHub, PENDING_INPUT_TTL_MS } from '../dist/core/chat-hub.js';
import { cancelCommand } from '../dist/core/commands.js';

// ---------------------------------------------------------------------------
// Hub-level store semantics (injectable clock)
// ---------------------------------------------------------------------------

function makeTestHub(now) {
  return createChatHub({
    getTransport: () => undefined,
    currentAgent: () => undefined,
    stopLiveFeed: () => {},
    log: () => {},
    ...(now ? { now } : {}),
  });
}

test('PENDING_INPUT_TTL_MS is the sanctioned five minutes', () => {
  assert.equal(PENDING_INPUT_TTL_MS, 5 * 60_000);
});

test('pending-input store: per-chat isolation, supersede, single consume', () => {
  const hub = makeTestHub();
  // Two chats arming the SAME kind must not clobber each other.
  hub.armPending(1, { kind: 'rename', sessionId: 'agent-a' });
  hub.armPending(2, { kind: 'rename', sessionId: 'agent-b' });
  const a = hub.takePending(1);
  assert.equal(a.kind, 'rename');
  assert.equal(a.sessionId, 'agent-a');
  const b = hub.takePending(2);
  assert.equal(b.kind, 'rename');
  assert.equal(b.sessionId, 'agent-b');
  // Take deletes: a second take reads as "nothing armed".
  assert.equal(hub.takePending(1), undefined);
  // Arming a different kind in one chat supersedes the previous input…
  hub.armPending(3, { kind: 'rename', sessionId: 'old' });
  hub.armPending(3, { kind: 'steer', sessionId: 'new' });
  const superseded = hub.takePending(3);
  assert.equal(superseded.kind, 'steer');
  assert.equal(superseded.sessionId, 'new');
});

test('pending-input store: armPending stamps expiresAt = now + TTL and expiry is lazy', () => {
  let nowMs = 1_000_000;
  const hub = makeTestHub(() => nowMs);
  hub.armPending(4, { kind: 'search' });
  const armed = hub.takePending(4);
  assert.equal(armed.expiresAt, nowMs + PENDING_INPUT_TTL_MS);

  hub.armPending(5, { kind: 'search' });
  nowMs += PENDING_INPUT_TTL_MS; // exactly at the boundary → expired
  assert.equal(hub.takePending(5), undefined);
  assert.equal(hub.cancelPending(5), undefined); // already dropped lazily

  hub.armPending(6, { kind: 'mkdir', path: '/tmp/x' });
  nowMs += PENDING_INPUT_TTL_MS + 1;
  assert.equal(hub.cancelPending(6), undefined);
});

test('pending-input store: kind-filtered take leaves other kinds armed', () => {
  const hub = makeTestHub();
  hub.armPending(7, { kind: 'rename', sessionId: 'keep-me' });
  // /subagentprompt must not swallow an armed rename.
  assert.equal(hub.takePending(7, 'subagentPrompt'), undefined);
  const kept = hub.takePending(7, 'rename');
  assert.ok(kept, 'the non-matching take must leave the entry armed');
  assert.equal(kept.kind, 'rename');
  assert.equal(kept.sessionId, 'keep-me');
  assert.equal(hub.takePending(7), undefined);
});

test('pending-input store: cancelPending returns the removed input kind', () => {
  const hub = makeTestHub();
  assert.equal(hub.cancelPending(8), undefined);
  hub.armPending(8, { kind: 'presetCopy', sourceId: 'src' });
  assert.equal(hub.cancelPending(8), 'presetCopy');
  assert.equal(hub.cancelPending(8), undefined);
});

test('pending-input store: disposeChat clears only that chat; disposeAll clears wholesale', () => {
  const hub = makeTestHub();
  hub.armPending(9, { kind: 'search' });
  hub.armPending(10, { kind: 'steer', sessionId: 's' });
  hub.disposeChat(9);
  assert.equal(hub.takePending(9), undefined);
  assert.equal(hub.takePending(10)?.kind, 'steer');
  hub.armPending(11, { kind: 'pluginAdd' });
  hub.disposeAll();
  assert.equal(hub.takePending(10), undefined);
  assert.equal(hub.takePending(11), undefined);
});

// ---------------------------------------------------------------------------
// /cancel × all seven kinds (real cancelCommand over the real hub API)
// ---------------------------------------------------------------------------

test('/cancel clears each of the seven pending kinds with its exact text', async () => {
  const hub = makeTestHub();
  const deps = { cancelPending: hub.cancelPending };
  const cases = [
    [{ kind: 'presetCopy', sourceId: 'src' }, 'Preset copy cancelled.'],
    [{ kind: 'mkdir', path: '/tmp/folder' }, 'New-folder cancelled.'],
    [{ kind: 'pluginAdd' }, 'Plugin add cancelled.'],
    [{ kind: 'rename', sessionId: 'r1' }, 'Rename cancelled.'],
    [{ kind: 'steer', sessionId: 'r2' }, 'Steer cancelled.'],
    [{ kind: 'search' }, 'Search cancelled.'],
    [{ kind: 'subagentPrompt', parentId: 'p', childId: 'c' }, 'Subagent prompt cancelled.'],
  ];
  for (const [index, [spec, expected]] of cases.entries()) {
    const chatId = 3000 + index;
    const replies = [];
    hub.armPending(chatId, spec);
    await cancelCommand(deps, { chatId, send: async (text, ok) => replies.push({ text, ok }) });
    assert.deepEqual(replies, [{ text: expected, ok: undefined }]);
    // The input is really gone afterwards.
    assert.equal(hub.cancelPending(chatId), undefined);
  }
});

test('/cancel with nothing armed replies "Nothing to cancel." with a failure flag', async () => {
  const hub = makeTestHub();
  const replies = [];
  await cancelCommand({ cancelPending: hub.cancelPending }, { chatId: 3099, send: async (text, ok) => replies.push({ text, ok }) });
  assert.deepEqual(replies, [{ text: 'Nothing to cancel.', ok: false }]);
});

// ---------------------------------------------------------------------------
// Full-plugin harness (same pattern as menu.test.mjs / goal-command.test.mjs)
// ---------------------------------------------------------------------------

/** Every chat id used by the integration tests below, allowed in every boot
 * so remounts never eject a chat another test is about to use. */
const ALL_CHATS = [101, 102, 201, 202, 401, 402, 403, 404, 405, 501, 601];

async function bootHarness() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-pending-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const liveAgents = new Map();
  const sent = [];
  let createdAgents = 0;
  const ctx = {
    services: new Map(),
    toolsDefs: new Map(),
    command: undefined,
    provide(name, value) { ctx.services.set(name, value); },
    get(name) { return ctx.services.get(name); },
    on: () => () => {},
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    commands: { register: (definition) => { ctx.command = definition; } },
    agents: {
      get: (id) => liveAgents.get(String(id)),
      list: () => [...liveAgents.values()],
      create: async () => {
        const agent = makeFakeAgent(`pending-agent-${++createdAgents}`);
        liveAgents.set(agent.id, agent);
        return { agent };
      },
    },
  };
  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  const originalSetCommands = TelegramTransport.prototype.setCommands;
  const originalSetMenuButton = TelegramTransport.prototype.setMenuButtonToCommands;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  const recordSend = async function (chatId, text, options) {
    sent.push({ chatId, text, options });
    return sent.length;
  };
  TelegramTransport.prototype.sendText = recordSend;
  TelegramTransport.prototype.sendTextControl = recordSend;
  TelegramTransport.prototype.sendTextFallback = recordSend;
  TelegramTransport.prototype.editText = async (chatId, messageId, text, options) => {
    sent.push({ chatId, text, options });
    return true;
  };
  TelegramTransport.prototype.editTextControl = TelegramTransport.prototype.editText;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async () => {};
  TelegramTransport.prototype.setCommands = async () => {};
  TelegramTransport.prototype.setMenuButtonToCommands = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: ALL_CHATS } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:pending-input-test';
    await applyPlugin(ctx, {});
    return {
      ctx,
      liveAgents,
      sent,
      handlers,
      telegram: ctx.services.get('telegram'),
      sendsTo(chatId) { return sent.filter((entry) => entry.chatId === chatId).map((entry) => entry.text); },
      cleanup() {
        process.chdir(oldCwd);
        if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = oldToken;
        TelegramTransport.prototype.setHandlers = originalSetHandlers;
        TelegramTransport.prototype.sendText = originalSendText;
        TelegramTransport.prototype.editText = originalEditText;
        TelegramTransport.prototype.deleteMessage = originalDeleteMessage;
        TelegramTransport.prototype.setCommands = originalSetCommands;
        TelegramTransport.prototype.setMenuButtonToCommands = originalSetMenuButton;
        rmSync(base, { recursive: true, force: true });
      },
    };
  } catch (err) {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    TelegramTransport.prototype.setHandlers = originalSetHandlers;
    TelegramTransport.prototype.sendText = originalSendText;
    TelegramTransport.prototype.editText = originalEditText;
    TelegramTransport.prototype.deleteMessage = originalDeleteMessage;
    TelegramTransport.prototype.setCommands = originalSetCommands;
    TelegramTransport.prototype.setMenuButtonToCommands = originalSetMenuButton;
    rmSync(base, { recursive: true, force: true });
    throw err;
  }
}

/** Consumption branches hand their replies to `void uiSend(...)` / voided
 * card openers, so give the event loop a few turns before asserting. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

function makeFakeAgent(id) {
  return {
    id,
    status: 'idle',
    options: { provider: 'test', model: 'test' },
    session: { events: [] },
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove(itemId) {
        this.nextTurn = this.nextTurn.filter((m) => m.id !== itemId);
        this.nextStep = this.nextStep.filter((m) => m.id !== itemId);
      },
      replace() { return false; },
    },
    send() {},
    followup() {},
    steer() {},
  };
}

test('(a) two chats arming /rename do not clobber each other and both renames fire (e)', async () => {
  const h = await bootHarness();
  try {
    h.ctx.provide('sessions', { list: () => [], get: (id) => ({ id: String(id), events: [] }) });
    const renamed = [];
    h.ctx.provide('sessionTitle', {
      rename: (session, title) => {
        renamed.push({ id: String(session.id), title });
        return { title };
      },
      get: () => undefined,
    });
    h.telegram.bindAgent(101, 'agent-a');
    h.telegram.bindAgent(102, 'agent-b');

    // Both chats arm the same kind before either consumes it — under the old
    // global single slot the second arm silently destroyed the first.
    await h.handlers.onText(101, '/rename');
    await settle();
    await h.handlers.onText(102, '/rename');
    await settle();
    assert.ok(h.sendsTo(101).some((t) => t.includes('Reply with just the title to rename agent-a')));
    assert.ok(h.sendsTo(102).some((t) => t.includes('Reply with just the title to rename agent-b')));

    await h.handlers.onText(101, 'title-seven');
    await settle();
    await h.handlers.onText(102, 'title-eight');
    await settle();
    assert.deepEqual(renamed, [
      { id: 'agent-a', title: 'title-seven' },
      { id: 'agent-b', title: 'title-eight' },
    ]);
    // Replies travel under parse_mode HTML, so quotes are wire-escaped as
    // &quot; — decode before asserting the branch body's confirmation text.
    const decoded = (chat) => h.sendsTo(chat).map((t) => t.replaceAll('&quot;', '"'));
    assert.ok(decoded(101).some((t) => t.includes('Renamed to "title-seven"')), 'rename branch body fired for chat 101');
    assert.ok(decoded(102).some((t) => t.includes('Renamed to "title-eight"')), 'rename branch body fired for chat 102');
  } finally {
    h.cleanup();
  }
});

test('(b) an expired pending input falls back to normal delivery instead of hijacking', async () => {
  const h = await bootHarness();
  try {
    const realNow = Date.now;
    try {
      // Arm while the clock reads ten minutes in the past: the stored
      // expiresAt lands five minutes before real time, so the entry is
      // already stale when the next message arrives.
      Date.now = () => realNow.call(Date) - 10 * 60_000;
      await h.handlers.onCallback(201, 'm:search');
    await settle();
    } finally {
      Date.now = realNow;
    }
    assert.ok(h.sendsTo(201).some((t) => t.includes('Reply with the search query')), 'arm prompt reached the chat');

    const agentsBefore = h.liveAgents.size;
    await h.handlers.onText(201, 'hello ordinary world');
    await settle();
    assert.equal(h.liveAgents.size, agentsBefore + 1, 'ordinary text must fall through to normal session creation');
    const newAgentId = [...h.liveAgents.keys()][0];
    assert.ok(newAgentId);
    assert.equal(h.telegram.chatIdForAgent(newAgentId), 201, 'the newly created session belongs to chat 201');
  } finally {
    h.cleanup();
  }
});

test('(b-control) a live (unexpired) search prompt is consumed exactly once', async () => {
  const h = await bootHarness();
  try {
    await h.handlers.onCallback(202, 'm:search');
    await settle();
    assert.ok(h.sendsTo(202).some((t) => t.includes('Reply with the search query')));
    const agentsBefore = h.liveAgents.size;
    const sendsBefore = h.sendsTo(202).length;

    await h.handlers.onText(202, 'find me something');
    await settle();
    assert.equal(h.liveAgents.size, agentsBefore, 'a consumed prompt must NOT fall through to session creation');
    assert.ok(h.sendsTo(202).length > sendsBefore, 'the search card opened for the armed query');
  } finally {
    h.cleanup();
  }
});

test('(e) the steer consumption branch body fires verbatim ("Steered.")', async () => {
  const h = await bootHarness();
  try {
    const steered = [];
    const agent = makeFakeAgent('agent-s');
    agent.steer = (message) => steered.push(message);
    h.liveAgents.set('agent-s', agent);
    h.telegram.bindAgent(501, 'agent-s');

    await h.handlers.onCallback(501, 's:agent-s:steer');
    await settle();
    assert.ok(h.sendsTo(501).some((t) => t.includes('Steer agent-s')), 'arm prompt reached the chat');

    await h.handlers.onText(501, 'go left then stop');
    await settle();
    assert.equal(steered.length, 1, 'exactly one steer reached the live agent');
    assert.ok(JSON.stringify(steered[0]).includes('go left then stop'));
    assert.ok(h.sendsTo(501).some((t) => t.trim() === 'Steered.'), 'promptSession success text surfaced');

    // Consumed: a follow-up ordinary text must not produce another steer.
    await h.handlers.onText(501, 'plain follow-up');
    await settle();
    assert.equal(steered.length, 1, 'the pending input was deleted by the first consume');
  } finally {
    h.cleanup();
  }
});

test('(c+d) /cancel integration: pluginAdd, search, steer and rename kinds + nothing armed', async () => {
  const h = await bootHarness();
  try {
    // pluginAdd (armed via the bare /pluginadd command).
    h.telegram.bindAgent(401, 'agent-x');
    await h.handlers.onText(401, '/pluginadd');
    await settle();
    assert.ok(h.sendsTo(401).some((t) => t.includes('Reply with the plugin JSON')));
    await h.handlers.onText(401, '/cancel');
    await settle();
    assert.ok(h.sendsTo(401).includes('Plugin add cancelled.'));

    // search (armed via the menu callback).
    await h.handlers.onCallback(402, 'm:search');
    await settle();
    await h.handlers.onText(402, '/cancel');
    await settle();
    assert.ok(h.sendsTo(402).includes('Search cancelled.'));

    // steer (armed via the session-detail callback; no services needed).
    await h.handlers.onCallback(403, 's:any-session:steer');
    await settle();
    await h.handlers.onText(403, '/cancel');
    await settle();
    assert.ok(h.sendsTo(403).includes('Steer cancelled.'));

    // rename (armed via the command).
    h.telegram.bindAgent(404, 'agent-y');
    await h.handlers.onText(404, '/rename');
    await settle();
    await h.handlers.onText(404, '/cancel');
    await settle();
    assert.ok(h.sendsTo(404).includes('Rename cancelled.'));

    // Nothing armed anywhere for chat 405.
    await h.handlers.onText(405, '/cancel');
    await settle();
    assert.ok(h.sendsTo(405).includes('\u274C Nothing to cancel.'), 'failure-styled nothing-to-cancel reply');
  } finally {
    h.cleanup();
  }
});

test('(c) a cancelled flow stops hijacking subsequent ordinary messages', async () => {
  const h = await bootHarness();
  try {
    await h.handlers.onCallback(601, 'm:search');
    await settle();
    await h.handlers.onText(601, '/cancel');
    await settle();
    assert.ok(h.sendsTo(601).includes('Search cancelled.'));
    const agentsBefore = h.liveAgents.size;
    await h.handlers.onText(601, 'free again, deliver normally');
    await settle();
    assert.equal(h.liveAgents.size, agentsBefore + 1, 'after /cancel an ordinary message reaches normal delivery');
  } finally {
    h.cleanup();
  }
});
