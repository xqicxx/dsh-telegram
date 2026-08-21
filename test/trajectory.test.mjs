import test from 'node:test';
import assert from 'node:assert/strict';
import { readTrajectory } from '../dist/harness/adapters/sessions.js';
import { renderTrajectoryLines, formatToolCallText, TRAJECTORY_MAX_STEPS_PER_TURN } from '../dist/telegram/trajectory.js';

function trajectoryCtx(events) {
  const ctx = {
    sessions: { list: () => [{ id: 's1', events, header: {} }], get: () => ({ id: 's1', events, header: {} }) },
    agents: { list: () => [], get: () => undefined },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
  };
  return ctx;
}

function fixtureEvents() {
  return [
    { seq: 0, type: 'session', at: 1000, data: { agentPreset: 'default' } },
    { seq: 1, type: 'turn/start', at: 1100, data: {} },
    { seq: 2, type: 'request/header', at: 1200, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
    { seq: 3, type: 'user/message', at: 1300, data: { content: [{ type: 'text', text: 'hello <b>world</b>' }] } },
    { seq: 4, type: 'assistant/message', at: 2000, data: { message: { content: [
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'text', text: 'hi there' },
    ] } } },
    { seq: 5, type: 'tool/call', at: 2100, data: { name: 'bash', arguments: '{"command":"ls"}' } },
    { seq: 6, type: 'tool/result', at: 2200, data: { output: 'file.txt' } },
    { seq: 7, type: 'turn/end', at: 3000, data: { reason: { kind: 'completed' } } },
    { seq: 8, type: 'turn/start', at: 4000, data: {} },
    { seq: 9, type: 'user/message', at: 4100, data: { content: [{ type: 'text', text: 'second question' }] } },
    { seq: 10, type: 'turn/end', at: 5000, data: { reason: { kind: 'error', error: { message: '429 status code (no body)' } } } },
  ];
}

test('readTrajectory groups events into turns with model, outcome and duration', async () => {
  const result = await readTrajectory(trajectoryCtx(fixtureEvents()), 's1', 10);
  assert.equal(result.hasMore, false);
  // prelude (session event) + 2 turns
  assert.equal(result.turns.length, 3);

  const [prelude, first, second] = result.turns;
  assert.equal(prelude.index, 0);
  assert.equal(prelude.startSeq, 0);

  assert.equal(first.index, 1);
  assert.equal(first.model, 'deepseek/deepseek-chat');
  assert.equal(first.outcome, 'completed');
  assert.equal(first.seconds, 2);
  assert.deepEqual(first.steps.map((s) => s.kind), ['user', 'reasoning', 'assistant', 'tool-call', 'tool-result']);
  assert.equal(first.steps[2].text, 'hi there');
  assert.match(first.steps[3].text, /^bash /);
  assert.match(first.steps[3].text, /ls/);

  assert.equal(second.index, 2);
  assert.match(second.outcome, /^error: 429/);
  assert.equal(second.seconds, 1);
});

test('readTrajectory pages older turns with hasMore/nextBefore', async () => {
  const ctx = trajectoryCtx(fixtureEvents());
  const page1 = await readTrajectory(ctx, 's1', 1);
  assert.equal(page1.turns.length, 1);
  assert.equal(page1.turns[0].index, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextBefore, 8);

  const page2 = await readTrajectory(ctx, 's1', 1, page1.nextBefore);
  assert.equal(page2.turns.length, 1);
  assert.equal(page2.turns[0].index, 1);
  assert.equal(page2.hasMore, true);

  const page3 = await readTrajectory(ctx, 's1', 1, page2.nextBefore);
  assert.equal(page3.turns.length, 1);
  assert.equal(page3.turns[0].index, 0);
  assert.equal(page3.hasMore, false);
});

test('readTrajectory returns empty for an unknown session without persistence', async () => {
  const ctx = { sessions: { list: () => [], get: () => undefined }, agents: { list: () => [], get: () => undefined }, get: () => undefined };
  const result = await readTrajectory(ctx, 'nope', 6);
  assert.deepEqual(result, { turns: [], hasMore: false });
});

test('renderTrajectoryLines renders turn headers, step icons and escapes HTML', () => {
  const result = {
    turns: [{
      startSeq: 1,
      endSeq: 7,
      index: 1,
      seconds: 12,
      outcome: 'completed',
      model: 'deepseek/deepseek-chat',
      steps: [
        { seq: 3, kind: 'user', text: 'hello <b>world</b>' },
        { seq: 4, kind: 'reasoning', text: 'thinking' },
        { seq: 5, kind: 'tool-call', text: 'bash {"command":"ls"}' },
        { seq: 6, kind: 'tool-result', text: 'file.txt' },
        { seq: 7, kind: 'assistant', text: 'done' },
      ],
    }],
    hasMore: false,
  };
  const text = renderTrajectoryLines('s1', result).join('\n');
  assert.match(text, /📜 Trajectory · s1 \(1 turn\)/);
  assert.match(text, /▸ <b>Turn 1<\/b> · <code>deepseek\/deepseek-chat<\/code> · ✅ completed · ⏱️ 12s/);
  assert.match(text, /👤 hello &lt;b&gt;world&lt;\/b&gt;/);
  assert.match(text, /🧠 thinking/);
  assert.match(text, /🔧 bash/);
  assert.match(text, /📥 file\.txt/);
  assert.match(text, /🤖 done/);
});

test('renderTrajectoryLines marks errors, running turns and folds long step lists', () => {
  const manySteps = Array.from({ length: TRAJECTORY_MAX_STEPS_PER_TURN + 3 }, (_, i) => ({ seq: i + 1, kind: 'tool-call', text: `tool ${i}` }));
  const result = {
    turns: [
      { startSeq: 1, index: 1, outcome: 'error: boom', steps: [{ seq: 2, kind: 'user', text: 'go' }] },
      { startSeq: 3, index: 2, steps: manySteps },
    ],
    hasMore: true,
  };
  const text = renderTrajectoryLines('s1', result).join('\n');
  assert.match(text, /\(2 turns\+\)/);
  assert.match(text, /❌ error: boom/);
  assert.match(text, /⏳ running/);
  assert.match(text, /… 3 more step\(s\)/);
});

test('renderTrajectoryLines renders the empty state', () => {
  const text = renderTrajectoryLines('s1', { turns: [], hasMore: false }).join('\n');
  assert.match(text, /\(0 turns\)/);
  assert.match(text, /\(no events\)/);
});

test('multi-line step text folds to a single line (#history rendering)', () => {
  const result = {
    turns: [{
      startSeq: 1, index: 1, outcome: 'completed',
      steps: [
        { seq: 1, kind: 'assistant', text: 'line one\n\nline two\n  line three' },
        { seq: 2, kind: 'tool-result', text: '# Title\n\nbody text\n\n## Section' },
      ],
    }],
    hasMore: false,
  };
  for (const line of renderTrajectoryLines('s1', result)) {
    if (line.startsWith('  ')) assert.doesNotMatch(line, /\n/, 'step lines never contain newlines');
  }
  const text = renderTrajectoryLines('s1', result).join('\n');
  assert.match(text, /🤖 line one line two line three/);
  assert.match(text, /📥 # Title body text ## Section/, 'tool-result is a folded single-line summary');
});

test('formatToolCallText extracts the semantic argument from raw JSON (#history)', () => {
  assert.equal(formatToolCallText('read {"path":"/home/ubuntu/project/README.md"}'), 'read /home/ubuntu/project/README.md');
  assert.equal(formatToolCallText('bash {"command":"npm test"}'), 'bash npm test');
  assert.equal(formatToolCallText('search {"query":"deepseek harness"}'), 'search deepseek harness');
  assert.equal(formatToolCallText('curl {"url":"https://example.com"}'), 'curl https://example.com');
  // Unknown keys fall back to compact JSON; unparseable text passes through.
  assert.equal(formatToolCallText('weird {"a":1,"b":"x"}'), 'weird {"a":1,"b":"x"}');
  assert.equal(formatToolCallText('plain text no json'), 'plain text no json');
  assert.equal(formatToolCallText('broken {"path":"unterminated'), 'broken {"path":"unterminated');
  // Multi-line JSON args fold too.
  assert.equal(formatToolCallText('edit {"path":"/a/b.txt"}'), 'edit /a/b.txt');
});

test('empty turns are skipped and turns are separated by a thin divider (#history)', () => {
  const result = {
    turns: [
      { startSeq: 1, index: 0, outcome: undefined, steps: [] },
      { startSeq: 2, index: 1, outcome: 'completed', steps: [{ seq: 3, kind: 'user', text: 'hi' }] },
      { startSeq: 5, index: 2, outcome: 'completed', steps: [{ seq: 6, kind: 'assistant', text: 'hello' }] },
    ],
    hasMore: false,
  };
  const lines = renderTrajectoryLines('s1', result);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /\(no steps\)/, 'empty turns are not rendered at all');
  assert.doesNotMatch(text, /Prelude/, 'the empty Prelude header is gone');
  assert.ok(lines.some((line) => /^─+$/.test(line)), 'a thin divider separates consecutive turns');
});

test('all-empty turns degrade to a single placeholder instead of nothing', () => {
  const result = {
    turns: [{ startSeq: 1, index: 0, steps: [] }],
    hasMore: false,
  };
  const text = renderTrajectoryLines('s1', result).join('\n');
  assert.match(text, /\(no steps\)/);
});
