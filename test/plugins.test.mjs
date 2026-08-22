import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPlugins, persistPluginPatch, patchFilePathFor } from '../dist/harness/adapters/plugins.js';

function withFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-telegram-plugins-'));
  const file = join(dir, 'cordis.patch.yml');
  try {
    if (content !== undefined) writeFileSync(file, content);
    return fn(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('patchFilePathFor joins the profile patch under the dsh home', () => {
  assert.equal(patchFilePathFor('web', '/home/u'), '/home/u/profiles/web/cordis.patch.yml');
  assert.equal(patchFilePathFor(undefined, '/home/u'), undefined);
});

test('persistPluginPatch seeds an empty [] patch into a block-style entry', () => {
  withFile('# profile patch\n[]\n', (dir, file) => {
    const res = persistPluginPatch('plugin-a', true, file);
    assert.equal(res.ok, true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /# profile patch/);
    assert.match(text, /- id: "plugin-a"/);
    assert.match(text, /disabled: true/);
  });
});

test('persistPluginPatch inserts disabled under an existing quoted id and preserves config', () => {
  const source = [
    '# profile',
    '- id: "plugin-a"',
    '  config:',
    '    provider: opencode-go',
    '- id: plugin-b',
    '  disabled: false',
    '  config:',
    '    models:',
    '      - id: deepseek-v4-pro',
    '',
  ].join('\n');
  withFile(source, (dir, file) => {
    const res = persistPluginPatch('plugin-a', true, file);
    assert.equal(res.ok, true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /- id: "plugin-a"\n  disabled: true\n  config:\n    provider: opencode-go\n- id: plugin-b/);
    assert.match(text, /- id: deepseek-v4-pro/);
  });
});

test('persistPluginPatch updates an existing unquoted disabled value in place', () => {
  const source = ['- id: plugin-b', '  disabled: false', '  config:', '    x: 1', ''].join('\n');
  withFile(source, (dir, file) => {
    const res = persistPluginPatch('plugin-b', true, file);
    assert.equal(res.ok, true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /- id: plugin-b\n  disabled: true\n  config:\n    x: 1/);
    assert.equal(/disabled: false/.test(text), false);
  });
});

test('persistPluginPatch appends a new entry to a block-style list', () => {
  const source = ['# header', '- id: alpha', '  disabled: false', ''].join('\n');
  withFile(source, (dir, file) => {
    const res = persistPluginPatch('beta', true, file);
    assert.equal(res.ok, true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /- id: "beta"/);
    assert.match(text, /disabled: true/);
    assert.match(text, /- id: alpha/);
  });
});

test('persistPluginPatch refuses flow-style arrays with guidance', () => {
  withFile('[{id: alpha, disabled: true}]\n', (dir, file) => {
    const res = persistPluginPatch('beta', true, file);
    assert.equal(res.ok, false);
    assert.match(res.text, /flow-style/);
    assert.equal(readFileSync(file, 'utf8'), '[{id: alpha, disabled: true}]\n');
  });
});

test('persistPluginPatch fails cleanly when the patch file is missing', () => {
  withFile(undefined, (dir, file) => {
    const res = persistPluginPatch('alpha', true, file);
    assert.equal(res.ok, false);
    assert.match(res.text, /missing/);
  });
});

test('listPlugins mirrors the web pluginInventory projection', () => {
  const entries = [
    { id: 'a', disabled: false, options: { name: 'A' }, fiber: { state: 2 } },
    { id: 'b', disabled: true, options: { name: 'B' }, fiber: undefined },
    { id: 'c', disabled: false, options: { name: 'C', group: true }, fiber: { state: 0 } },
    { id: 'd', disabled: false, options: { name: undefined }, fiber: { state: 4 } },
  ];
  const ctx = { get: (name) => (name === 'loader' ? { entries: () => entries, update: async () => {} } : undefined) };
  const list = listPlugins(ctx);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { entryId: 'a', moduleName: 'A', enabled: true, fiberPhase: 'active' });
  assert.deepEqual(list[1], { entryId: 'b', moduleName: 'B', enabled: false, fiberPhase: null });
  assert.deepEqual(list[2], { entryId: 'd', moduleName: undefined, enabled: true, fiberPhase: null });
});

test('the durable toggle path resolves its home through dshHome (R3-4/RG-3)', () => {
  const prevHome = process.env.DSH_HOME;
  const prevArgv = process.argv;
  // A profile name that cannot exist under either home, so both probes fail
  // at the missing-file check and never write anywhere.
  const argv = ['node', 'dsh', '--profile=r34-home-probe'];
  try {
    // A configured DSH_HOME drives the patch path: the clean fail names the
    // exact path, proving dshHome() is the single source.
    process.argv = argv;
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home-plugins-r34');
    const missing = persistPluginPatch('plugin-x', true);
    assert.equal(missing.ok, false);
    assert.match(missing.text, /missing/);
    assert.ok(
      missing.text.includes(['dsh-home-plugins-r34', 'profiles', 'r34-home-probe', 'cordis.patch.yml'].join('/')),
      `expected the DSH_HOME-based path, got: ${missing.text}`,
    );
    // An empty DSH_HOME falls back to ~/.dsh instead of a cwd-relative path.
    process.env.DSH_HOME = '';
    const fallback = persistPluginPatch('plugin-x', true);
    assert.equal(fallback.ok, false);
    assert.match(fallback.text, /missing/);
    assert.ok(
      fallback.text.includes(join(homedir(), '.dsh', 'profiles', 'r34-home-probe', 'cordis.patch.yml')),
      `empty DSH_HOME must fall back to ~/.dsh, got: ${fallback.text}`,
    );
    assert.equal(
      fallback.text.startsWith(`patch file missing: ${process.cwd()}`),
      false,
      'the path must never be cwd-relative',
    );
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    process.argv = prevArgv;
  }
});
