import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { COLLAPSE_BTN, RETURN_BTN, TODO_BTN } from '../dist/telegram/keyboard.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

const ORIGINALS = {
  setHandlers: TelegramTransport.prototype.setHandlers,
  sendText: TelegramTransport.prototype.sendText,
  sendTextControl: TelegramTransport.prototype.sendTextControl,
  sendTextFallback: TelegramTransport.prototype.sendTextFallback,
  editText: TelegramTransport.prototype.editText,
  editTextControl: TelegramTransport.prototype.editTextControl,
  deleteMessage: TelegramTransport.prototype.deleteMessage,
  deleteMessageControl: TelegramTransport.prototype.deleteMessageControl,
  sendChatAction: TelegramTransport.prototype.sendChatAction,
  sendChatActionControl: TelegramTransport.prototype.sendChatActionControl,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

function patchTransport(state) {
  TelegramTransport.prototype.setHandlers = function (value) {
    state.handlers = value;
    return ORIGINALS.setHandlers.call(this, value);
  };
  TelegramTransport.prototype.sendText = async () => 71;
  TelegramTransport.prototype.sendTextControl = async (chatId, text, options) => {
    state.sends.push({ chatId, text, options });
    return 71;
  };
  TelegramTransport.prototype.sendTextFallback = async () => 71;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.editTextControl = async (chatId, messageId, text, options) => {
    state.edits.push({ chatId, messageId, text, options });
    return true;
  };
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async (chatId, messageId) => {
    state.deletes.push({ chatId, messageId });
  };
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async (chatId, action) => {
    state.chatActions.push({ chatId, action });
  };
}

function restoreTransport() {
  for (const key of Object.keys(ORIGINALS)) TelegramTransport.prototype[key] = ORIGINALS[key];
}

async function setup({ services = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ui-lane-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  mkdirSync(join(base, '.pi'));
  writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));

  const listeners = new Map();
  const liveAgents = new Map();
  const agent = {
    id: 'agent-ui',
    status: 'idle',
    options: { provider: 'test-provider', model: 'test-model' },
    send: () => {},
    followup: () => {},
    inbox: { nextTurn: [], nextStep: [] },
    session: { events: [] },
  };
  liveAgents.set(agent.id, agent);
  const ctx = {
    get: (name) => ctx.services.get(name),
    provide: (_name, value) => {
      ctx.services.set(_name, value);
    },
    on: (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
      return () => {};
    },
    effect: (fn) => {
      ctx.cleanup = fn();
    },
    cleanup: undefined,
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(Object.entries(services)),
    command: undefined,
    agents: {
      create: async () => { throw new Error('unexpected session create in UI lane test'); },
      get: (id) => liveAgents.get(String(id)),
      list: () => [...liveAgents.values()],
    },
  };

  const state = { sends: [], edits: [], deletes: [], chatActions: [], handlers: undefined };
  patchTransport(state);

  process.chdir(base);
  process.env.TELEGRAM_BOT_TOKEN = '123456:ui-lane-test';
  applyPlugin(ctx, {});
  ctx.services.get('telegram').bindAgent(7, 'agent-ui');

  return {
    base,
    oldCwd,
    oldToken,
    ctx,
    agent,
    listeners,
    state,
    cleanup: async () => {
      try {
        ctx.cleanup?.();
      } catch {
        // teardown best effort in the isolated test process
      }
      restoreTransport();
      process.chdir(oldCwd);
      if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = oldToken;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const emit = (listeners, name, sessionId, event) => {
  for (const cb of listeners.get(name) ?? []) cb({ id: sessionId }, event);
};

test('Back from a bar-opened card closes to chat; the same card from the menu returns to menu (#16)', async () => {
  const env = await setup();
  try {
    // Bar entry: every bar button marks the card origin before opening.
    await env.state.handlers.onText(7, TODO_BTN);
    // The Todos card header tracks the design language (todos-card.ts):
    // icon (📋 old / 📌 pending / ✅ complete) + possibly bolded "Todos".
    // This assertion is about "the Todos card opened", not the glyph.
    assert.ok(env.state.sends.some((entry) => /(?:📋|📌|✅) (?:<b>)?Todos/.test(entry.text)), 'bar Todos card opened');
    const sendsBefore = env.state.sends.length;
    const deletesBefore = env.state.deletes.length;

    await env.state.handlers.onCallback(7, 'm:back');
    assert.equal(env.state.deletes.length, deletesBefore + 1, 'bar Back closes the card like Close');
    assert.equal(env.state.sends.length, sendsBefore, 'bar Back does NOT open the menu');
    assert.equal(env.state.edits.length, 0);

    // Menu entry: openMenuAt had already recorded the menu origin.
    env.state.sends.length = 0;
    env.state.deletes.length = 0;
    env.state.edits.length = 0;
    await env.state.handlers.onCallback(7, 'm:todos');
    assert.ok(env.state.sends.some((entry) => /(?:📋|📌|✅) (?:<b>)?Todos/.test(entry.text)), 'menu Todos card opened');
    await env.state.handlers.onCallback(7, 'm:back');
    assert.ok(env.state.edits.some((entry) => /🤖 dsh/.test(entry.text)), 'menu Back returns to the menu page');
    assert.equal(env.state.sends.length, 1, 'menu Back updates the card in place, no close+reopen');
  } finally {
    await env.cleanup();
  }
});

test('collapsing the persistent bar sends the collapsed keyboard carrier (#17)', async () => {
  const env = await setup();
  try {
    env.state.sends.length = 0;
    env.state.deletes.length = 0;
    await env.state.handlers.onText(7, COLLAPSE_BTN);
    await waitFor(() => env.state.sends.some((entry) => entry.text.includes('Bar 已收起')));
    const collapsed = env.state.sends.at(-1);
    assert.equal(collapsed.options.disable_notification, true);
    assert.ok(collapsed.options.reply_markup !== undefined, 'collapsed keyboard replaces the persistent bar');

    env.state.sends.length = 0;
    await env.state.handlers.onText(7, RETURN_BTN);
    await waitFor(() => env.state.sends.some((entry) => entry.text.startsWith('⌛ Queue')));
    const restored = env.state.sends.at(-1);
    assert.ok(restored.options.reply_markup !== undefined, 'full bar keyboard is restored');
  } finally {
    await env.cleanup();
  }
});

test('typing keep-alive renews while the turn is still running after 10 minutes (#17)', async (t) => {
  const env = await setup();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    env.state.chatActions.length = 0;
    emit(env.listeners, 'session/event', 'agent-ui', { type: 'turn/start', data: { turn: 1 } });
    await Promise.resolve();
    assert.ok(env.state.chatActions.length > 0, 'typing starts with the turn');
    // #48: the keepalive guard now trusts the live agent's own status over
    // the sticky turn flag, so the fixture agent must actually be running.
    env.agent.status = 'running';

    t.mock.timers.tick(10 * 60_000);
    await Promise.resolve();
    assert.ok(
      env.state.chatActions.length > 151,
      `10-minute guard renews the loop while running (got ${env.state.chatActions.length} actions)`,
    );

    emit(env.listeners, 'session/event', 'agent-ui', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await Promise.resolve();
    const stoppedAt = env.state.chatActions.length;
    t.mock.timers.tick(10 * 60_000);
    await Promise.resolve();
    assert.equal(env.state.chatActions.length, stoppedAt, 'ended turn must not revive typing');
  } finally {
    await env.cleanup();
  }
});

test('a hanging card data service fails the card visibly after 10s (#20)', async (t) => {
  const env = await setup({
    services: {
      llm: {
        listProviders: () => [{ id: 'hang-provider', name: 'hang' }],
        listModels: () => new Promise(() => {}),
      },
    },
  });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    env.state.sends.length = 0;

    const opening = env.state.handlers.onCallback(7, 'm:models');
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(10_000);
    await opening;

    assert.ok(
      env.state.sends.some((entry) => entry.text.includes('❌ model catalog 加载失败')),
      'card load deadline reports a visible failure instead of wedging the UI lane',
    );
    assert.equal(env.state.sends.some((entry) => /Models · current/.test(entry.text)), false, 'no half-loaded card');
  } finally {
    await env.cleanup();
  }
});
