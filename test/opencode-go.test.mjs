import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureOpencodeGoResponsesRoute,
  normalizeOpencodeGoModel,
  opencodeGoModelUsesResponses,
  OPENCODE_GO_RESPONSES_ROUTE,
} from '../dist/harness/adapters/opencodeGo.js';

test('normalizeOpencodeGoModel repoints only Go Responses-native models', () => {
  assert.deepEqual(normalizeOpencodeGoModel('opencode-go', 'gpt-5.6-luna'), { provider: OPENCODE_GO_RESPONSES_ROUTE, model: 'gpt-5.6-luna' });
  assert.deepEqual(normalizeOpencodeGoModel('opencode-go', 'grok-4.5'), { provider: OPENCODE_GO_RESPONSES_ROUTE, model: 'grok-4.5' });
  assert.deepEqual(normalizeOpencodeGoModel('opencode-go', 'deepseek-v4-flash'), { provider: 'opencode-go', model: 'deepseek-v4-flash' });
  assert.deepEqual(normalizeOpencodeGoModel('opencode', 'gpt-5.6-luna'), { provider: 'opencode', model: 'gpt-5.6-luna' });
  assert.equal(opencodeGoModelUsesResponses('opencode-go', 'gpt-5.6-luna'), true);
  assert.equal(opencodeGoModelUsesResponses('opencode-go', 'deepseek-v4-flash'), false);
});

test('ensureOpencodeGoResponsesRoute adds one additive settings route and is idempotent', async () => {
  const writes = [];
  const llmProviders = ['opencode-go'];
  const ctx = {
    get: (name) => {
      if (name === 'llm') return { listProviders: () => llmProviders.map((id) => ({ id })) };
      if (name === 'settings') return settings;
      return undefined;
    },
  };
  const settings = {
    writable: true,
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 7,
      value: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } },
    }],
    update: async (ns, patch, revision) => {
      writes.push({ ns, patch, revision });
      llmProviders.push(OPENCODE_GO_RESPONSES_ROUTE);
      // The real settings service deep-merges the patch.
      ctx.get('settings').describe = () => [{
        ns: 'llm-pi-ai',
        revision: 8,
        value: {
          providers: {
            'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
            [OPENCODE_GO_RESPONSES_ROUTE]: patch.providers[OPENCODE_GO_RESPONSES_ROUTE],
          },
        },
      }];
    },
  };
  const logs = [];
  assert.equal(await ensureOpencodeGoResponsesRoute(ctx, (message) => logs.push(message)), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision, 7);
  const route = writes[0].patch.providers[OPENCODE_GO_RESPONSES_ROUTE];
  assert.equal(route.api, 'openai-responses');
  assert.equal(route.baseURL, 'https://opencode.ai/zen/go/v1');
  assert.equal(route.cacheRetention, 'none');
  assert.deepEqual(route.models.map((model) => model.id), ['gpt-5.6-luna', 'grok-4.5']);
  assert.equal(await ensureOpencodeGoResponsesRoute(ctx, () => {}), true);
  assert.equal(writes.length, 1, 'an existing route is never rewritten');
});

test('a throwing settings service degrades probing to a no-op and the next probe retries (#3)', async () => {
  let describeThrows = true;
  const providerConfig = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } };
  const llmProviders = ['opencode-go'];
  const writes = [];
  const settings = {
    writable: true,
    describe: () => {
      if (describeThrows) throw new Error('settings store offline');
      return [{ ns: 'llm-pi-ai', revision: 7, value: { providers: providerConfig } }];
    },
    update: async (ns, patch) => {
      writes.push(patch);
      providerConfig[OPENCODE_GO_RESPONSES_ROUTE] = patch.providers[OPENCODE_GO_RESPONSES_ROUTE];
      llmProviders.push(OPENCODE_GO_RESPONSES_ROUTE);
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'llm') return { listProviders: () => llmProviders.map((id) => ({ id })) };
      if (name === 'settings') return settings;
      return undefined;
    },
  };
  const logs = [];
  // The first probe fails cleanly instead of rejecting into a poisoned latch.
  assert.equal(await ensureOpencodeGoResponsesRoute(ctx, (message) => logs.push(message)), false);
  assert.match(logs.at(-1), /settings\.describe failed/);
  // The singleton was released on failure: a repaired settings service lets
  // the very next model-selection attempt retry and succeed.
  describeThrows = false;
  assert.equal(await ensureOpencodeGoResponsesRoute(ctx, (message) => logs.push(message)), true);
  assert.equal(writes.length, 1, 'the retried probe performs the provisioning write');
});
