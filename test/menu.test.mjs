import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuPage } from '../dist/telegram/keyboard.js';

test('menu page 1 shows More but no Prev and no dead page button', () => {
  const kb = buildMenuPage([{ label: 'A', cb: 'm:a' }, { label: 'B', cb: 'm:b' }], 0, 2);
  const texts = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(texts.includes('More ➡️'));
  assert.ok(!texts.some((t) => t.startsWith('Prev')));
  assert.ok(!texts.some((t) => /^\d+\/\d+$/.test(t)));
});

test('menu page 2 shows Prev but no More', () => {
  const kb = buildMenuPage([{ label: 'C', cb: 'm:c' }], 1, 2);
  const texts = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(texts.some((t) => t.includes('Prev')));
  assert.ok(!texts.some((t) => t.includes('More')));
  assert.ok(!texts.some((t) => /^\d+\/\d+$/.test(t)));
});

test('full-width items occupy their own row', () => {
  const kb = buildMenuPage(
    [{ label: 'New session', cb: 'm:new', full: true }, { label: 'Goals', cb: 'm:goals' }, { label: 'Workspaces', cb: 'm:workspaces' }],
    0,
    1,
  );
  const rows = kb.inline_keyboard;
  assert.equal(rows[0].length, 1);
  assert.equal(rows[1].length, 2);
});

test('extension menu items render in page 1 with reasoning present', async () => {
  const { reasoningExtension } = await import('../dist/extensions/reasoning.js');
  const items = reasoningExtension.menuItems?.({
    openCard: async () => {}, send: async () => undefined, token: (p) => 't:1',
    currentAgent: () => undefined, requireCtx: () => { throw new Error('no ctx'); },
    workspaceRoot: () => '/tmp', getConfigPath: () => undefined, applyConfig: () => [],
    refreshAllPanels: () => {},
  });
  assert.ok(items && items.length > 0);
  assert.ok(items[0].label.includes('Reasoning'));
  assert.equal(items[0].cb, 'm:thinking');
});

// ---------------------------------------------------------------------------
// Full-plugin card harness (RA-1 / B-5r / RH-4 / RH-5 regressions): boots the
// real dispatchers over a fake ctx so token/callback surfaces can be driven
// end to end, the same way goal-command.test.mjs drives commands.
// ---------------------------------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

async function bootCardHarness() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-card-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const liveAgents = new Map();
  const sent = [];
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
        const agent = makeFakeAgent(`agent-${liveAgents.size + 1}`);
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
    // Card re-renders replace the ephemeral card message in place; record
    // them like sends so keyboard assertions see the latest markup.
    sent.push({ chatId, text, options });
    return true;
  };
  TelegramTransport.prototype.editTextControl = TelegramTransport.prototype.editText;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.setCommands = async () => {};
  TelegramTransport.prototype.setMenuButtonToCommands = async () => {};

  mkdirSync(join(base, '.pi'));
  writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));
  process.chdir(base);
  process.env.TELEGRAM_BOT_TOKEN = '123456:card-test';
  await applyPlugin(ctx, {});
  const telegram = ctx.services.get('telegram');
  return {
    ctx,
    liveAgents,
    sent,
    handlers,
    telegram,
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
}

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
  };
}

/** Flatten every inline button rendered by the sends recorded so far. */
function keyboardButtons(sent) {
  const buttons = [];
  for (const entry of sent) {
    const kb = entry.options?.reply_markup?.inline_keyboard;
    if (Array.isArray(kb)) for (const row of kb) for (const button of row ?? []) buttons.push(button);
  }
  return buttons;
}

test('token "✨ Use default preset" routes through dispatchToken and creates a session (RA-1)', async () => {
  const harness = await bootCardHarness();
  try {
    await harness.handlers.onCallback(7, 'm:new');
    const button = keyboardButtons(harness.sent).find((entry) => entry.text.includes('Use default preset'));
    assert.ok(button, 'the New Session card must offer the default-preset button');
    assert.match(button.callback_data, /^t:/);
    await harness.handlers.onCallback(7, button.callback_data);
    // Before RA-1 this tap fell into dispatchToken's `default:` and produced
    // no output at all; now it must create+bind a session and announce it.
    const announce = harness.sent.find((entry) => String(entry.text).includes('New session'));
    assert.ok(announce, 'the default-preset tap must announce the created session');
    assert.equal(harness.telegram.chatIdForAgent([...harness.liveAgents.keys()][0]), 7);
  } finally {
    harness.cleanup();
  }
});

test('plugin-remove confirm acts on the minted agentId even after the chat rebinds (B-5r)', async () => {
  const harness = await bootCardHarness();
  try {
    const undefineCalls = [];
    harness.ctx.services.set('dynamicCordisRunner', {
      inventory: () => [
        {
          pluginId: 'plg-my-decoder',
          agentId: 'agent-a',
          packages: [{ packageId: 'pkg-1', name: 'v1' }],
          currentPackageId: 'pkg-1',
          activeRun: undefined,
        },
      ],
      define: () => ({ pluginId: 'plg-my-decoder', packageId: 'pkg-2', name: 'x', hasHostHalf: true, hasClientHalf: false }),
      run: async () => ({ ok: true, status: 'running' }),
      stop: async () => ({ ok: true }),
      undefine: async (agent, pluginId) => {
        undefineCalls.push({ agent, pluginId });
        return { ok: true, stoppedActiveRun: true };
      },
    });
    const agentA = makeFakeAgent('agent-a');
    const agentB = makeFakeAgent('agent-b');
    harness.liveAgents.set('agent-a', agentA);
    harness.liveAgents.set('agent-b', agentB);
    harness.telegram.bindAgent(7, 'agent-a');

    await harness.handlers.onCallback(7, 'm:dynamic');
    const remove = keyboardButtons(harness.sent).find((entry) => entry.text.includes('Remove') && entry.callback_data.startsWith('t:'));
    assert.ok(remove, 'the dynamic plugins card must offer a Remove token');
    await harness.handlers.onCallback(7, remove.callback_data);
    const confirm = keyboardButtons(harness.sent).filter((entry) => entry.text.includes('Confirm') && entry.callback_data.startsWith('t:')).pop();
    assert.ok(confirm, 'remove must ask for confirmation');

    // The chat rebinds to another session between render and confirm; the
    // confirm token must still act on the session that was bound at mint time.
    harness.telegram.bindAgent(7, 'agent-b');
    await harness.handlers.onCallback(7, confirm.callback_data);
    assert.equal(undefineCalls.length, 1, 'undefine must run exactly once');
    assert.equal(undefineCalls[0].agent, agentA, 'confirm must hit the minted session, not the current binding');
    assert.equal(undefineCalls[0].pluginId, 'plg-my-decoder');
  } finally {
    harness.cleanup();
  }
});

test('queue card buttons carry the owning sessionId and act on that queue (RH-5)', async () => {
  const harness = await bootCardHarness();
  try {
    const agentA = makeFakeAgent('agent-a');
    agentA.inbox.nextTurn.push({ id: 'item-1', content: [{ type: 'text', text: 'hello there' }] });
    harness.liveAgents.set('agent-a', agentA);

    // Open the SPECIFIC session's queue card, then unbind the chat entirely:
    // legacy `q:<item>:<kind>` buttons would die with "No live agent owns the
    // queue", while the new `q:<sessionId>:<itemId>:<kind>` buttons must
    // still resolve through the encoded session.
    await harness.handlers.onCallback(7, 's:agent-a:queue');
    const del = keyboardButtons(harness.sent).find((entry) => entry.text.includes('Delete') && entry.callback_data.startsWith('q:agent-a'));
    assert.ok(del, 'the session queue card must encode the owning session in its callbacks');
    harness.telegram.bindAgent(7, undefined);
    await harness.handlers.onCallback(7, del.callback_data);
    const reply = harness.sent.at(-1);
    assert.ok(reply && !String(reply.text).includes('No live agent owns the queue'), 'the encoded session must own the action');
    assert.equal(agentA.inbox.nextTurn.length, 0, 'the item must be removed from the owning session');

    // Legacy two-part buttons keep working against the chat-bound agent.
    const agentB = makeFakeAgent('agent-b');
    agentB.inbox.nextStep.push({ id: 'step-9', content: [{ type: 'text', text: 'later' }] });
    harness.liveAgents.set('agent-b', agentB);
    harness.telegram.bindAgent(7, 'agent-b');
    await harness.handlers.onCallback(7, 'q:step-9:r');
    assert.equal(agentB.inbox.nextStep.length, 0, 'legacy buttons keep resolving through the chat-bound agent');
  } finally {
    harness.cleanup();
  }
});

test('workspace Move-up on the first item short-circuits instead of appending to the end (RH-4)', async () => {
  const harness = await bootCardHarness();
  try {
    let order = ['ws-one', 'ws-two'];
    const insertBeforeCalls = [];
    const workspace = (id) => ({
      id,
      path: `/tmp/${id}`,
      title: id,
      sessionIds: [],
      setTitle: async () => {},
      insertSessionBefore: async () => {},
    });
    harness.ctx.services.set('workspaceRegistry', {
      list: () => order.map(workspace),
      get: (id) => (order.includes(id) ? workspace(id) : undefined),
      create: async (path) => workspace(path),
      delete: async () => true,
      insertBefore: async (id, beforeId) => {
        insertBeforeCalls.push([id, beforeId]);
        order = [id, ...order.filter((entry) => entry !== id && entry !== beforeId)];
        if (beforeId !== undefined) order.splice(order.indexOf(beforeId), 0, id);
        return order;
      },
      archivedSessionIds: [],
      archiveSession: async () => {},
    });

    await harness.handlers.onCallback(7, 'w:ws-one');
    const upFirst = keyboardButtons(harness.sent).filter((entry) => entry.text.includes('Move up')).pop();
    assert.ok(upFirst, 'the workspace detail card must offer Move up');
    await harness.handlers.onCallback(7, upFirst.callback_data);
    assert.deepEqual(insertBeforeCalls, [], 'first-item Move up must short-circuit without touching the registry');
    assert.ok(harness.sent.some((entry) => String(entry.text).includes('Already first.')), 'the user must be told the item is already first');

    // Positive control: moving the SECOND item up still reorders normally.
    await harness.handlers.onCallback(7, 'w:ws-two');
    const upSecond = keyboardButtons(harness.sent).filter((entry) => entry.text.includes('Move up')).pop();
    await harness.handlers.onCallback(7, upSecond.callback_data);
    assert.deepEqual(insertBeforeCalls, [['ws-two', 'ws-one']], 'non-edge moves keep their anchor semantics');
  } finally {
    harness.cleanup();
  }
});
