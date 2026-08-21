import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

// ---------------------------------------------------------------------------
// 🟠-9: host.applyConfig must persist BEFORE committing to memory — a failed
// write (read-only disk) used to leave the runtime on config the disk never
// saw, and threw raw into the extension callback.
// ---------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-config-order-'));
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

const originalSetHandlers = TelegramTransport.prototype.setHandlers;
const originalSendText = TelegramTransport.prototype.sendText;
TelegramTransport.prototype.setHandlers = function (value) {
  return originalSetHandlers.call(this, value);
};
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
process.env.TELEGRAM_BOT_TOKEN = '123456:config-order-test';
applyPlugin(ctx, {});

const svc = ctx.services.get('telegram');
const configFile = join(base, '.pi', 'telegram.json');

test('applyConfig keeps memory untouched when the disk write fails (🟠-9)', () => {
  const before = readFileSync(configFile, 'utf8');
  chmodSync(configFile, 0o444); // writes now fail with EACCES (non-root)

  let changed;
  assert.doesNotThrow(() => {
    changed = svc.applyConfig({ outbound: { maxRetries: 9 } });
  }, 'a failed persist must not throw raw into the extension callback');
  assert.deepEqual(changed, [], 'an empty result is the existing "nothing applied" signal');

  // Runtime state must not diverge from disk: no in-memory commit happened.
  assert.equal(svc.getConfig().outbound.maxRetries, 3);
  assert.equal(readFileSync(configFile, 'utf8'), before, 'disk stayed untouched too');

  // A writable disk applies AND persists, in that order.
  chmodSync(configFile, 0o644);
  const okChanged = svc.applyConfig({ outbound: { maxRetries: 5 } });
  assert.deepEqual(okChanged, ['outbound']);
  assert.equal(svc.getConfig().outbound.maxRetries, 5);
  assert.match(readFileSync(configFile, 'utf8'), /"maxRetries": 5/, 'the successful patch is persisted');
});

test('cleanup', () => {
  process.chdir(oldCwd);
  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = oldToken;
  // Like apply-race.test.mjs, leave the transport send stubs installed for
  // this isolated test process: debounced timers may fire after the tests.
  TelegramTransport.prototype.setHandlers = originalSetHandlers;
  rmSync(base, { recursive: true, force: true });
});
