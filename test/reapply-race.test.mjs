import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 🟠-11: re-apply must await the old transport's stop before constructing its
// replacement — two live getUpdates pollers race Telegram's 409 Conflict
// window. First mounts stay synchronous; only the remount defers.
// ---------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-reapply-race-'));
const oldCwd = process.cwd();
const oldToken = process.env.TELEGRAM_BOT_TOKEN;

const listeners = new Map();
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
    get: () => undefined,
    list: () => [],
    async create() { throw new Error('no session may be created in this test'); },
  },
};

let handlersInstalled = 0;
const originalSetHandlers = TelegramTransport.prototype.setHandlers;
const originalStop = TelegramTransport.prototype.stop;
TelegramTransport.prototype.sendText = async () => 71;
TelegramTransport.prototype.sendTextControl = async () => 71;
TelegramTransport.prototype.sendTextFallback = async () => 71;
TelegramTransport.prototype.editText = async () => true;
TelegramTransport.prototype.editTextControl = async () => true;
TelegramTransport.prototype.deleteMessage = async () => {};
TelegramTransport.prototype.deleteMessageControl = async () => {};
TelegramTransport.prototype.sendChatAction = async () => {};
TelegramTransport.prototype.sendChatActionControl = async () => {};

mkdirSync(join(base, '.pi'));
writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));
process.chdir(base);
process.env.TELEGRAM_BOT_TOKEN = '123456:reapply-race-test';

// FIRST mount: must complete synchronously inside apply() (the router's
// handlers exist the moment apply returns).
const order = [];
let remountDone;
const remounted = new Promise((resolve) => { remountDone = resolve; });
TelegramTransport.prototype.stop = async function () {
  order.push('stop:start');
  await sleep(20); // widen the would-be 409 window
  order.push('stop:end');
  return originalStop.call(this);
};
TelegramTransport.prototype.setHandlers = function (value) {
  handlersInstalled += 1;
  order.push(`setHandlers:${handlersInstalled}`);
  if (handlersInstalled === 2) remountDone();
  return originalSetHandlers.call(this, value);
};

applyPlugin(ctx, {});
process.env.TELEGRAM_BOT_TOKEN && applyPlugin(ctx, {}); // re-apply on the live mount

test('re-apply stops the old transport before constructing its replacement (🟠-11)', async () => {
  await remounted;
  assert.ok(order.includes('setHandlers:1'), `the first mount constructed a transport synchronously: ${order.join(' -> ')}`);
  const stopEnd = order.indexOf('stop:end');
  const secondMount = order.indexOf('setHandlers:2');
  assert.ok(stopEnd !== -1, 'the old transport was stopped');
  assert.ok(secondMount !== -1, 'the replacement transport was constructed');
  assert.ok(
    secondMount > stopEnd,
    `replacement must be constructed only after the old stop settled, got: ${order.join(' -> ')}`,
  );
  assert.equal(order.filter((entry) => entry === 'stop:end').length, 1, 'exactly one old transport stop');
});

test('cleanup', async () => {
  await remounted.catch(() => {});
  process.chdir(oldCwd);
  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = oldToken;
  // Leave the send stubs installed for this isolated test process.
  TelegramTransport.prototype.setHandlers = originalSetHandlers;
  TelegramTransport.prototype.stop = originalStop;
  rmSync(base, { recursive: true, force: true });
});
