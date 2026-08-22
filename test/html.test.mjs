import test from 'node:test';
import assert from 'node:assert/strict';
import { bold, code, escapeHtml, link, plain, splitText, truncate } from '../dist/telegram/html.js';

test('escapeHtml neutralizes markup characters', () => {
  assert.equal(escapeHtml('a<b>&"c"\'d\''), 'a&lt;b&gt;&amp;&quot;c&quot;&#x27;d&#x27;');
  assert.equal(escapeHtml('plain'), 'plain');
  assert.equal(escapeHtml(''), '');
});

test('bold/code/link/plain escape their inputs', () => {
  assert.equal(bold('<x>'), '<b>&lt;x&gt;</b>');
  assert.equal(code('a&b'), '<code>a&amp;b</code>');
  assert.equal(link('x"y', 'https://e.test/?a=1&b=2'), '<a href="https://e.test/?a=1&amp;b=2">x&quot;y</a>');
  assert.equal(plain('<i>'), '&lt;i&gt;');
});

test('truncate keeps within max and appends an ellipsis', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w\u2026');
  assert.equal(truncate('hello world', 8).length, 8);
});

function checkSplit(text, max) {
  const parts = splitText(text, max);
  assert.equal(parts.join(''), text, 'splitting must preserve the payload');
  for (const part of parts) assert.ok(part.length <= max, `part ${JSON.stringify(part)} exceeds ${max}`);
  return parts;
}

test('splitText prefers newline boundaries', () => {
  assert.deepEqual(checkSplit('abc', 3), ['abc']);
  assert.deepEqual(checkSplit('one\ntwo', 4), ['one\n', 'two']);
  assert.deepEqual(checkSplit('line one\nline two\nline three', 9), ['line one\n', 'line two\n', 'line thre', 'e']);
});

test('splitText falls back to spaces and finally hard-splits', () => {
  assert.deepEqual(checkSplit('hello world', 6), ['hello', ' world']);
  assert.deepEqual(checkSplit('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  checkSplit('x'.repeat(5000), 4096);
});

function assertBalanced(part) {
  const voidTags = new Set(['br', 'hr', 'img']);
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?(\/?)>/g;
  for (const match of part.matchAll(tag)) {
    const name = match[2].toLowerCase();
    if (match[3] === '/' || voidTags.has(name)) continue;
    if (match[1] === '/') {
      assert.equal(stack.at(-1), name, `stray closer </${name}> in ${JSON.stringify(part)}`);
      stack.pop();
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags <${stack.join('>, <')}> in ${JSON.stringify(part)}`);
}

function checkHtmlSplit(text, max) {
  const parts = splitText(text, max);
  for (const part of parts) {
    assert.ok(part.length <= max, `part ${JSON.stringify(part)} exceeds ${max}`);
    assertBalanced(part);
  }
  return parts;
}

test('splitText never cuts inside an HTML tag', () => {
  const parts = checkHtmlSplit(`<b>${'x'.repeat(4090)}</b>x`, 4096);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal((part.match(/<b/g) ?? []).length, (part.match(/<\/b>/g) ?? []).length);
    assert.ok(!/<b[^>]*$/.test(part), 'part must not end inside a tag');
  }
});

test('splitText rebalances a tag that spans the cut', () => {
  const parts = checkHtmlSplit(`<b>${'x'.repeat(5000)}</b>`, 4096);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('<b>'), 'styling must open at the start');
  assert.ok(parts[0].endsWith('</b>'), 'first part must close the tag it opened');
  assert.ok(parts[1].startsWith('<b>'), 'second part must reopen the tag');
  assert.ok(parts[1].endsWith('</b>'), 'second part must keep the original closer');
});

test('splitText keeps HTML entities intact', () => {
  assert.deepEqual(splitText('a&amp;bX', 6), ['a&amp;', 'bX']);
});

test('splitText rebalances nested tags without leaking stray closers', () => {
  const text = `<i><b>${'y'.repeat(9000)}</b></i>`;
  const parts = checkHtmlSplit(text, 4096);
  assert.ok(parts.length >= 3);
  assert.ok(parts[0].startsWith('<i><b>'));
  assert.ok(parts[0].endsWith('</b></i>'));
  for (const part of parts.slice(1, -1)) {
    assert.ok(part.startsWith('<i><b>') || part.startsWith('<b>') || part.startsWith('<i>'));
    assert.ok(part.endsWith('</b></i>') || part.endsWith('</b>') || part.endsWith('</i>'));
  }
  assert.ok(parts.at(-1).endsWith('</b></i>'));
});

test('splitText reopens tags with their raw attributes intact (RE-2)', () => {
  // A bare `<a>` without href is rejected by Telegram with a non-retryable
  // 400, so a cut landing inside link text must replay the FULL open tag.
  const href = '<a href="https://example.test/very/long/path?utm=split">';
  const parts = checkHtmlSplit(`${href}${'x'.repeat(5000)}</a>`, 4096);
  assert.ok(parts.length > 1);
  assert.ok(parts[1].startsWith(href), `reopened anchor must keep its href, got: ${JSON.stringify(parts[1].slice(0, 60))}`);

  // Attributes on styling tags survive too, and nesting keeps closing in order.
  const styled = checkHtmlSplit(`<b class="x"><a href="https://e.test/a">${'y'.repeat(5000)}</a></b>`, 4096);
  assert.ok(styled[1].startsWith('<b class="x"><a href="https://e.test/a">'));
  assert.ok(styled.at(-1).endsWith('</a></b>'));
});
