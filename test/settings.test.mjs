import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceSettings, mutateSettings, updateSettings, describeSettings, parseJsonWithRevision } from '../dist/harness/adapters/settings.js';

function ctxWith(service) {
  return { get: (key) => (key === 'settings' ? service : undefined) };
}

test('replaceSettings forwards the whole section and returns the refreshed view', async () => {
  const calls = [];
  const service = {
    writable: true,
    documentPath: '/tmp/settings.json',
    describe: () => [{ ns: 'llm', value: { provider: 'new' }, applies: 'live', revision: 3 }],
    replace: async (ns, section, expectedRevision) => {
      calls.push({ ns, section, expectedRevision });
    },
    update: async () => {},
    mutate: async () => {},
  };
  const res = await replaceSettings(ctxWith(service), 'llm', { provider: 'new' }, 2);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ ns: 'llm', section: { provider: 'new' }, expectedRevision: 2 }]);
  assert.equal(res.view?.revision, 3);
});

test('mutateSettings forwards the operation list', async () => {
  const calls = [];
  const service = {
    describe: () => [{ ns: 'llm', value: {}, applies: 'live', revision: 1 }],
    replace: async () => {},
    update: async () => {},
    mutate: async (ns, ops, expectedRevision) => {
      calls.push({ ns, ops, expectedRevision });
    },
  };
  const ops = [{ op: 'set', path: ['a'], value: 1 }, { op: 'unset', path: ['b'] }];
  const res = await mutateSettings(ctxWith(service), 'llm', ops);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ ns: 'llm', ops, expectedRevision: undefined }]);
});

test('replace/mutate degrade without the settings service', async () => {
  assert.equal((await replaceSettings(ctxWith(undefined), 'llm', {})).ok, false);
  assert.equal((await mutateSettings(ctxWith(undefined), 'llm', [])).ok, false);
  assert.equal(describeSettings(ctxWith(undefined)).writable, false);
});

test('describeSettings carries the serialized schema envelope', () => {
  const schema = { type: 'object', properties: { provider: { type: 'string' } } };
  const ctx = ctxWith({
    writable: true,
    describe: () => [{ ns: 'llm', schema, value: {}, applies: 'live', revision: 1 }],
  });
  const description = describeSettings(ctx);
  assert.deepEqual(description.namespaces[0].schema, schema);
  assert.equal(description.hasDocument, false);
});


test('parseJsonWithRevision keeps JSON string whitespace intact and parses once (A-2)', () => {
  assert.deepEqual(parseJsonWithRevision('{"a": 1}'), { json: '{"a": 1}', value: { a: 1 } });
  assert.deepEqual(parseJsonWithRevision('{"a": "x  y"} 7'), { json: '{"a": "x  y"}', value: { a: 'x  y' }, revision: 7 });
  assert.deepEqual(parseJsonWithRevision('[1, 2] 3'), { json: '[1, 2]', value: [1, 2], revision: 3 });
  assert.equal(parseJsonWithRevision('not json'), undefined);
});

test('updateSettings rejects scalar/array patches but still forwards objects (RG-5)', async () => {
  const calls = [];
  const service = {
    describe: () => [{ ns: 'llm', value: {}, applies: 'live', revision: 1 }],
    replace: async () => {},
    mutate: async () => {},
    update: async (ns, patch, expectedRevision) => {
      calls.push({ ns, patch, expectedRevision });
    },
  };
  const ctx = ctxWith(service);
  const scalar = await updateSettings(ctx, 'llm', 456);
  assert.equal(scalar.ok, false);
  assert.match(scalar.text, /JSON object/);
  const array = await updateSettings(ctx, 'llm', [1, 2]);
  assert.equal(array.ok, false);
  assert.match(array.text, /JSON object/);
  const nully = await updateSettings(ctx, 'llm', null);
  assert.equal(nully.ok, false);
  assert.deepEqual(calls, [], 'rejected patches never reach the settings service');
  const good = await updateSettings(ctx, 'llm', { provider: 'x' }, 5);
  assert.equal(good.ok, true);
  assert.deepEqual(calls, [{ ns: 'llm', patch: { provider: 'x' }, expectedRevision: 5 }]);
});
