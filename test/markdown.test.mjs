import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownTablePreBlock, markdownToHtml } from '../dist/telegram/markdown.js';
import { splitText } from '../dist/telegram/html.js';

test('markdownToHtml renders the issue example without literal markers', () => {
  const input = [
    '# Heading',
    '',
    '**bold** and *italic*',
    '',
    '- item one',
    '- item two',
    '',
    '`inline code`',
    '',
    '[documentation](https://example.com)',
  ].join('\n');
  const html = markdownToHtml(input);
  assert.equal(html.includes('**'), false, 'bold markers are gone');
  assert.equal(html.includes('`inline'), false, 'code markers are gone');
  assert.match(html, /<b>Heading<\/b>/);
  assert.match(html, /<b>bold<\/b> and <i>italic<\/i>/);
  assert.match(html, /• item one/);
  assert.match(html, /• item two/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com">documentation<\/a>/);
});

test('markdownToHtml supports strong/emphasis/strike/blockquote and nested inline', () => {
  assert.equal(markdownToHtml('__bold__'), '<b>bold</b>');
  assert.equal(markdownToHtml('*italic*'), '<i>italic</i>');
  assert.equal(markdownToHtml('_italic_'), '<i>italic</i>');
  assert.equal(markdownToHtml('~~strike~~'), '<s>strike</s>');
  assert.equal(markdownToHtml('**bold *nested***'), '<b>bold <i>nested</i></b>');
  assert.equal(markdownToHtml('> quoted **bold**'), '<blockquote>quoted <b>bold</b></blockquote>');
});

test('markdownToHtml leaves word-internal underscores and arithmetic untouched', () => {
  assert.equal(markdownToHtml('snake_case_name'), 'snake_case_name');
  assert.equal(markdownToHtml('2*3*4'), '2*3*4');
});

test('markdownToHtml HTML-escapes plain text and code bodies', () => {
  assert.equal(markdownToHtml('a <b> & "quoted"'), 'a &lt;b&gt; &amp; &quot;quoted&quot;');
  assert.equal(markdownToHtml('`<x> & y`'), '<code>&lt;x&gt; &amp; y</code>');
  assert.equal(markdownToHtml('&amp;'), '&amp;amp;');
});

test('malformed model markup degrades to readable text instead of raw tags', () => {
  const malformed = '**bold without close and <script>alert(1)</script>';
  const html = markdownToHtml(malformed);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('fenced code blocks become escaped <pre><code> blocks (#30)', () => {
  const html = markdownToHtml('```js\nconst x = "<tag>";\n```');
  assert.equal(html, '<pre><code class="language-js">const x = &quot;&lt;tag&gt;&quot;;</code></pre>');
});

test('fenced code without a language still wraps in <pre><code> (#30)', () => {
  assert.equal(markdownToHtml('```\nplain\n```'), '<pre><code>plain</code></pre>');
});

test('fence language info is sanitized instead of leaking markup (#30)', () => {
  const html = markdownToHtml('```"><b onclick="x">\nboom\n```');
  assert.equal(html, '<pre><code>boom</code></pre>');
});

test('GFM tables become aligned monospace blocks instead of raw pipes (#19, #30)', () => {
  const html = markdownToHtml([
    '| 消息 | 文件 | 大小 |',
    '|---|---|---|',
    '| 📌 ① | `a.xlsx` | 26,666B |',
    '| 📌 ② | `b.csv` | 39,723B |',
    '',
    '**三个文件已发送**',
  ].join('\n'));
  assert.match(html, /<pre><code>\| 消息\s+\| 文件\s+\| 大小\s+\|/);
  assert.match(html, /\| 📌 ① \| `a\.xlsx`\s+\| 26,666B\s+\|/);
  assert.equal(html.includes('|---|'), false, 'separator syntax is replaced');
  assert.match(html, /<\/code><\/pre>/, 'table block closes both code and pre');
  assert.match(html, /<b>三个文件已发送<\/b>/, 'markdown around the table still renders');
  assert.equal(html.split('<pre>').length, 2, 'exactly one monospace table block');
});

test('a lone separator-looking line stays prose instead of half a table', () => {
  assert.equal(markdownToHtml('not a table\n|---|'), 'not a table\n|---|');
});

test('markdownTablePreBlock finds a table anywhere and renders it as aligned monospace (#26)', () => {
  const input = [
    'leading prose',
    '| col1 | col2 |',
    '|------|------|',
    '| a    | b    |',
    '| long | text |',
    'trailing prose',
  ].join('\n');
  const html = markdownTablePreBlock(input);
  assert.ok(html, 'a table block was detected');
  assert.match(html, /^<pre><code>/);
  assert.match(html, /\| col1\s+\| col2\s+\|/);
  assert.match(html, /\| a\s+\| b\s+\|/);
  assert.match(html, /\| long \| text \|/);
  assert.match(html, /<\/code><\/pre>$/);
  assert.equal(html.includes('------'), false, 'separator syntax is replaced by an aligned rule');
});

test('markdownTablePreBlock leaves table-less text alone', () => {
  assert.equal(markdownTablePreBlock('| not a header |\nand prose'), undefined);
});

test('unordered and ordered lists keep their structure', () => {
  const html = markdownToHtml('- one\n- two\n\n1. first\n2. second');
  assert.match(html, /• one\n• two/);
  assert.match(html, /1\. first\n2\. second/);
});

test('unsafe link targets are left as literal text', () => {
  assert.equal(markdownToHtml('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
});

function assertBalanced(part) {
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?(\/?)>/g;
  for (const match of part.matchAll(tag)) {
    const name = match[2].toLowerCase();
    if (match[3] === '/') continue;
    if (match[1] === '/') {
      assert.equal(stack.at(-1), name, `stray closer </${name}> in ${JSON.stringify(part)}`);
      stack.pop();
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags <${stack.join('>, <')}> in ${JSON.stringify(part)}`);
}

test('long normalized replies split into balanced Telegram HTML chunks', () => {
  const markdown = `**${'x'.repeat(5000)}** and *${'y'.repeat(5000)}*`;
  const parts = splitText(markdownToHtml(markdown), 4096);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 4096);
    assertBalanced(part);
  }
});

test('deeply nested inline markup degrades instead of overflowing the stack', () => {
  const depth = 80;
  const nested = `${'**'.repeat(depth)}deep${'**'.repeat(depth)}`;
  const html = markdownToHtml(nested);
  assert.ok(html.includes('deep'), 'deep content survives as escaped text once the depth guard trips');
  assert.doesNotThrow(() => markdownToHtml(`${'['.repeat(500)}deep`));
});
