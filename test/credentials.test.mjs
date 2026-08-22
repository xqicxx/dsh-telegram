import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCredential, describeCredentials, setCredential, unsetCredential } from '../dist/harness/adapters/credentials.js';

function makeCtx() {
  const calls = [];
  const service = {
    calls,
    async describe(ref) {
      calls.push({ op: 'describe', ref });
      return { configured: ref === 'SET', source: ref === 'SET' ? 'file' : undefined, writable: true };
    },
    async set(ref, value) {
      calls.push({ op: 'set', ref, value });
    },
    async unset(ref) {
      calls.push({ op: 'unset', ref });
    },
  };
  return { service, ctx: { get: (name) => (name === 'credentials' ? service : undefined) } };
}

test('describeCredential keeps values out of the view', async () => {
  const { ctx, service } = makeCtx();
  const res = await describeCredential(ctx, 'SET');
  assert.equal(res.ok, true);
  assert.deepEqual(res.view, { ref: 'SET', configured: true, source: 'file', writable: true });
  assert.equal(service.calls.length, 1);
});

test('describeCredentials batches up to 64 refs with dedupe and validation', async () => {
  const { ctx, service } = makeCtx();
  const res = await describeCredentials(ctx, ['SET', 'UNSET', 'SET']);
  assert.equal(res.ok, true);
  assert.equal(res.views.length, 2);
  assert.deepEqual(service.calls.map((call) => call.ref), ['SET', 'UNSET']);
  assert.match(res.text, /SET: configured/);
  assert.match(res.text, /UNSET: not configured/);

  const invalid = await describeCredentials(ctx, ['bad-ref!']);
  assert.equal(invalid.ok, false);
  assert.match(invalid.text, /POSIX/);
  const tooMany = await describeCredentials(ctx, Array.from({ length: 65 }, (_, i) => `REF${i}`));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.text, /64/);
});

test('setCredential rejects empty values and unsetCredential delegates', async () => {
  const { ctx, service } = makeCtx();
  assert.equal((await setCredential(ctx, 'REF', '')).ok, false);
  assert.equal((await setCredential(ctx, 'REF', 'secret')).ok, true);
  assert.equal((await unsetCredential(ctx, 'REF')).ok, true);
  assert.deepEqual(service.calls.slice(0, 2).map((call) => call.op), ['set', 'unset']);
});

test('unsetCredential enforces the same ref shape as set/describe (RG-4)', async () => {
  const { ctx, service } = makeCtx();
  for (const bad of ['FOO-BAR', '9LIVES', 'has space', '']) {
    const res = await unsetCredential(ctx, bad);
    assert.equal(res.ok, false, `ref ${JSON.stringify(bad)} must be rejected`);
    assert.match(res.text, /POSIX/);
  }
  assert.deepEqual(service.calls, [], 'an invalid ref never reaches the credentials service');
  assert.equal((await unsetCredential(ctx, 'VALID_REF')).ok, true);
});
