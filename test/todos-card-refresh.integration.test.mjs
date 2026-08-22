import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Todos card opens on the control lane, auto-refreshes every 5s, and stops when Status replaces it (#14)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-todo-card-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;

  const listeners = new Map();
  const liveAgents = new Map();
  const agent = {
    id: 'agent-todo',
    status: 'idle',
    options: { provider: 'test-provider', model: 'test-model' },
    send: () => {},
    followup: () => {},
    inbox: { nextTurn: [], nextStep: [] },
    session: {
      events: [
        { type: 'todo/write', data: { todos: [{ content: 'ship it', status: 'in_progress' }] } },
      ],
    },
  };
  liveAgents.set(agent.id, agent);
  const ctx = {
    get: () => undefined,
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
    services: new Map(),
    command: undefined,
    agents: {
      create: async () => { throw new Error('unexpected session create in todo card test'); },
      get: (id) => liveAgents.get(String(id)),
      list: () => [...liveAgents.values()],
    },
  };

  let handlers;
  const sendTextControlCalls = [];
  const editTextControlCalls = [];
  const originals = {
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
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originals.setHandlers.call(this, value);
  };
  TelegramTransport.prototype.sendText = async () => 71;
  TelegramTransport.prototype.sendTextControl = async (chatId, text, options) => {
    sendTextControlCalls.push({ chatId, text, options });
    return 71;
  };
  TelegramTransport.prototype.sendTextFallback = async () => 71;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.editTextControl = async (chatId, messageId, text, options) => {
    editTextControlCalls.push({ chatId, messageId, text, options });
    return true;
  };
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:todo-card-test';

    applyPlugin(ctx, {});
    ctx.services.get('telegram').bindAgent(7, 'agent-todo');

    await handlers.onCallback(7, 'm:todos');
    assert.equal(sendTextControlCalls.length, 1, 'initial card goes through the UI control lane');
    assert.match(sendTextControlCalls[0].text, /📌 <b>Todos<\/b> · 1 pending · 1 total/);

    // The periodic tick must pick up a change that arrived without any UI tap.
    agent.session.events.push({
      type: 'todo/write',
      data: { todos: [{ content: 'ship it', status: 'completed' }, { content: 'verify it', status: 'pending' }] },
    });
    await sleep(5100);
    assert.ok(editTextControlCalls.length >= 1, 'card refreshed in place after the 5s tick');
    assert.match(editTextControlCalls.at(-1).text, /📌 <b>Todos<\/b> · 1 pending · 2 total/);

    const editsAfterRefresh = editTextControlCalls.length;
    // Opening the Status panel replaces the card without going through
    // openCard; the Todo refresh loop must be stopped explicitly, otherwise
    // its next tick resurrects the Todo card on top of the Status panel.
    await handlers.onCallback(7, 'm:status');
    assert.ok(sendTextControlCalls.length >= 2, 'status panel opens as a fresh transient card');
    await sleep(5100);
    assert.equal(editTextControlCalls.length, editsAfterRefresh, 'status panel stops the Todo refresh loop');
  } finally {
    try {
      ctx.cleanup?.();
    } catch {
      // teardown best effort in the isolated test process
    }
    TelegramTransport.prototype.setHandlers = originals.setHandlers;
    TelegramTransport.prototype.sendText = originals.sendText;
    TelegramTransport.prototype.sendTextControl = originals.sendTextControl;
    TelegramTransport.prototype.sendTextFallback = originals.sendTextFallback;
    TelegramTransport.prototype.editText = originals.editText;
    TelegramTransport.prototype.editTextControl = originals.editTextControl;
    TelegramTransport.prototype.deleteMessage = originals.deleteMessage;
    TelegramTransport.prototype.deleteMessageControl = originals.deleteMessageControl;
    TelegramTransport.prototype.sendChatAction = originals.sendChatAction;
    TelegramTransport.prototype.sendChatActionControl = originals.sendChatActionControl;
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    rmSync(base, { recursive: true, force: true });
  }
});
