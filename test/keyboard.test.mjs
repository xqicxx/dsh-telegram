import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_LABELS, ABORT_BTN, buildBackKeyboard, buildBarKeyboard, buildCollapsedBarKeyboard, buildConfirmKeyboard, buildGoalsKeyboard, buildHistoryKeyboard, buildMenuPage, buildModelsKeyboard, buildPagingKeyboard, buildProjectKeyboard, buildQueueKeyboard, buildSearchKeyboard, buildSessionDetailKeyboard, buildSessionsKeyboard, buildSessionProjectsKeyboard, buildSettingsKeyboard, buildSubagentDetailKeyboard, buildThinkingKeyboard, buildModelDetailKeyboard, buildWorkspaceKeyboard, buildWorkspaceDetailKeyboard, CALLBACK_RE, COLLAPSE_BTN, decodeCallbackValue, encodedCallback, GOAL_BTN, inputPromptKeyboard, LEGACY_COLLAPSE_BTN, LEGACY_RETURN_BTN, normalizeBarLabel, PRESETS_BTN, queueBarLabel, RETURN_BTN, STOP_BTN, TODO_BTN, todoBarLabel } from '../dist/telegram/keyboard.js';

test('reply bar layout is Menu/New/Models, Sessions/Plugins/Status, Goal/Queue/Compact, Todos/Abort/收起', () => {
  const bar = buildBarKeyboard();
  assert.equal(bar.keyboard.length, 4);
  assert.deepEqual(
    bar.keyboard.map((row) => row.map((b) => b.text)),
    [
      ['\u2630 Menu', '\u2728 New', '\u{1F9E9} Models'],
      ['\u{1F9ED} Sessions', '\u{1F50C} Plugins', '\u{1F4CA} Status'],
      ['\u{1F3AF} Goal', '\u231B Queue', '\u{1F9F9} Compact'],
      ['\u{1F4CB} Todos', '\u23F9 Abort', '\u{1F5DC}\uFE0F \u6536\u8D77'],
    ],
  );
  assert.equal(bar.is_persistent, true);
  assert.equal(bar.resize_keyboard, true);
});

test('collapsed bar leaves only the single return button', () => {
  const collapsed = buildCollapsedBarKeyboard();
  assert.deepEqual(
    collapsed.keyboard.map((row) => row.map((button) => button.text)),
    [['\u8FD4\u56DE']],
  );
  assert.equal(collapsed.is_persistent, true);
});

test('collapse/return labels normalize including legacy bars', () => {
  assert.equal(normalizeBarLabel(RETURN_BTN), RETURN_BTN);
  assert.equal(normalizeBarLabel(COLLAPSE_BTN), COLLAPSE_BTN);
  assert.equal(normalizeBarLabel(GOAL_BTN), GOAL_BTN);
  assert.equal(normalizeBarLabel(PRESETS_BTN), PRESETS_BTN, 'stale bars keep Presets working');
  assert.equal(normalizeBarLabel(LEGACY_COLLAPSE_BTN), COLLAPSE_BTN, 'stale monkey collapse label still maps');
  assert.equal(normalizeBarLabel(LEGACY_RETURN_BTN), RETURN_BTN, 'stale emoji return label still maps');
  assert.equal(normalizeBarLabel(STOP_BTN), ABORT_BTN, 'stale Stop label dispatches to Abort');
});

test('queue card offers delete/resend and run-now, never inline edit', () => {
  const kb = buildQueueKeyboard([
    { itemId: 'item-a', kind: 'next-turn', index: 0 },
    { itemId: 'item-b', kind: 'next-step', index: 1 },
  ]);
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.ok(rows[0][0].text.startsWith('\u{1F5D1} Delete #1'));
  assert.equal(rows[0][0].callback_data, 'q:item-a:r');
  assert.ok(rows[0][1].text.startsWith('\u26A1 Run #1 now'));
  assert.equal(rows[0][1].callback_data, 'q:item-a:s');
  assert.equal(rows[1].length, 1);
  assert.ok(rows[1][0].text.startsWith('\u{1F5D1} Delete #2'));
  assert.equal(rows[1][0].callback_data, 'q:item-b:r');
  assert.equal(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'q:item-a:e')), false);
  assert.deepEqual(rows[2].map((b) => b.callback_data), ['m:back']);
});

test('BAR_LABELS keeps the old New label for stale persisted bars', () => {
  assert.ok(BAR_LABELS.includes('\u2728 New'));
});

test('bar embeds the live queue and todo counts without changing the layout', () => {
  const bar = buildBarKeyboard(7, 3);
  assert.equal(bar.keyboard.length, 4);
  assert.deepEqual(bar.keyboard.map((row) => row.length), [3, 3, 3, 3]);
  const texts = bar.keyboard.flat().map((b) => b.text);
  assert.ok(texts.includes(queueBarLabel(7)));
  assert.ok(texts.includes(todoBarLabel(3)));
  assert.ok(texts.includes('\u231B Queue') === false);
  assert.ok(texts.includes('\u{1F4CB} Todos') === false);
  for (const label of ['\u2630 Menu', '\u2728 New', '\u{1F9E9} Models', '\u{1F9ED} Sessions', '\u{1F50C} Plugins', '\u{1F4CA} Status', '\u{1F3AF} Goal', '\u{1F9F9} Compact', '\u23F9 Abort', '\u{1F5DC}\uFE0F \u6536\u8D77']) {
    assert.ok(texts.includes(label), `bar missing ${label}`);
  }
  assert.ok(texts.includes('\u{1F3AD} Presets') === false, 'Presets no longer renders on the bar');
  assert.ok(texts.includes('\u{1F9E0} Reasoning') === false);
  assert.equal(bar.is_persistent, true);
  assert.equal(bar.resize_keyboard, true);
});

test('dynamic Queue labels normalize to the canonical bar button', () => {
  assert.equal(normalizeBarLabel('\u231B Queue'), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u231B Queue \u00B7 0'), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u231B Queue \u00B7 123'), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u231B Queue \u00B7 '), '\u231B Queue');
  assert.equal(normalizeBarLabel('\u2630 Menu'), '\u2630 Menu');
  assert.equal(normalizeBarLabel('\u2728 New'), '\u2728 New');
  assert.equal(normalizeBarLabel('random text'), undefined);
  assert.equal(normalizeBarLabel('\u231B Queueing'), undefined);
});

test('menu page renders full rows, pairs, nav, and close', () => {
  const kb = buildMenuPage(
    [
      { label: '✨ New session · proj', cb: 'm:new', full: true },
      { label: '⌛ Queue · 2', cb: 'm:queue' },
      { label: '🎯 Goals', cb: 'm:goals' },
    ],
    0,
    2,
  );
  const rows = kb.inline_keyboard;
  assert.equal(rows[0].length, 1);
  assert.deepEqual(rows[0].map((b) => b.callback_data), ['m:new']);
  assert.equal(rows[1].length, 2);
  assert.deepEqual(rows[1].map((b) => b.callback_data), ['m:queue', 'm:goals']);
  assert.deepEqual(rows[2].map((b) => b.callback_data), ['m:more']);
  assert.deepEqual(rows[3].map((b) => b.callback_data), ['m:close']);
});

test('menu page nav adapts to first, middle, and last pages', () => {
  const items = [{ label: 'x', cb: 'm:x' }];
  const first = buildMenuPage(items, 0, 4).inline_keyboard;
  assert.deepEqual(first[1].map((b) => b.callback_data), ['m:more']);
  const middle = buildMenuPage(items, 1, 4).inline_keyboard;
  assert.deepEqual(middle[1].map((b) => b.callback_data), ['m:prev', 'm:more']);
  const last = buildMenuPage(items, 3, 4).inline_keyboard;
  assert.deepEqual(last[1].map((b) => b.callback_data), ['m:prev']);
});

test('back keyboard is a single m:back row', () => {
  const kb = buildBackKeyboard();
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ['m:back']);
});

test('CALLBACK_RE only accepts the m: prefix vocabulary', () => {
  assert.deepEqual('m:models'.match(CALLBACK_RE)?.[1], 'models');
  assert.equal(CALLBACK_RE.test('other:models'), false);
  assert.equal(CALLBACK_RE.test('m:UPPER'), false);
});

test('thinking keyboard lists the five fixed levels with the current one checked', () => {
  const kb = buildThinkingKeyboard(
    [
      { id: 'minimal', name: 'Minimal', cb: 't:1' },
      { id: 'low', name: 'Low', cb: 't:2' },
      { id: 'medium', name: 'Medium', cb: 't:3' },
      { id: 'high', name: 'High', cb: 't:4' },
      { id: 'max', name: 'Max', cb: 't:5' },
    ],
    'low',
  );
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 6);
  assert.equal(rows[0][0].callback_data, 't:1');
  assert.ok(rows[1][0].text.startsWith('\u2705'));
  assert.equal(rows[1][0].callback_data, 't:2');
  assert.ok(rows[2][0].text.startsWith('\u25CB'));
  assert.equal(rows[5][0].callback_data, 'm:back');
});

test('thinking keyboard marks medium as current when nothing selected', () => {
  const kb = buildThinkingKeyboard(
    [
      { id: 'minimal', name: 'Minimal', cb: 't:1' },
      { id: 'medium', name: 'Medium', cb: 't:2' },
      { id: 'max', name: 'Max', cb: 't:3' },
    ],
    'medium',
  );
  assert.ok(kb.inline_keyboard[1][0].text.startsWith('\u2705'));
});

test('model detail keyboard carries a Thinking row when reasoning is available', () => {
  const kb = buildModelDetailKeyboard([{ id: 'm1', name: 'Model One', cb: 't:1' }], { label: 'high', cb: 't:9' });
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0].callback_data, 't:9');
  assert.ok(rows[1][0].text.includes('Thinking'));
  assert.equal(rows[2][0].callback_data, 'm:models');
});

test('callback chat resolves from callback_query.message.chat (Bot API shape)', async () => {
  const { callbackUpdateChatId } = await import('../dist/telegram/transport.js');
  assert.equal(callbackUpdateChatId({ message: { chat: { id: 8753447694 } } }), 8753447694);
  assert.equal(callbackUpdateChatId({ chat: { id: 1 }, message: { chat: { id: 2 } } }), 2);
  assert.equal(callbackUpdateChatId({}), undefined);
  assert.equal(callbackUpdateChatId({ message: {} }), undefined);
});

test('buildConfirmKeyboard lays out confirm and cancel side by side', () => {
  const kb = buildConfirmKeyboard({ confirm: 't:1', cancel: 't:2' });
  assert.deepEqual(kb.inline_keyboard, [
    [
      { text: '\u2705 Confirm', callback_data: 't:1' },
      { text: '\u2716 Cancel', callback_data: 't:2' },
    ],
  ]);
});

test('buildSessionsKeyboard paginates ids, shows titles, and adds the project switcher', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `session-${i}`, title: i % 2 === 0 ? `My session ${i}` : undefined, running: i === 0 }));
  const first = buildSessionsKeyboard(items, { projectCount: 3, projectsCb: 't:projects', paging: { next: 't:next' } });
  assert.equal(first.inline_keyboard.filter((row) => row.some((b) => b.text.startsWith('🧭'))).length, 10);
  assert.ok(first.inline_keyboard.some((row) => row.some((b) => b.text.includes('My session 0'))), 'button should show the custom title');
  assert.ok(first.inline_keyboard.some((row) => row.some((b) => b.text.includes('▶ My session 0'))), 'running session button carries the running marker');
  assert.ok(first.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:projects')), 'project switcher button present');
  assert.equal(first.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'm:search')), false, 'the Sessions card no longer advertises search');
  const nav = first.inline_keyboard.find((row) => row.some((b) => b.callback_data === 't:next'));
  assert.ok(nav);
  const last = buildSessionsKeyboard(items.slice(10), { paging: { previous: 't:prev', next: 't:next2' } });
  assert.ok(last.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:prev')));
  assert.equal(last.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:projects')), false, 'no project button without a callback');
});

test('buildSessionsKeyboard adds inline archive/delete buttons when callbacks are provided', () => {
  const kb = buildSessionsKeyboard([
    { id: 'session-a', title: 'Alpha', archiveCb: 't:archive-a', deleteCb: 't:delete-a' },
    { id: 'session-b', title: 'Beta' },
  ]);
  const rows = kb.inline_keyboard.filter((row) => row.some((button) => button.text.startsWith('🧭')));
  assert.equal(rows[0].some((button) => button.callback_data === 't:archive-a' && button.text === '归档'), true);
  assert.equal(rows[0].some((button) => button.callback_data === 't:delete-a' && button.text === '删除'), true);
  assert.equal(rows[1].some((button) => button.callback_data === 't:archive-a'), false);
});

test('buildWorkspaceKeyboard keeps the legacy w:create action that the callback router special-cases', () => {
  const kb = buildWorkspaceKeyboard([
    { id: 'ws-1', title: 'One' },
    { id: 'ws-2', title: 'Two' },
  ]);
  const callbacks = kb.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes('w:ws-1'));
  assert.ok(callbacks.includes('w:create'), 'Create must stay w:create — w:<id>:<sub> parsing misreads it as a workspace id');
  assert.equal(callbacks.includes('w:create:create'), false);
});

test('buildGoalsKeyboard is display/edit/pause only and never offers Create', () => {
  const empty = buildGoalsKeyboard(false, {});
  const emptyTexts = empty.inline_keyboard.flat().map((button) => button.text).join(' ');
  assert.equal(emptyTexts.includes('Create'), false, 'no goal = display-only; /goal starts it');
  const active = buildGoalsKeyboard(true, { edit: 't:edit', toggle: 't:toggle' }, false);
  const activeCallbacks = active.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(activeCallbacks.includes('t:edit'));
  assert.ok(activeCallbacks.includes('t:toggle'));
  assert.ok(active.inline_keyboard.flat().some((button) => button.text.startsWith('⏸ Pause')));
  const paused = buildGoalsKeyboard(true, { edit: 't:edit', toggle: 't:toggle' }, true);
  assert.ok(paused.inline_keyboard.flat().some((button) => button.text.startsWith('▶ Resume')));
});

test('buildWorkspaceDetailKeyboard adds Use/Sessions actions only when provided', () => {
  const withActions = buildWorkspaceDetailKeyboard('ws-1', { use: 't:use', sessions: 't:sessions' });
  const callbacks = withActions.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes('t:use'));
  assert.ok(callbacks.includes('t:sessions'));
  assert.ok(callbacks.includes('w:ws-1:rename'));
  const bare = buildWorkspaceDetailKeyboard('ws-1');
  const bareCallbacks = bare.inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(bareCallbacks.includes('t:use'), false);
  assert.ok(bareCallbacks.includes('w:ws-1:rename'));
});

test('buildSessionProjectsKeyboard lists all/projects with running counts and paging', () => {
  const items = [
    { label: 'Alpha', running: 2, total: 4, cb: 't:a' },
    { label: 'Beta', running: 0, total: 1, cb: 't:b' },
  ];
  const kb = buildSessionProjectsKeyboard(items, { all: 't:all', paging: { next: 't:next' }, back: 't:back' });
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:all')));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:a' && b.text.includes('▶2'))));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:b' && b.text.includes('共1'))));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:next')));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:back')));
});

test('buildHistoryKeyboard adds Load older only when there is an older window', () => {
  const withOlder = buildHistoryKeyboard('s1', 't:older');
  assert.ok(withOlder.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:older')));
  const last = buildHistoryKeyboard('s1');
  assert.ok(last.inline_keyboard.some((row) => row.some((b) => b.callback_data === 's:s1')));
  assert.equal(last.inline_keyboard.some((row) => row.some((b) => b.text === '⏪ Load older')), false);
});

test('buildModelDetailKeyboard paginates to 12 models and adds nav', () => {
  const models = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}`, cb: `t:${i}` }));
  const kb = buildModelDetailKeyboard(models, undefined, { next: 't:next' });
  assert.equal(kb.inline_keyboard.filter((row) => row.some((b) => b.callback_data.startsWith('t:') && /^t:\d+$/.test(b.callback_data))).length, 12);
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:next')));
  const last = buildModelDetailKeyboard(models.slice(12), undefined, { previous: 't:prev' });
  assert.ok(last.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:prev')));
});

test('buildPagingKeyboard shows nav only when a page edge exists', () => {
  const kb = buildPagingKeyboard({ next: 't:next', back: 'm:plugins' });
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:next')));
  assert.equal(kb.inline_keyboard.some((row) => row.some((b) => b.text === '‹ Prev')), false);
  const both = buildPagingKeyboard({ previous: 't:prev', next: 't:next', back: 'm:plugins' });
  assert.ok(both.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:prev')));
  assert.ok(both.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'm:plugins')));
});

test('buildSearchKeyboard lists hit sessions with new-search and sessions actions', () => {
  const kb = buildSearchKeyboard(['s-one', 's-two'], { next: 't:next' });
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 's:s-one')));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:next')));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'm:search')));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'm:sessions')));
});

test('buildSubagentDetailKeyboard hides prompt/interrupt for non-continuable children', () => {
  const readOnly = buildSubagentDetailKeyboard({ history: 't:h' });
  assert.equal(readOnly.inline_keyboard.some((row) => row.some((b) => b.text === '📨 Prompt')), false);
  assert.equal(readOnly.inline_keyboard.some((row) => row.some((b) => b.text === '⏹ Interrupt')), false);
  const full = buildSubagentDetailKeyboard({ prompt: 't:p', interrupt: 't:i', history: 't:h' });
  assert.ok(full.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:p')));
  assert.ok(full.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:i')));
});

test('buildProjectKeyboard renders a New folder action and a Menu return', () => {
  const kb = buildProjectKeyboard([], { newFolder: 't:mkdir', menu: 'm:back', close: 'm:host' });
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 't:mkdir')));
  assert.ok(kb.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'm:back' && b.text === '☰ Menu')));
  const without = buildProjectKeyboard([], { close: 'm:host' });
  assert.equal(without.inline_keyboard.some((row) => row.some((b) => b.text === '📁 New folder')), false);
});

test('model/settings callback payloads are percent-encoded and decode safely', () => {
  const models = buildModelsKeyboard([{ id: 'my%provider', name: 'My Provider' }]);
  const mo = models.inline_keyboard.flat().find((b) => b.callback_data.startsWith('mo:'))?.callback_data;
  assert.equal(mo, 'mo:my%25provider');
  assert.equal(decodeCallbackValue(mo.slice(3)), 'my%provider');

  const settings = buildSettingsKeyboard(['ns%2f']);
  const set = settings.inline_keyboard.flat().find((b) => b.callback_data.startsWith('set:'))?.callback_data;
  assert.equal(set, 'set:ns%252f');
  assert.equal(decodeCallbackValue(set.slice(4)), 'ns%2f');

  assert.equal(decodeCallbackValue('bad%'), 'bad%');
});

test('encodedCallback keeps payloads within 64 bytes as valid percent-encoding', () => {
  const cb = encodedCallback('mo:', 'x'.repeat(200));
  assert.ok(new TextEncoder().encode(cb).length <= 64);
  assert.ok(cb.startsWith('mo:'));
  assert.doesNotThrow(() => decodeCallbackValue(cb.slice(3)));
  assert.ok(decodeCallbackValue(cb.slice(3)).length > 0);
});

test('inputPromptKeyboard uses Telegram ForceReply with a placeholder', () => {
  assert.deepEqual(inputPromptKeyboard('Send the corrected message\u2026'), {
    force_reply: true,
    input_field_placeholder: 'Send the corrected message\u2026',
  });
  assert.equal(inputPromptKeyboard('x'.repeat(100)).input_field_placeholder.length, 64);
});

// ---------------------------------------------------------------------------
// RE-9: Telegram caps callback_data at 64 BYTES, not 64 UTF-16 code units.
// A CJK/emoji id sliced by code units could still exceed the byte budget
// (whole-card 400) or silently retarget the tap. Every s:/w:/q: payload now
// goes through the byte-safe encodedCallback path.
// ---------------------------------------------------------------------------

const byteLength = (value) => new TextEncoder().encode(value).length;

function assertByteSafe(kb, prefix) {
  for (const button of kb.inline_keyboard.flat()) {
    if (!button.callback_data.startsWith(prefix)) continue;
    assert.ok(
      byteLength(button.callback_data) <= 64,
      `callback_data ${JSON.stringify(button.callback_data)} exceeds 64 bytes`,
    );
  }
}

test('non-ASCII session ids keep every callback payload within 64 bytes (RE-9)', () => {
  const cjk = '\u4f1a'.repeat(40); // 40 CJK chars = 120 UTF-8 bytes, fit nowhere raw
  assert.ok(byteLength(`s:${cjk}`) > 64, 'fixture must exceed the byte budget before encoding');

  assertByteSafe(buildSearchKeyboard([cjk]), 's:');
  assertByteSafe(buildSessionsKeyboard([{ id: cjk, title: cjk }]), 's:');
  assertByteSafe(buildHistoryKeyboard(cjk), 's:');
  assertByteSafe(buildSessionDetailKeyboard(cjk, false), 's:');
});

test('non-ASCII workspace and queue ids keep every callback payload within 64 bytes (RE-9)', () => {
  const cjk = '\u5de5'.repeat(40);
  assertByteSafe(buildWorkspaceKeyboard([{ id: cjk, title: cjk }]), 'w:');
  assertByteSafe(buildWorkspaceDetailKeyboard(cjk), 'w:');
  assertByteSafe(buildQueueKeyboard([{ itemId: cjk, kind: 'next-turn' }, { itemId: cjk, kind: 'next-step' }]), 'q:');
});

test('action suffixes survive on byte-trimmed detail payloads (RE-9)', () => {
  const long = 's'.repeat(200);
  const kb = buildSessionDetailKeyboard(long, false);
  const callbacks = kb.inline_keyboard.flat().map((button) => button.callback_data);
  for (const action of ['use', 'history', 'rename', 'fork', 'archive', 'model', 'queue', 'steer', 'log', 'stop', 'delete']) {
    assert.ok(callbacks.some((cb) => cb.endsWith(`:${action}`)), `:${action} button lost`);
  }
  for (const cb of callbacks) {
    assert.ok(byteLength(cb) <= 64, `callback_data ${JSON.stringify(cb)} exceeds 64 bytes`);
    assert.doesNotThrow(() => decodeCallbackValue(cb.slice(2).split(':')[0]), 'encoded id segment must stay decodable');
  }
});

test('ASCII ids produce unchanged payloads — no gratuitous re-encoding (RE-9)', () => {
  assert.equal(buildSearchKeyboard(['s-one']).inline_keyboard[0][0].callback_data, 's:s-one');
  assert.equal(buildHistoryKeyboard('s1').inline_keyboard.at(-1)[0].callback_data, 's:s1');
  const detail = buildSessionDetailKeyboard('abc', false);
  assert.ok(detail.inline_keyboard.flat().some((b) => b.callback_data === 's:abc:use'));
  const queue = buildQueueKeyboard([{ itemId: 'q-9', kind: 'next-turn' }]);
  assert.deepEqual(
    queue.inline_keyboard[0].map((b) => b.callback_data),
    ['q:q-9:r', 'q:q-9:s'],
  );
});
