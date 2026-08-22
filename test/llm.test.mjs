import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog, discoverModels } from '../dist/harness/adapters/llm.js';

function makeCtx({ providers = ['served', 'broken'], resolveError = false } = {}) {
  return {
    get: (name) => (name === 'llm' ? {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('catalog down');
        return [{ id: `${provider}-model`, name: `${provider} model` }];
      },
      resolveModelInfo: async () => {
        if (resolveError) throw new Error('info down');
        return { reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } };
      },
      discoverModels: async () => [],
    } : undefined),
  };
}

test('modelCatalog projects groups, failures, and web routable', async () => {
  const catalog = await modelCatalog(makeCtx(), { provider: 'served', model: 'served-model' });
  assert.equal(catalog.routable, true);
  assert.deepEqual(catalog.groups.map((group) => group.id), ['served'], 'failed providers go to failures, not groups');
  assert.deepEqual(catalog.failures, [{ provider: 'broken', message: 'catalog down' }]);
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, 'medium');

  const unroutable = await modelCatalog(makeCtx(), { provider: 'missing', model: 'x' });
  assert.equal(unroutable.routable, false);
});

test('modelCatalog degrades without llm and tolerates info failures', async () => {
  assert.deepEqual(await modelCatalog({ get: () => undefined }, { provider: 'p' }), {
    groups: [], failures: [], current: { provider: 'p' }, routable: true,
  });
  const catalog = await modelCatalog(makeCtx({ resolveError: true }), { provider: 'served' });
  assert.equal(catalog.groups[0].models[0].reasoning, undefined);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('modelCatalog fans providers and models out concurrently, preserving order', async () => {
  let providersInFlight = 0;
  let maxProvidersInFlight = 0;
  let modelsInFlight = 0;
  let maxModelsInFlight = 0;
  const ctx = {
    get: (name) => (name === 'llm' ? {
      listProviders: () => ['z-slow', 'a-fast', 'm-mid'].map((id) => ({ id, name: id })),
      listModels: async (provider) => {
        providersInFlight += 1;
        maxProvidersInFlight = Math.max(maxProvidersInFlight, providersInFlight);
        try {
          await sleep(provider === 'a-fast' ? 10 : provider === 'm-mid' ? 30 : 50);
        } finally {
          providersInFlight -= 1;
        }
        return provider === 'z-slow'
          ? [{ id: `${provider}-1`, name: 'one' }, { id: `${provider}-2`, name: 'two' }]
          : [{ id: `${provider}-1`, name: 'one' }];
      },
      resolveModelInfo: async () => {
        modelsInFlight += 1;
        maxModelsInFlight = Math.max(maxModelsInFlight, modelsInFlight);
        try {
          await sleep(50);
        } finally {
          modelsInFlight -= 1;
        }
        return {};
      },
      discoverModels: async () => [],
    } : undefined),
  };
  const catalog = await modelCatalog(ctx);
  assert.deepEqual(catalog.groups.map((group) => group.id), ['z-slow', 'a-fast', 'm-mid'], 'group order follows listProviders, not completion order');
  assert.deepEqual(catalog.groups[0].models.map((model) => model.id), ['z-slow-1', 'z-slow-2'], 'model order within a group is preserved');
  assert.equal(catalog.failures.length, 0);
  assert.ok(maxProvidersInFlight >= 2, `providers build concurrently (max in flight ${maxProvidersInFlight})`);
  assert.ok(maxModelsInFlight >= 2, `models within a group resolve concurrently (max in flight ${maxModelsInFlight})`);
});

test('discoverModels keeps the apiKey out of the result and degrades without llm', async () => {
  const res = await discoverModels({ get: () => undefined }, 'ns', {});
  assert.equal(res.ok, false);
  assert.match(res.text, /unavailable/);
  const ok = await discoverModels(makeCtx(), 'ns', { provider: 'p', baseURL: 'https://x' });
  assert.equal(ok.ok, true);
});
