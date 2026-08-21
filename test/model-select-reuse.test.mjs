import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

// ---------------------------------------------------------------------------
// 🟠-16: a model-select tap whose auto-create gate only REUSES this chat's
// already-live session (first message raced the tap / binding outlived its
// released agent) must answer with a clear failure and must NOT persist the
// model — it was never applied to any live session.
// ---------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-model-reuse-'));
const oldCwd = process.cwd();
const oldToken = process.env.TELEGRAM_BOT_TOKEN;

const listeners = new Map();
const liveAgents = new Map();
let creates = 0;
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
    async create(options) {
      creates += 1;
      const id = String(options.sessionId);
      const agent = {
        id,
        status: 'idle',
        options: options.agentOptions ?? {},
        send: () => {},
        followup: () => {},
        session: { events: [] },
        inbox: { nextTurn: [], nextStep: [] },
      };
      liveAgents.set(id, agent);
      return { agent, dispose: async () => { liveAgents.delete(id); } };
    },
    get: (id) => liveAgents.get(String(id)),
    list: () => [...liveAgents.values()],
  },
};

const sends = [];
let handlers;
const originalSetHandlers = TelegramTransport.prototype.setHandlers;
const originalSendText = TelegramTransport.prototype.sendText;
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

mkdirSync(join(base, '.pi'));
writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));
process.chdir(base);
process.env.TELEGRAM_BOT_TOKEN = '123456:model-reuse-test';
applyPlugin(ctx, {});

const svc = ctx.services.get('telegram');
const configFile = join(base, '.pi', 'telegram.json');

test('model-select over a reused live session fails cleanly without persisting (🟠-16)', async () => {
  // The race: dispatchToken resolves this chat's agent BEFORE a first inbound
  // message binds one; by the time the serialized create-gate runs, the chat
  // already has a live session. The router serializes callbacks per chat, so
  // timing flips are unreliable — instead flip on the SECOND agents.get():
  // call 1 is dispatchToken's currentAgent read (sees no live agent), call 2
  // is the create-gate's onlyIfUnbound liveness check (sees the raced one).
  const realGet = ctx.agents.get.bind(ctx.agents);
  let gets = 0;
  ctx.agents.get = (id) => {
    gets += 1;
    return gets >= 2 ? realGet(id) : undefined;
  };

  const agentA = {
    id: 'agent-raced',
    status: 'running',
    options: { provider: 'other', model: 'other-model' },
    send: () => {},
    followup: () => {},
    session: { events: [] },
    inbox: { nextTurn: [], nextStep: [] },
  };
  liveAgents.set(agentA.id, agentA);
  svc.bindAgent(7, agentA.id);
  const modelBefore = svc.getConfig().model;
  const fileBefore = readFileSync(configFile, 'utf8');

  const tok = svc.token({ action: 'model-select', provider: 'p1', model: 'm1' });
  await handlers.onCallback(7, tok);

  assert.equal(creates, 0, 'no session may be created behind the reused binding');
  const reply = sends.find((entry) => entry.text.includes('was not applied'));
  assert.ok(reply, 'the tap must answer with a clear failure');
  assert.ok(reply.text.startsWith('\u274C'), 'reused-live is a failure for this tap, not success');
  assert.deepEqual(svc.getConfig().model, modelBefore, 'the unapplied model must not become the default');
  assert.equal(readFileSync(configFile, 'utf8'), fileBefore, 'and it must not reach the config file either');
});

test('cleanup', () => {
  process.chdir(oldCwd);
  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = oldToken;
  // Leave the send stubs installed for this isolated test process.
  TelegramTransport.prototype.setHandlers = originalSetHandlers;
  TelegramTransport.prototype.sendText = originalSendText;
  rmSync(base, { recursive: true, force: true });
});
