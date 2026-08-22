import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTurnReceipt } from '../dist/telegram/turn-receipt.js';

test('turn receipt is ONE line with exactly the five user-facing metrics (#21)', () => {
  const receipt = renderTurnReceipt({
    durationMs: 210_000,
    reasoningSteps: 11,
    toolCalls: 15,
    tokens: { uncachedInputTokens: 500, outputTokens: 120, cacheReadTokens: 400, cacheWriteTokens: 0 },
    sessionStats: {
      turns: 1, steps: 13, toolCalls: 15, llmMs: 205_000, toolMs: 4_400,
      ttftMs: 2_200, ttftSteps: 1, decodeMs: 13_000, decodeTokens: 1_807,
      uncachedInputTokens: 900, outputTokens: 120, cacheReadTokens: 400, cacheWriteTokens: 0,
    },
  });
  assert.equal(receipt.split('\n').length, 1);
  assert.match(receipt, /⏱️ 210s/);
  assert.match(receipt, /🧠 11 次思考/);
  assert.match(receipt, /🛠️ 15 次工具/);
  assert.match(receipt, /📊 1 轮 · 13 步/);
  assert.match(receipt, /💾 命中 44%/);
  assert.equal(receipt.includes('📥'), false, 'token billing is not user-facing');
  assert.equal(receipt.includes('📤'), false);
  assert.equal(receipt.includes('⚡'), false, 'performance segments are internal-only');
  assert.equal(receipt.includes('🎯'), false, 'no duplicate metrics icon');
  assert.equal(receipt.includes('OpenClaw'), false, 'renderer internals never leak');
  assert.equal(receipt.includes('─'), false, 'no separator line');
});

test('goal receipt keeps the goal prefix on the same single line', () => {
  const receipt = renderTurnReceipt({
    durationMs: 23 * 60_000,
    reasoningSteps: 0,
    toolCalls: 3,
    goalObjective: 'ship the release',
    tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(receipt, '✅ <b>ship the release</b> · ⏱️ 1380s · 🛠️ 3 次工具');
});

test('cache hit is omitted when there is no billed input', () => {
  const receipt = renderTurnReceipt({
    durationMs: 1_000,
    reasoningSteps: 2,
    tokens: { uncachedInputTokens: 0, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(receipt, '⚙️ <b>完成</b> · ⏱️ 1s · 🧠 2 次思考');
});
