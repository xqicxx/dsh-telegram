import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePiDir, findWorkspaceRoot, hasWorkspaceRoot, piDir } from '../dist/workspace.js';
import { listWorkspaces, createWorkspace } from '../dist/harness/adapters/workspace.js';

test('findWorkspaceRoot walks up to the nearest .pi ancestor', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ws-'));
  try {
    const root = join(base, 'project');
    mkdirSync(join(root, '.pi'), { recursive: true });
    const deep = join(root, 'src', 'nested', 'leaf');
    mkdirSync(deep, { recursive: true });
    assert.equal(findWorkspaceRoot(deep), root);
    assert.equal(hasWorkspaceRoot(deep), true);
    assert.equal(piDir(root), join(root, '.pi'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('findWorkspaceRoot does not mistake a marker-less sandbox for a workspace root', () => {
  // Anchor in the system temp dir.  Some hosts have genuine .pi markers above
  // temp (or above $HOME), so the portable invariant is: the sandbox itself is
  // never mistaken for a workspace root, even if a genuine ancestor root is
  // eventually found.  Never use $HOME directly: it can be read-only under
  // macOS TCC / sandboxed CI, which fails before the assertion runs.
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ws-'));
  try {
    const found = findWorkspaceRoot(base);
    assert.notEqual(found, base);
    if (found !== undefined) assert.equal(found.startsWith(base), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePiDir creates the marker directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ws-'));
  try {
    ensurePiDir(base);
    assert.equal(existsSync(join(base, '.pi')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('listWorkspaces tolerates registry entries missing optional fields', () => {
  const registry = {
    list: () => [{ id: 'w1', path: '/tmp/w1', title: 'One' }],
    archivedSessionIds: undefined,
  };
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) };
  const listed = listWorkspaces(ctx);
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.items[0].sessionIds, []);
  assert.deepEqual(listed.archivedSessionIds, []);
});

function makeRegistry(calls) {
  return {
    list: () => [],
    get: () => undefined,
    archivedSessionIds: [],
    async create(path, title) {
      calls.push({ path, title });
      return { id: 'w1', path, title: title ?? path, sessionIds: [] };
    },
  };
}

test('createWorkspace enforces browseRoots only when configured (B-7r)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ws-roots-'));
  try {
    const inside = join(base, 'inside');
    mkdirSync(inside);
    const roots = [inside];

    // Unconfigured: behavior unchanged — the registry is called directly.
    const freeCalls = [];
    const free = await createWorkspace({ get: (n) => (n === 'workspaceRegistry' ? makeRegistry(freeCalls) : undefined) }, join(base, 'anywhere'));
    assert.equal(free.ok, true, 'without browseRoots the legacy behavior holds');
    assert.equal(freeCalls.length, 1);

    // Configured: out-of-root paths are rejected before the registry runs.
    const calls = [];
    const ctx = { get: (name) => (name === 'workspaceRegistry' ? makeRegistry(calls) : undefined) };
    const denied = await createWorkspace(ctx, join(base, 'outside'), undefined, roots);
    assert.equal(denied.ok, false);
    assert.match(denied.text, /browseRoots/);
    assert.deepEqual(calls, [], 'the registry is never invoked for an out-of-root path');

    const allowed = await createWorkspace(ctx, inside, 'Inside', roots);
    assert.equal(allowed.ok, true);
    assert.deepEqual(calls, [{ path: inside, title: 'Inside' }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
