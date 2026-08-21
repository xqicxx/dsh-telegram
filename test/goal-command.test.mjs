import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

async function bootGoalHarness() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-goal-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;

  const listeners = new Map();
  const liveAgents = new Map();
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
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
    agents: {
      get: (id) => liveAgents.get(String(id)),
      list: () => [...liveAgents.values()],
    },
  };

  const sends = [];
  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  const originalSendChatAction = TelegramTransport.prototype.sendChatAction;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  const recordSend = async function (chatId, text, options) {
    sends.push({ chatId, text, options });
    return sends.length;
  };
  TelegramTransport.prototype.sendText = recordSend;
  TelegramTransport.prototype.sendTextControl = recordSend;
  TelegramTransport.prototype.sendTextFallback = recordSend;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.editTextControl = async () => true;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:goal-command-test';
    // Awaited: a boot that re-applies over an earlier mount now stops the old
    // transport before rebuilding (🟠-11), so the router attaches when the
    // returned promise settles.
    await applyPlugin(ctx, {});
    return { ctx, liveAgents, sends, handlers, base };
  } catch (err) {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    TelegramTransport.prototype.setHandlers = originalSetHandlers;
    TelegramTransport.prototype.sendText = originalSendText;
    TelegramTransport.prototype.editText = originalEditText;
    TelegramTransport.prototype.deleteMessage = originalDeleteMessage;
    TelegramTransport.prototype.sendChatAction = originalSendChatAction;
    rmSync(base, { recursive: true, force: true });
    throw err;
  }
}

async function teardownGoalHarness(harness, oldCwd, oldToken) {
  process.chdir(oldCwd);
  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = oldToken;
  // Like apply-race.test.mjs, deliberately leave the transport send stubs
  // installed for this isolated test process: debounced bar-sync timers may
  // fire after the test returns and must hit the stubs, not the real Bot API.
  rmSync(harness.base, { recursive: true, force: true });
}

test('/goal with no bound agent always sends a visible failure', async () => {
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const harness = await bootGoalHarness();
  try {
    await harness.handlers.onText(7, '/goal 帮我调研一下');
    const reply = harness.sends.find((entry) => entry.text.includes('No live agent'));
    assert.ok(reply, 'the command must answer instead of staying silent');
    assert.ok(reply.text.startsWith('\u274C'), 'missing agent is an error, not a neutral message');
    assert.equal(reply.options.parse_mode, 'HTML');
  } finally {
    await teardownGoalHarness(harness, oldCwd, oldToken);
  }
});

test('/goal with a bound agent surfaces the goals-service failure instead of hanging', async () => {
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const harness = await bootGoalHarness();
  try {
    const agent = {
      id: 'agent-goal',
      status: 'idle',
      options: { provider: 'test', model: 'test' },
      session: { events: [] },
      inbox: { nextTurn: [], nextStep: [] },
    };
    harness.liveAgents.set(agent.id, agent);
    harness.ctx.services.get('telegram').bindAgent(7, agent.id);
    await harness.handlers.onText(7, '/goal a goal without a goals service');
    const reply = harness.sends.find((entry) => entry.text.includes('goals service is unavailable'));
    assert.ok(reply, 'a concrete error reaches the user');
    assert.ok(reply.text.startsWith('\u274C'));
  } finally {
    await teardownGoalHarness(harness, oldCwd, oldToken);
  }
});
