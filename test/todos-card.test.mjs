import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTodosCard } from '../dist/telegram/todos-card.js';

const todo = (content, status = 'pending') => ({ content, status });

test('todo card shows live pending/total counts while work remains', () => {
  const text = renderTodosCard([
    todo('read docs', 'completed'),
    todo('write code', 'in_progress'),
    todo('ship'),
  ], true);
  assert.match(text, /📌 <b>Todos<\/b> · 2 pending · 3 total/);
  assert.match(text, /Auto-refreshes every 5s/);
  assert.doesNotMatch(text, /No live agent/);
});

test('todo card switches to a completion state when everything is done', () => {
  const text = renderTodosCard([
    todo('read docs', 'completed'),
    todo('write code', 'completed'),
  ], true);
  assert.match(text, /✅ <b>Todos<\/b> · complete · <b>2\/2 done<\/b>/);
  assert.match(text, /▓▓▓▓▓▓▓▓▓▓ 100%/);
});

test('todo card without a live agent stays a read-only guidance card', () => {
  const text = renderTodosCard([], false);
  assert.match(text, /📌 <b>Todos<\/b> · No live agent/);
  assert.match(text, /\(no todos yet\)/);
  assert.match(text, /todos are session-scoped/);
});
