import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProfile, listProfiles, modeSummary, dshHome } from '../dist/harness/adapters/mode.js';

test('detectProfile parses --profile and --profile= forms', () => {
  assert.equal(detectProfile(['node', 'dsh', '--profile', 'web']), 'web');
  assert.equal(detectProfile(['node', 'dsh', '--profile=headless']), 'headless');
  assert.equal(detectProfile(['node', 'dsh']), undefined);
});

test('listProfiles skips node_modules and hidden directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-mode-'));
  const profiles = join(base, 'profiles');
  for (const name of ['web', 'headless', 'node_modules', '.hidden', 'normal']) {
    mkdirSync(join(profiles, name), { recursive: true });
  }
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    assert.deepEqual(listProfiles(), ['headless', 'normal', 'web']);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('listProfiles tolerates a missing profiles dir', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-mode-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    assert.deepEqual(listProfiles(), []);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('modeSummary reports the detected profile', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-mode-'));
  const profiles = join(base, 'profiles');
  mkdirSync(join(profiles, 'web'), { recursive: true });
  mkdirSync(join(profiles, 'node_modules'), { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const s = modeSummary();
    assert.equal(s.profile, undefined); // no --profile in this runner
    assert.deepEqual(s.profiles, ['web']);
    assert.equal(s.profile === undefined, s.note.includes('profile unknown'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('dshHome respects DSH_HOME', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/dsh-home-test';
  try {
    assert.equal(dshHome(), '/tmp/dsh-home-test');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('dshHome treats an empty DSH_HOME like unset so paths stay absolute (RG-3)', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '';
  try {
    assert.equal(dshHome(), join(homedir(), '.dsh'));
    assert.equal(dshHome().startsWith(process.cwd()), false, 'never cwd-relative');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});
