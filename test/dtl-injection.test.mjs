/**
 * DTL adversarial injection & robustness sweep (design language, src/telegram/ui.ts).
 *
 * Contract under test: text-level helpers (bold/mono/plain/strike/relTime)
 * ESCAPE their input; line builders (headerLine/metaJoin) insert meta
 * fragments VERBATIM — so every user/host-controlled fragment must arrive at
 * those call sites already rendered through an escaping helper. These tests
 * drive the real card renderers (pure factories over fake deps, no live
 * harness) with hostile payloads and assert the produced message HTML never
 * contains raw user markup — the escaped literals must appear instead.
 *
 * Hostile payload set: element injection, javascript: href, bare ampersand,
 * and double-angle tag soup. Presence of the escaped form is asserted only
 * where the payload survives the surface's truncation window whole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { splitText, plain } from '../dist/telegram/html.js';
import { bold, mono, strike, relTime, headerLine } from '../dist/telegram/ui.js';
import { renderTodosCard } from '../dist/telegram/todos-card.js';
import { renderTrajectoryLines } from '../dist/telegram/trajectory.js';
import { renderTurnReceipt } from '../dist/telegram/turn-receipt.js';
import { createSessionCards } from '../dist/cards/sessions.js';
import { createWorkspaceCards } from '../dist/cards/workspaces.js';
import { createHostCards } from '../dist/cards/host.js';
import { createPresetCards } from '../dist/cards/presets.js';
import { createGoalCards } from '../dist/cards/goals.js';
import { createQueueCards } from '../dist/cards/queue.js';
import { createMiscCards } from '../dist/cards/misc.js';

const HOSTILE = ['<b>x</b>', '<a href="javascript:alert(1)">c</a>', '&', '<<s>>'];
const ESCAPED = {
  '<b>x</b>': '&lt;b&gt;x&lt;/b&gt;',
  '<a href="javascript:alert(1)">c</a>': '&lt;a href=&quot;javascript:alert(1)&quot;&gt;c&lt;/a&gt;',
  '&': '&amp;',
  '<<s>>': '&lt;&lt;s&gt;&gt;',
};

/** Raw user markup may never reach the wire on any surface. */
function assertNoRawMarkup(text, label) {
  // A bare `&` outside a numeric/named entity is the injection form of the
  // ampersand payload; escaped cards are full of `&lt;`-style entities.
  const withoutEntities = text.replace(/&[a-zA-Z#0-9]{1,10};/g, '');
  for (const payload of HOSTILE) {
    if (payload === '&') {
      assert.ok(!withoutEntities.includes('&'), `${label}: raw unescaped ampersand leaked\n---\n${text}`);
      continue;
    }
    assert.ok(!text.includes(payload), `${label}: raw user markup leaked verbatim: ${payload}\n---\n${text}`);
  }
}

/** The surfaces that ingest these payloads must show their escaped literals. */
function assertEscapedForm(text, label, payloads) {
  for (const payload of payloads) {
    assert.ok(text.includes(ESCAPED[payload]), `${label}: expected escaped form of ${payload}\n---\n${text}`);
  }
}

function captureCard() {
  const seen = {};
  const openCard = async (_chatId, text, keyboard) => {
    seen.text = text;
    seen.keyboard = keyboard;
  };
  return { seen, openCard };
}

function fakeCtx(seams = {}) {
  return {
    agents: { list: () => [], get: () => undefined },
    get: (name) => seams[name],
  };
}

// ── DTL primitives ─────────────────────────────────────────────────────────

test('DTL text-level helpers escape hostile input', () => {
  // A bare `&` only counts as leaked when it sits OUTSIDE an escape entity.
  const stripEntities = (text) => text.replace(/&[a-zA-Z#0-9]{1,10};/g, '');
  for (const payload of HOSTILE) {
    for (const [name, render] of [['bold', bold], ['mono', mono], ['plain', plain], ['strike', strike]]) {
      const out = render(payload);
      if (payload === '&') assert.ok(!stripEntities(out).includes('&'), `${name} leaked a bare ampersand`);
      else assert.ok(!out.includes(payload), `${name} leaked ${payload}`);
      assert.ok(out.includes(ESCAPED[payload]), `${name} lost the escaped form of ${payload}`);
    }
  }
});

test('headerLine escapes only the title; meta fragments pass through verbatim', () => {
  const meta = plain('<i>y</i>');
  const out = headerLine('🎯', '<b>x</b>', meta);
  assert.ok(out.startsWith('🎯 <b>&lt;b&gt;x&lt;/b&gt;</b>'), out);
  // An already-rendered fragment must NOT be double-escaped:
  assert.ok(out.includes(meta), out);
  assert.ok(!out.includes('&lt;i&gt;&amp;lt;i&amp;gt;'), out);
});

test('relTime renders a tg-time entity only for finite positive timestamps', () => {
  const good = relTime(Date.now(), 'just now');
  assert.match(good, /^<tg-time unix="\d+" format="r">just now<\/tg-time>$/);

  // Contract violations that reach cards through blind casts (session event
  // `at` folds) or unchecked host registry rows: no broken entity may ever
  // reach Telegram's HTML parser (an HTTP 400 kills the whole card).
  for (const garbage of [NaN, 0, -1000, undefined, null, 'not-a-timestamp', '2024-01-01T00:00:00Z']) {
    const out = relTime(garbage, 'unknown');
    assert.ok(!out.includes('<tg-time'), `garbage ${String(garbage)} produced a tg-time entity: ${out}`);
    assert.equal(out, 'unknown');
  }
  assert.equal(relTime(NaN), '—', 'missing fallback degrades to a dash');
});

// ── Sessions card: roster label/title/id + search query/snippet ────────────

function sessionCards(openCard, { roster, seams } = {}) {
  return createSessionCards({
    state: { bridge: undefined, lastSessionsProject: new Map() },
    requireCtx: () => fakeCtx(seams),
    // When `roster` is set, cardLoad short-circuits the adapter read and
    // returns the fixture directly (both roster and search hits flow here).
    cardLoad: async (_chatId, _label, fn) => (roster ? structuredClone(roster) : fn()),
    openCard,
    uiSend: async () => undefined,
    token: (payload) => JSON.stringify(payload),
  });
}

test('sessions roster card escapes hostile titles and cwd-derived group labels', async () => {
  const { seen, openCard } = captureCard();
  const cards = sessionCards(openCard, {
    roster: [{
      id: 'sess<i>&1</i>',
      // NOTE: a basename can never carry a full `<b>x</b>` payload intact —
      // closing tags contain `/`, which pathBasename splits on. That mangling
      // is correct path handling (and still escaped), so the group label here
      // carries the slash-free fragment while the session ROW below proves
      // the full-payload escaping.
      cwd: '/tmp/dir-&-<<s>>-<b>',
      live: true,
      running: false,
      title: '<b>x</b> & <<s>>',
      blank: false,
      lastPromptAt: 'not-a-number',
      eventCount: 3,
      archived: false,
    }],
  });
  await cards.openSessionsCard(1);
  assertNoRawMarkup(seen.text, 'sessions roster');
  assertEscapedForm(seen.text, 'sessions roster', ['<b>x</b>', '&', '<<s>>']);
  // The cwd basename drives the project-group label echoed in the header:
  assert.ok(seen.text.includes('&amp;-&lt;&lt;s&gt;&gt;-&lt;b&gt;'), seen.text);
});

test('sessions roster degrades a blind-cast garbage timestamp to text (no tg-time)', async () => {
  const { seen, openCard } = captureCard();
  const cards = sessionCards(openCard, {
    roster: [{
      id: 's1', cwd: '/tmp/p', live: true, running: false,
      title: 't', blank: false, lastPromptAt: '2024-01-01T00:00:00Z', eventCount: 1, archived: false,
    }],
  });
  await cards.openSessionsCard(1);
  assert.ok(!seen.text.includes('<tg-time'), `non-numeric timestamp leaked into a tg-time entity:\n${seen.text}`);
  assert.ok(seen.text.includes('⏱️ unknown'), seen.text);
});

test('search card escapes the raw query and hit snippets', async () => {
  const { seen, openCard } = captureCard();
  const cards = sessionCards(openCard, {
    roster: [{
      sessionId: 's<i>&1',
      seq: 7,
      type: 'user/message',
      snippet: '<b>x</b> & <<s>> <a href="javascript:alert(1)">c</a>',
      live: false,
    }],
  });
  await cards.openSearchCard(1, '<b>x</b>');
  assertNoRawMarkup(seen.text, 'search card');
  assertEscapedForm(seen.text, 'search card', HOSTILE);
});

// ── Presets card: description + id ──────────────────────────────────────────

test('preset roster escapes hostile preset descriptions', async () => {
  const { seen, openCard } = captureCard();
  const presetsSeam = {
    defaultId: undefined,
    authorable: true,
    hasDocument: true,
    list: async () => [{
      id: 'preset<b>&1',
      trust: 'user',
      description: '<b>x</b> <a href="javascript:alert(1)">c</a> & <<s>>',
    }],
  };
  const cards = createPresetCards({
    requireCtx: () => fakeCtx({ agentPresets: presetsSeam }),
    currentAgent: () => undefined,
    cardLoad: async (_chatId, _label, fn) => fn(),
    openCard,
    token: (p) => JSON.stringify(p),
  });
  await cards.openPresetsCard(1);
  assertNoRawMarkup(seen.text, 'presets roster');
  assertEscapedForm(seen.text, 'presets roster', HOSTILE);
});

// ── Workspaces card: registry title/path/timestamps ─────────────────────────

test('workspace cards escape hostile titles/paths and degrade garbage timestamps', async () => {
  const { seen, openCard } = captureCard();
  const registrySeam = {
    archivedSessionIds: [],
    list: () => [{
      id: 'ws<i>&1',
      path: '/ws/<b>x</b>&',
      title: '<b>x</b> & <<s>>',
      createdAt: 'garbage',
      updatedAt: -5,
    }],
  };
  const cards = createWorkspaceCards({
    state: { workspaceRoot: '/ws', configRoot: '/ws', config: { workspace: {}, security: { browseRoots: [] }, outbound: {} } },
    requireCtx: () => fakeCtx({ workspaceRegistry: registrySeam }),
    uiSend: async () => undefined,
    openCard,
    token: (p) => JSON.stringify(p),
    log: () => {},
    openMenuAt: async () => {},
  });
  await cards.openWorkspacesCard(1);
  assertNoRawMarkup(seen.text, 'workspaces roster');
  assertEscapedForm(seen.text, 'workspaces roster', ['<b>x</b>', '&', '<<s>>']);

  await cards.openWorkspaceDetailCard(1, 'ws<i>&1');
  assertNoRawMarkup(seen.text, 'workspace detail');
  assertEscapedForm(seen.text, 'workspace detail', ['<b>x</b>', '&', '<<s>>']);
  assert.ok(seen.text.includes('created unknown'), seen.text);
  assert.ok(seen.text.includes('updated unknown'), seen.text);
  assert.ok(!seen.text.includes('<tg-time'), `garbage timestamps leaked into tg-time entities:\n${seen.text}`);
});

// ── Host directory browser + settings namespace card ───────────────────────

function hostCards(openCard, seams = {}) {
  return createHostCards({
    state: { workspaceRoot: '/ws', config: { security: { browseRoots: [] } } },
    requireCtx: () => fakeCtx(seams),
    openCard,
    token: (p) => JSON.stringify(p),
  });
}

test('host directory card escapes hostile paths; entry names stay out of HTML', async () => {
  const { seen, openCard } = captureCard();
  const cards = hostCards(openCard);

  // ENOENT branch: the hostile path itself is the rendered fragment.
  await cards.openHostDirectoryCard(1, '/nonexistent/<b>x</b>&<<s>>');
  assertNoRawMarkup(seen.text, 'host directory (ENOENT)');
  assertEscapedForm(seen.text, 'host directory (ENOENT)', ['<b>x</b>', '&', '<<s>>']);

  // OK branch against a real directory: listing entry names ride ONLY the
  // callback-button lane (plain text, never parse_mode HTML), so the message
  // body must stay free of markup-shaped content even so.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  await cards.openHostDirectoryCard(1, repoRoot);
  assert.ok(!/<b>x<\/b>|<a href=/.test(seen.text), seen.text);
  const buttons = JSON.stringify(seen.keyboard ?? {});
  assert.ok(/"text":"📁 src"/.test(buttons) && /"text":"📁 test"/.test(buttons),
    `expected real directory entries as plain button labels: ${buttons}`);
});

test('host settings namespace card escapes applies flag, secret paths and namespace names', async () => {
  const { seen, openCard } = captureCard();
  const settingsSeam = {
    writable: true,
    documentPath: '/cfg/settings.yml',
    describe: () => [{
      ns: 'ns<b>&1',
      applies: '<i>x</i>',
      value: { nested: '<script>' },
      secrets: [{ path: ['cred<b>&', 'key'], set: true }],
      revision: 3,
    }],
  };
  const cards = hostCards(openCard, { settings: settingsSeam });
  await cards.openSettingsNamespaceCard(1, 'ns<b>&1');
  assertNoRawMarkup(seen.text, 'settings namespace card');
  assert.ok(seen.text.includes('applies: &lt;i&gt;x&lt;/i&gt;'), seen.text);
  assert.ok(seen.text.includes('cred&lt;b&gt;&amp;.key=set'), seen.text);
  assert.ok(seen.text.includes('&lt;script&gt;'), seen.text);
});

// ── Todos card content ──────────────────────────────────────────────────────

test('todos card strikes through completed items with escaped content', () => {
  const out = renderTodosCard([
    { content: '<b>x</b> & <<s>>', status: 'pending' },
    { content: '<a href="javascript:alert(1)">c</a>', status: 'completed' },
  ], true);
  assertNoRawMarkup(out, 'todos card');
  assertEscapedForm(out, 'todos card', HOSTILE);
  assert.ok(out.includes('<s>'), out);
});

// ── Goal objective line ─────────────────────────────────────────────────────

test('goals card escapes the objective and degrades a negative createdAt', async () => {
  const { seen, openCard } = captureCard();
  const goal = {
    id: 'g1', revision: 1,
    objective: '<b>x</b> <a href="javascript:alert(1)">c</a> & <<s>>',
    phase: 'active', activation: 'armed',
    roundsStarted: 2, maxGoalRounds: 10,
    createdAt: -99, updatedAt: Date.now(),
  };
  const agent = { id: 'agent-1' };
  const cards = createGoalCards({
    requireTransport: () => { throw new Error('unused'); },
    // getGoal re-resolves the agent through ctx.agents before asking the
    // goals service, so both seams must see the same instance.
    requireCtx: () => ({ agents: { list: () => [agent], get: () => agent }, get: (name) => (name === 'goals' ? { get: () => goal } : undefined) }),
    currentAgent: () => agent,
    ephemeral: {},
    uiOps: () => { throw new Error('unused'); },
    activeCardRenderers: new Map(),
    openCard,
    token: (p) => JSON.stringify(p),
    log: () => {},
    uiSend: async () => undefined,
  });
  await cards.openGoalsCard(1);
  assertNoRawMarkup(seen.text, 'goals card');
  assertEscapedForm(seen.text, 'goals card', HOSTILE);
  assert.ok(seen.text.includes('created —'), `negative createdAt should degrade to a dash:\n${seen.text}`);
  assert.ok(!seen.text.includes('<tg-time'), seen.text);
});

// ── Queue card: queued text preview + live progress objective ──────────────

test('queue card escapes queued previews, progress objective and current tool', async () => {
  const { seen, openCard } = captureCard();
  const makeItem = (id, text) => ({ id, content: [{ type: 'text', text }] });
  const inbox = { nextTurn: [makeItem('a', '<b>x</b> <a href="javascript:alert(1)">c</a> & <<s>>')], nextStep: [] };
  const agent = { id: 'agent-1', inbox, status: 'running' };
  const cards = createQueueCards({
    state: { transport: undefined },
    // listQueue re-resolves the agent through ctx.agents, so the seam must
    // expose the same instance the card closure sees.
    requireCtx: () => ({ agents: { list: () => [agent], get: () => agent }, get: () => undefined }),
    currentAgent: () => agent,
    boundAgentId: () => undefined,
    progressFor: () => ({
      objective: '<a href="javascript:alert(1)">c</a>',
      turn: 1, step: 2, tools: 3,
      currentTool: '<i>tool</i>',
      elapsedMs: 1500, todosDone: 0, todosTotal: 0,
    }),
    openCard,
  });
  await cards.openQueueCard(1);
  assertNoRawMarkup(seen.text, 'queue card');
  assertEscapedForm(seen.text, 'queue card', HOSTILE);
  assert.ok(seen.text.includes('&lt;i&gt;tool&lt;/i&gt;'), seen.text);
});

// ── Plugin roster / dynamic plugins ────────────────────────────────────────

function miscCards(openCard, seams = {}) {
  return createMiscCards({
    state: {
      workspaceRoot: '/ws',
      config: {
        outbound: { parseMode: 'HTML', disableNotification: false, maxRetries: 3, sendRatePerSecond: 25, maxMessageLength: 4096 },
        security: { allowedChatIds: [1] },
        watch: { autoStart: true },
      },
      transport: undefined,
      watching: false,
    },
    version: '0.0.0-test',
    requireCtx: () => fakeCtx(seams),
    currentAgent: () => undefined,
    boundSessionCwd: () => undefined,
    cardLoad: async (_chatId, _label, fn) => fn(),
    openCard,
    token: (p) => JSON.stringify(p),
    log: () => {},
  });
}

test('plugins roster escapes hostile module names and loader entry ids', async () => {
  const { seen, openCard } = captureCard();
  const cards = miscCards(openCard, {
    loader: {
      entries: () => [
        { id: 'entry<b>&1', options: { name: '<b>x</b> & <<s>>' }, disabled: false, fiber: { state: 2 } },
        // No module name: the raw loader entry id becomes the rendered label.
        { id: 'entry<a href="javascript:alert(1)">c</a>', options: {}, disabled: true, fiber: { state: 0 } },
      ],
    },
  });
  await cards.openPluginsCard(1);
  assertNoRawMarkup(seen.text, 'plugins roster');
  assertEscapedForm(seen.text, 'plugins roster', ['<b>x</b>', '&', '<<s>>']);
  // The 38-char anchor exceeds the 36-char label window, so only its escaped
  // PREFIX can appear — truncation must never re-open raw markup either way.
  assert.ok(seen.text.includes('&lt;a href=&quot;javascript:'), seen.text);
});

test('dynamic cordis card escapes hostile plugin ids and package ids', async () => {
  const { seen, openCard } = captureCard();
  const cards = miscCards(openCard, {
    dynamicCordisRunner: {
      inventory: () => [{
        // pluginId renders bold and untruncated; currentPackageId rides the
        // mono meta segment (packages[].packageId is only counted, never shown).
        pluginId: '<b>x</b>&<a href="javascript:alert(1)">c</a>',
        packages: [{ packageId: 'pkg-unused' }],
        currentPackageId: 'pkg&<<s>>',
        activeRun: null,
      }],
    },
  });
  await cards.openDynamicCordisCard(1);
  assertNoRawMarkup(seen.text, 'dynamic cordis card');
  assertEscapedForm(seen.text, 'dynamic cordis card', HOSTILE);
});

// ── Turn receipt + trajectory blockquote folding ───────────────────────────

test('turn receipt escapes the goal objective prefix', () => {
  const out = renderTurnReceipt({ durationMs: 1500, goalObjective: '<b>x</b> <a href="javascript:alert(1)">c</a> & <<s>>' });
  assertNoRawMarkup(out, 'turn receipt');
  assertEscapedForm(out, 'turn receipt', HOSTILE);
});

test('trajectory escapes step content and folds overflow into one closed quote per turn', () => {
  const steps = (first, n, prefix) => [
    { seq: 0, kind: 'user', text: '<b>x</b> <a href="javascript:alert(1)">c</a> & <<s>>' },
    ...Array.from({ length: n }, (_, i) => ({ seq: i + 1, kind: i % 2 === 0 ? 'tool-call' : 'tool-result', text: `${prefix} step ${i}` })),
  ].slice(first === false ? 1 : 0);
  const result = {
    hasMore: false,
    turns: [
      { startSeq: 0, index: 0, steps: steps(true, 3, 'short') }, // below the fold window
      { startSeq: 10, index: 1, model: 'deepseek/<b>chat</b>', outcome: 'completed', seconds: 2, changes: '<i>edit</i>', steps: steps(true, 12, 'long') },
      { startSeq: 30, index: 2, outcome: 'error: boom <&>', steps: steps(false, 12, 'second') },
    ],
  };
  const lines = renderTrajectoryLines('sess<i>&1', result);
  const text = lines.join('\n');
  assertNoRawMarkup(text, 'trajectory');
  assertEscapedForm(text, 'trajectory', HOSTILE);

  const opens = (text.match(/<blockquote expandable>/g) ?? []).length;
  const closes = (text.match(/<\/blockquote>/g) ?? []).length;
  assert.equal(opens, 2, 'exactly one folded quote per overflowing turn');
  assert.equal(closes, opens, 'every expandable quote is closed');
  assert.ok(!text.includes('<blockquote expandable><blockquote'), 'blockquotes must never nest');
  assert.ok(!text.includes('</blockquote></blockquote>'), 'blockquotes must never nest');

  // Splitting the rendered card into Telegram-sized parts must keep every
  // fragment parseable: the splitter closes an open quote at the cut and
  // replays `<blockquote expandable>` (attributes included) after it.
  for (const part of splitText(text, 512)) {
    const partOpens = (part.match(/<blockquote/g) ?? []).length;
    const partCloses = (part.match(/<\/blockquote>/g) ?? []).length;
    assert.ok(partOpens >= partCloses, `unclosed blockquote in split part:\n${part}`);
  }
});
