import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeHost, listDirectory, createDirectory, isDirectory, openPath, pickDirectoryHint, parentOf } from '../dist/harness/adapters/host.js';

test('listDirectory sorts directories before files and returns entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-list-'));
  try {
    mkdirSync(join(root, 'b-dir'));
    mkdirSync(join(root, 'a-dir'));
    writeFileSync(join(root, 'z-file.txt'), 'hello');
    const res = await listDirectory(root);
    assert.equal(res.ok, true);
    assert.deepEqual(res.entries.map((e) => e.name), ['a-dir', 'b-dir', 'z-file.txt']);
    assert.deepEqual(res.entries.map((e) => e.kind), ['directory', 'directory', 'file']);
    assert.match(res.text, /a-dir/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listDirectory fails with a readable error for a missing path', async () => {
  const res = await listDirectory('/definitely/not/here/dsh-telegram');
  assert.equal(res.ok, false);
  assert.ok(res.text.length > 0);
});

test('listDirectory reports totalEntries only when the render cap truncates (RG-1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-cap-'));
  try {
    for (let i = 0; i < 205; i += 1) mkdirSync(join(root, `dir-${String(i).padStart(3, '0')}`));
    const truncated = await listDirectory(root);
    assert.equal(truncated.ok, true);
    assert.equal(truncated.entries.length, 200, 'the render cap still applies');
    assert.equal(truncated.totalEntries, 205, 'the caller sees the true count');
    const untruncated = await listDirectory(join(root, 'dir-000'));
    assert.equal(untruncated.ok, true);
    assert.equal('totalEntries' in untruncated, false, 'listings within the cap stay byte-compatible');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host browse seams honor browseRoots only when configured (B-7r)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-roots-'));
  try {
    const inside = join(root, 'inside');
    mkdirSync(inside);
    const roots = [inside];

    // Unconfigured: everything behaves exactly as before.
    assert.equal((await listDirectory(root)).ok, true);
    assert.equal(openPath(join(root, 'secret')).ok, true);

    // Outside the configured roots: fail without side effects.
    const outside = await listDirectory(root, roots);
    assert.equal(outside.ok, false);
    assert.match(outside.text, /browseRoots/);
    assert.equal((await createDirectory(join(root, 'outside-new'), roots)).ok, false);
    assert.equal(existsSync(join(root, 'outside-new')), false, 'nothing is created outside the roots');
    assert.equal(openPath(join(root, 'secret'), roots).ok, false);

    // Inside the configured roots: all three seams succeed.
    assert.equal((await listDirectory(inside, roots)).ok, true);
    assert.equal((await createDirectory(join(inside, 'new-dir'), roots)).ok, true);
    assert.equal(await isDirectory(join(inside, 'new-dir')), true);
    assert.match(openPath(join(inside, 'file.txt'), roots).text, /file\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDirectory creates a directory and rejects duplicates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-mkdir-'));
  try {
    const parent = join(root, 'nested');
    mkdirSync(parent);
    const target = join(parent, 'new');
    const res = await createDirectory(target);
    assert.equal(res.ok, true);
    assert.equal(await isDirectory(target), true);
    const duplicate = await createDirectory(target);
    assert.equal(duplicate.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host path helpers resolve, degrade, and walk up', async () => {
  assert.match(openPath('x/y').text, /x\/y/);
  assert.match(pickDirectoryHint('/tmp/current').text, /\/tmp\/current/);
  assert.equal(parentOf('/a/b/c'), '/a/b');
  assert.equal(parentOf('/'), '/');
  assert.equal(await isDirectory('/definitely/not/here/dsh-telegram'), false);
});


test('describeHost reports the bridge version instead of a fake host version', () => {
  const view = describeHost({ agents: { list: () => [] }, get: () => undefined }, '/tmp', '0.3.0');
  assert.equal(view.version, '0.3.0');
  assert.equal(view.cwd, '/tmp');
  assert.equal(view.attachedSessions, 0);
});

test('the exported plugin version matches package.json', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { version } = await import('../dist/index.js');
  assert.equal(version, pkg.version);
});

test('describeHost prefers agentDefaultModel like web host.describe', () => {
  const ctx = {
    agents: { list: () => [{ options: { provider: 'live-provider', model: 'live-model' } }] },
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) } : undefined),
  };
  const view = describeHost(ctx, '/tmp', '0.3.0');
  assert.equal(view.provider, 'default-provider');
  assert.equal(view.model, 'default-model');
  const fallback = describeHost({ agents: ctx.agents, get: () => undefined }, '/tmp');
  assert.equal(fallback.provider, 'live-provider');
});
