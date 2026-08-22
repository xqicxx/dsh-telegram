import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  DEFAULT_CONFIG,
  assertBrowsable,
  getConfigPath,
  isChatAllowed,
  normalizeConfig,
  overlayConfig,
  patchFromPath,
  readConfig,
  resolveInboundMode,
  writeConfig,
} from '../dist/config.js';

test('DEFAULT_CONFIG is immutable and cloneable', () => {
  const a = normalizeConfig(undefined);
  const b = normalizeConfig(null);
  assert.deepEqual(a, DEFAULT_CONFIG);
  assert.deepEqual(b, DEFAULT_CONFIG);
  a.security.allowedChatIds.push(123);
  b.outbound.maxRetries = 0;
  assert.deepEqual(DEFAULT_CONFIG.security.allowedChatIds, []);
  assert.equal(DEFAULT_CONFIG.outbound.maxRetries, 3);
});

test('normalizeConfig merges partial config over defaults', () => {
  const config = normalizeConfig({
    security: { allowedChatIds: [1, 2] },
    watch: { autoStart: true },
    inbound: {
      defaultMode: 'queue-only',
      rules: [{ chatId: 9, pattern: 'urgent', mode: 'auto-handle' }],
    },
    outbound: { disableNotification: true },
    mode: { name: 'headless' },
    interactive: { userQuestions: 'web' },
  });
  assert.deepEqual(config.security.allowedChatIds, [1, 2]);
  assert.equal(config.watch.autoStart, true);
  assert.equal(config.inbound.defaultMode, 'queue-only');
  assert.deepEqual(config.inbound.rules, [{ chatId: 9, pattern: 'urgent', mode: 'auto-handle' }]);
  assert.equal(config.outbound.disableNotification, true);
  assert.equal(config.outbound.parseMode, 'HTML');
  assert.equal(config.outbound.sendRatePerSecond, 20);
  assert.equal(config.mode.name, 'headless');
  assert.equal(config.interactive.userQuestions, 'web');
  assert.equal(normalizeConfig(undefined).interactive.userQuestions, 'telegram', 'telegram-first is the default so web profiles remain answerable');
});

test('normalizeConfig rejects invalid fields with a path', () => {
  const cases = [
    ['string root', 'nope', /\$/],
    ['non-integer chat id', { security: { allowedChatIds: ['x'] } }, /allowedChatIds\[0\]/],
    ['bad default mode', { inbound: { defaultMode: 'nope' } }, /inbound\.defaultMode/],
    ['bad rule mode', { inbound: { rules: [{ mode: 'nope' }] } }, /rules\[0\]\.mode/],
    ['empty pattern', { inbound: { rules: [{ mode: 'muted', pattern: '' }] } }, /pattern/],
    ['rate too high', { outbound: { sendRatePerSecond: 31 } }, /sendRatePerSecond/],
    ['retries negative', { outbound: { maxRetries: -1 } }, /maxRetries/],
    ['length too short', { outbound: { maxMessageLength: 100 } }, /maxMessageLength/],
    ['unsupported parse mode', { outbound: { parseMode: 'Markdown' } }, /parseMode/],
  ];
  for (const [name, raw, expected] of cases) {
    assert.throws(() => normalizeConfig(raw), ConfigError, name);
    try {
      normalizeConfig(raw);
    } catch (error) {
      assert.match(error.message, expected, name);
    }
  }
});

test('resolveInboundMode applies rules in order with case-insensitive pattern', () => {
  const config = normalizeConfig({
    inbound: {
      defaultMode: 'muted',
      rules: [
        { chatId: 5, pattern: 'urgent', mode: 'auto-handle' },
        { chatId: 5, mode: 'queue-only' },
      ],
    },
  });
  assert.equal(resolveInboundMode(config, 5, 'URGENT: fix it'), 'auto-handle');
  assert.equal(resolveInboundMode(config, 5, 'hello'), 'queue-only');
  assert.equal(resolveInboundMode(config, 6, 'hello'), 'muted');
  assert.equal(resolveInboundMode(config, 6, 'urgent'), 'muted');
});

test('isChatAllowed enforces empty whitelist = deny all', () => {
  const empty = normalizeConfig(undefined);
  const allowed = normalizeConfig({ security: { allowedChatIds: [42] } });
  assert.equal(isChatAllowed(empty, 42), false);
  assert.equal(isChatAllowed(allowed, 42), true);
  assert.equal(isChatAllowed(allowed, 43), false);
});

test('readConfig returns defaults for a missing file and round-trips writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-telegram-config-'));
  try {
    assert.deepEqual(readConfig(dir), DEFAULT_CONFIG);
    const config = normalizeConfig({
      security: { allowedChatIds: [7] },
      inbound: { defaultMode: 'queue-only' },
    });
    const file = writeConfig(dir, config);
    assert.ok(file.endsWith(join('.pi', 'telegram.json')));
    assert.deepEqual(readConfig(dir), config);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.inbound.defaultMode, 'queue-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig reports broken JSON as ConfigError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-telegram-config-'));
  try {
    const file = writeConfig(dir, normalizeConfig(undefined));
    writeFileSync(file, '{ not json', 'utf8');
    assert.throws(() => readConfig(dir), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlayConfig touches only the patched sections and validates values', () => {
  const base = normalizeConfig({ security: { allowedChatIds: [1] }, outbound: { sendRatePerSecond: 5 } });
  const { config, changed } = overlayConfig(base, { watch: { autoStart: true } });
  assert.deepEqual(changed, ['watch']);
  assert.equal(config.watch.autoStart, true);
  assert.deepEqual(config.security.allowedChatIds, [1]);
  assert.equal(config.outbound.sendRatePerSecond, 5);
  assert.throws(() => overlayConfig(base, { outbound: { sendRatePerSecond: 999 } }), ConfigError);
});

test('overlayConfig ignores empty, null, and unknown-only payloads', () => {
  const base = normalizeConfig(undefined);
  assert.equal(overlayConfig(base, undefined).changed.length, 0);
  assert.equal(overlayConfig(base, null).changed.length, 0);
  assert.equal(overlayConfig(base, { somethingElse: 1 }).changed.length, 0);
});

test('getConfigPath and patchFromPath walk and build dot paths', () => {
  const config = normalizeConfig({ outbound: { sendRatePerSecond: 7 } });
  assert.equal(getConfigPath(config, 'outbound.sendRatePerSecond'), 7);
  assert.equal(getConfigPath(config, 'nope'), undefined);
  assert.deepEqual(patchFromPath('outbound.sendRatePerSecond', 9), { outbound: { sendRatePerSecond: 9 } });
  assert.deepEqual(patchFromPath('', 1), {});
});

test('overlayConfig applies the reasoning section', () => {
  const { config, changed } = overlayConfig(normalizeConfig(undefined), { reasoning: { effort: 'high' } });
  assert.ok(changed.includes('reasoning'));
  assert.equal(config.reasoning.effort, 'high');
});

test('normalizeConfig rejects unknown reasoning efforts', () => {
  assert.throws(() => normalizeConfig({ reasoning: { effort: 'ultra' } }));
  const ok = normalizeConfig({ reasoning: { effort: 'max' } });
  assert.equal(ok.reasoning.effort, 'max');
});

test('normalizeConfig validates interactive.userQuestions ownership', () => {
  assert.throws(() => normalizeConfig({ interactive: { userQuestions: 'carrier-pigeon' } }), /interactive\.userQuestions/);
  assert.equal(normalizeConfig({ interactive: { userQuestions: 'auto' } }).interactive.userQuestions, 'auto');
});

test('normalizeConfig validates and dedupes interactive.allowByTool (#27)', () => {
  assert.deepEqual(normalizeConfig(undefined).interactive.allowByTool, []);
  assert.deepEqual(
    normalizeConfig({ interactive: { allowByTool: [' bash ', 'read', 'bash'] } }).interactive.allowByTool,
    ['bash', 'read'],
  );
  assert.throws(() => normalizeConfig({ interactive: { allowByTool: 'bash' } }), /interactive\.allowByTool/);
  assert.throws(() => normalizeConfig({ interactive: { allowByTool: ['bash', ''] } }), /interactive\.allowByTool\[1\]/);
});

test('overlayConfig applies the interactive section live', () => {
  const { config, changed } = overlayConfig(normalizeConfig(undefined), { interactive: { userQuestions: 'web' } });
  assert.ok(changed.includes('interactive'));
  assert.equal(config.interactive.userQuestions, 'web');
  assert.deepEqual(config.interactive.allowByTool, [], 'partial interactive overlay keeps the allow list');
  const forever = overlayConfig(normalizeConfig(undefined), { interactive: { allowByTool: ['bash'] } });
  assert.ok(forever.changed.includes('interactive'));
  assert.deepEqual(forever.config.interactive.allowByTool, ['bash']);
});

test('notify switches default on and validate/hot-apply (#18)', () => {
  const defaults = normalizeConfig(undefined);
  assert.deepEqual(defaults.notify, { onComplete: true, onLongTask: true });
  const quiet = normalizeConfig({ notify: { onComplete: false } });
  assert.equal(quiet.notify.onComplete, false);
  assert.equal(quiet.notify.onLongTask, true, 'partial notify config keeps the other switch');
  assert.throws(() => normalizeConfig({ notify: { onComplete: 'yes' } }), /notify\.onComplete/);
  const live = overlayConfig(normalizeConfig(undefined), { notify: { onLongTask: false } });
  assert.ok(live.changed.includes('notify'));
  assert.equal(live.config.notify.onLongTask, false);
  assert.equal(live.config.notify.onComplete, true);
});

test('normalizeConfig validates and overlays the compact section (#8)', () => {
  const config = normalizeConfig({ compact: { threshold: 0.85, policy: 'auto', cooldownMs: 120000 } });
  assert.equal(config.compact.threshold, 0.85);
  assert.equal(config.compact.policy, 'auto');
  assert.equal(config.compact.cooldownMs, 120000);
  assert.throws(() => normalizeConfig({ compact: { threshold: 1 } }), /compact\.threshold/);
  assert.throws(() => normalizeConfig({ compact: { policy: 'sometimes' } }), /compact\.policy/);
  assert.throws(() => normalizeConfig({ compact: { cooldownMs: -1 } }), /compact\.cooldownMs/);
  const live = overlayConfig(normalizeConfig(undefined), { compact: { policy: 'never' } });
  assert.ok(live.changed.includes('compact'));
  assert.equal(live.config.compact.policy, 'never');
  assert.equal(live.config.compact.threshold, 0.8, 'partial overlay keeps the rest of the section');
});

test('normalizeConfig validates the media transcription section (#9)', () => {
  const config = normalizeConfig({ media: { transcribe: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'whisper-1' } } });
  assert.equal(config.media.transcribe.baseUrl, 'https://x/v1');
  assert.equal(config.media.transcribe.apiKey, 'k');
  assert.throws(() => normalizeConfig({ media: { transcribe: 'nope' } }), /media\.transcribe/);
  const live = overlayConfig(normalizeConfig(undefined), { media: { transcribe: { model: 'whisper-2' } } });
  assert.ok(live.changed.includes('media'));
  assert.equal(live.config.media.transcribe.model, 'whisper-2');
});

test('overlayConfig overlays plain-object values per sub-key so sibling leaves survive', () => {
  const base = normalizeConfig({ media: { transcribe: { baseUrl: 'https://x/v1', model: 'whisper-large' } } });
  const { config, changed } = overlayConfig(base, { media: { transcribe: { apiKey: 'sk-x' } } });
  assert.deepEqual(changed, ['media']);
  assert.deepEqual(
    config.media.transcribe,
    { baseUrl: 'https://x/v1', model: 'whisper-large', apiKey: 'sk-x' },
    'patching one transcribe leaf must not wipe the configured siblings',
  );
  assert.equal(base.media.transcribe.apiKey, undefined, 'overlayConfig must not mutate the input config');
});

test('overlayConfig skips unknown keys and reports no change for unknown-only patches', () => {
  const base = normalizeConfig(undefined);
  const typo = overlayConfig(base, { outbound: { typoKey: 1 } });
  assert.deepEqual(typo.changed, [], 'unknown-only patches are not reported as applied');
  assert.equal('typoKey' in typo.config.outbound, false, 'unknown keys are never written as undefined');
  assert.deepEqual(typo.config.outbound, base.outbound);
  const mixed = overlayConfig(base, { watch: { autoStart: true, nope: 1 } });
  assert.deepEqual(mixed.changed, ['watch'], 'a known key alongside unknown ones still applies');
  assert.equal(mixed.config.watch.autoStart, true);
  assert.equal('nope' in mixed.config.watch, false);
});

test('overlayConfig keeps flat-key overlay semantics unchanged', () => {
  const base = normalizeConfig({ outbound: { sendRatePerSecond: 5, maxRetries: 2 } });
  const { config, changed } = overlayConfig(base, { outbound: { maxRetries: 7 } });
  assert.deepEqual(changed, ['outbound']);
  assert.equal(config.outbound.maxRetries, 7);
  assert.equal(config.outbound.sendRatePerSecond, 5, 'unpatched flat siblings stay untouched');
  const arrays = overlayConfig(base, { security: { allowedChatIds: [3] } });
  assert.deepEqual(arrays.changed, ['security']);
  assert.deepEqual(arrays.config.security.allowedChatIds, [3], 'array values still replace wholesale');
});

// ---------------------------------------------------------------------------
// B-7r: optional security.browseRoots whitelist for the browse seams
// ---------------------------------------------------------------------------

test('security.browseRoots defaults to absent and validates as a string array (B-7r)', () => {
  const defaults = normalizeConfig(undefined);
  assert.equal('browseRoots' in defaults.security, false, 'default config stays unconstrained (behavior unchanged)');
  const configured = normalizeConfig({ security: { browseRoots: [' /srv/projects ', '/tmp/work'] } });
  assert.deepEqual(configured.security.browseRoots, ['/srv/projects', '/tmp/work']);
  assert.throws(() => normalizeConfig({ security: { browseRoots: '/srv' } }), ConfigError);
  assert.throws(() => normalizeConfig({ security: { browseRoots: ['/srv', ''] } }), ConfigError);
  assert.equal(getConfigPath(configured, 'security.browseRoots.0'), '/srv/projects');
});

test('overlayConfig hot-applies security.browseRoots without clobbering siblings (B-7r)', () => {
  const base = normalizeConfig({ security: { allowedChatIds: [1] } });
  const { config, changed } = overlayConfig(base, { security: { browseRoots: ['/srv'] } });
  assert.ok(changed.includes('security'));
  assert.deepEqual(config.security.browseRoots, ['/srv']);
  assert.deepEqual(config.security.allowedChatIds, [1], 'a partial security overlay keeps sibling keys');
});

test('assertBrowsable enforces a resolve-prefix whitelist only when configured (B-7r)', () => {
  // Unconfigured (undefined or empty): no-op — the default behavior.
  assertBrowsable('/anywhere/at/all', undefined);
  assert.doesNotThrow(() => assertBrowsable('/anywhere/at/all', []));
  // Inside a root and the root itself: allowed.
  assert.doesNotThrow(() => assertBrowsable('/srv/projects/app', ['/srv/projects']));
  assert.doesNotThrow(() => assertBrowsable('/srv/projects', ['/srv/projects']));
  // Outside a root: rejected with a readable message.
  assert.throws(() => assertBrowsable('/srv/private', ['/srv/projects']), /browseRoots/);
  // A sibling that merely shares the string prefix must not slip through.
  assert.throws(() => assertBrowsable('/srv/projects-evil', ['/srv/projects']), /browseRoots/);
  // The filesystem root whitelists everything absolute.
  assert.doesNotThrow(() => assertBrowsable('/anything', ['/']));
  // Relative paths resolve against cwd first (cwd is not under /srv/projects here).
  assert.throws(() => assertBrowsable('relative/escape', ['/srv/projects']), /browseRoots/);
});
