import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelsKeyboard } from '../dist/telegram/keyboard.js';
import { typingKeepaliveActive } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Issue #47: the selected model must be visible immediately after model-select
// ---------------------------------------------------------------------------

test('buildModelsKeyboard marks the current provider with a check mark (#47)', () => {
  const kb = buildModelsKeyboard(
    [{ id: 'volcengine-ark', name: 'Volcengine Ark' }, { id: 'opencode-go', name: 'OpenCode Go' }],
    'm:providers',
    'volcengine-ark',
  );
  const rows = kb.inline_keyboard.flat();
  const ark = rows.find((b) => b.callback_data === 'mo:volcengine-ark');
  const go = rows.find((b) => b.callback_data === 'mo:opencode-go');
  assert.match(ark.text, /^\u2705/, 'the current provider row carries a check mark');
  assert.doesNotMatch(go.text, /^\u2705/, 'other provider rows do not');
});

test('buildModelsKeyboard works without a current provider (no marker)', () => {
  const kb = buildModelsKeyboard([{ id: 'p', name: 'P' }]);
  assert.doesNotMatch(kb.inline_keyboard.flat()[0].text, /^\u2705/);
});

// ---------------------------------------------------------------------------
// Issue #48: typing keepalive must die when the turn dies
// ---------------------------------------------------------------------------

test('typingKeepaliveActive trusts the live agent status over the sticky flag (#48)', () => {
  // The #48 freeze: turn/end was lost, sticky flag says running, but the
  // agent is idle — the loop must stop.
  assert.equal(typingKeepaliveActive(false, true, 0), false, 'idle agent wins over a stale sticky flag');
  assert.equal(typingKeepaliveActive(true, false, 0), true, 'a genuinely running agent keeps typing');
  // No live agent observable: fall back to the sticky flag (issue #17).
  assert.equal(typingKeepaliveActive(undefined, true, 0), true);
  assert.equal(typingKeepaliveActive(undefined, false, 0), false);
});

test('typingKeepaliveActive enforces the rearm budget only on the stale path (#48)', () => {
  assert.equal(typingKeepaliveActive(true, true, 3), true, 'within budget keeps typing');
  // A genuinely running turn is never budget-killed: single turns can
  // legitimately outlast ~30-40 minutes (the budget check used to fire
  // before the live-agent check and killed typing mid-turn).
  assert.equal(typingKeepaliveActive(true, true, 4), true, 'a running agent keeps typing even over the limit');
  assert.equal(typingKeepaliveActive(true, false, 99), true, 'live agent status wins at any budget');
  assert.equal(typingKeepaliveActive(true, true, 99, 100), true, 'the limit is configurable');
  // The budget still caps the stale fallback where no live agent can answer.
  assert.equal(typingKeepaliveActive(undefined, true, 3), true, 'stale sticky flag keeps typing within budget');
  assert.equal(typingKeepaliveActive(undefined, true, 4), false, 'over the rearm limit the stale loop dies');
  assert.equal(typingKeepaliveActive(undefined, true, 99, 100), true, 'configurable limit still bounds the stale path');
  assert.equal(typingKeepaliveActive(undefined, true, 101, 100), false);
});
