import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IdaccManagerClient,
  IdaccManagerError,
} from '../../src/integrations/idacc-manager-client.mjs';
import {
  BrainClient,
  BrainClientError,
  sanitizeBrainTerminalSummary,
} from '../../src/integrations/brain-client.mjs';
import {
  ContributionOutboxWorker,
  InMemoryIntegrationOutboxStore,
  deterministicTaskName,
} from '../../src/contributions/outbox-worker.mjs';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('IDACC client exposes only bounded create/get calls with allowlisted manager body', async () => {
  const calls = [];
  const client = new IdaccManagerClient({
    baseUrl: 'http://manager.test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === 'POST') return jsonResponse(201, { task: { name: 'bittrees-submission-sub-1', uuid: 'uuid-1', status: 'todo' } });
      return jsonResponse(200, { task: { name: 'bittrees-submission-sub-1', uuid: 'uuid-1', status: 'done', updated_at: 123 } });
    },
  });
  const created = await client.createBoundedTask({
    name: 'bittrees-submission-sub-1',
    title: 'Reviewed contribution',
    description: 'private evidence must not be forwarded',
    team: 'other-team',
  });
  const observed = await client.getTask('bittrees-submission-sub-1');
  assert.deepEqual(created, { name: 'bittrees-submission-sub-1', uuid: 'uuid-1', status: 'todo', updatedAt: null });
  assert.deepEqual(observed, { name: 'bittrees-submission-sub-1', uuid: 'uuid-1', status: 'done', updatedAt: 123 });
  assert.deepEqual(calls[0].body, { title: 'Reviewed contribution', name: 'bittrees-submission-sub-1', from: 'portal-submission-bridge' });
  assert.equal(calls[0].init.headers['X-Id-Team'], 'engineering-team');
  assert.equal(calls.some((call) => /claim|done|assign|capabilit|wallet|registry/.test(call.url)), false);
});

test('Brain client posts one sanitized keyed memory and omits raw source ids/private fields', async () => {
  const calls = [];
  const client = new BrainClient({
    baseUrl: 'http://brain.test',
    agentId: 'contribution-writer',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse(200, { ok: true, memoryId: 99 });
    },
  });
  const result = await client.publishTerminalSummary({
    submissionId: 'sub-1',
    reviewOutcome: 'approved',
    managerStatus: 'done',
    title: 'Reviewed packet',
    summary: 'private reviewer reason: do not retain; payout is not part of this workflow',
    artifacts: ['secret.md'],
    evidence: ['memory:3595'],
    citationAliases: ['bittrees-citation/sub-1', 'memory:3595'],
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://brain.test/memory/contribution-writer');
  assert.deepEqual(calls[0].body.tags, ['bittrees', 'contribution', 'terminal']);
  assert.equal(calls[0].body.shared, true);
  assert.match(calls[0].body.key, /^bittrees:submission:sub-1:terminal:v1$/);
  assert.match(calls[0].body.content, /bittrees-citation\/sub-1/);
  assert.doesNotMatch(calls[0].body.content, /memory:3595|private reviewer|payout|secret\.md/);
  assert.equal(calls[0].body.memoryId, undefined);
});

test('outbox timeout reconciles by GET before any retry POST', async () => {
  const store = new InMemoryIntegrationOutboxStore();
  store.enqueue('idacc_task_create', { submissionId: 'sub-123', title: 'Contribution' }, { id: 'create-1' });
  const calls = [];
  let createCount = 0;
  const worker = new ContributionOutboxWorker({
    store,
    managerClient: {
      createBoundedTask: async () => {
        createCount += 1;
        const error = new IdaccManagerError('timeout', { retryable: true });
        throw error;
      },
      getTask: async (name) => {
        calls.push(name);
        return { name, uuid: 'uuid-123', status: 'doing' };
      },
    },
    brainClient: { publishTerminalSummary: async () => ({ ok: true }) },
    clock: () => 1000,
    jitterMs: 0,
  });
  const result = await worker.processOnce();
  assert.equal(result.sent, 1);
  assert.equal(createCount, 1);
  assert.deepEqual(calls, [deterministicTaskName('sub-123')]);
  assert.equal(store.rows()[0].status, 'sent');
});

test('outbox retries a genuinely absent manager task and maps status values', async () => {
  const store = new InMemoryIntegrationOutboxStore();
  store.enqueue('idacc_task_create', { submissionId: 'sub-absent', title: 'Contribution' }, { id: 'create-2' });
  let posts = 0;
  const worker = new ContributionOutboxWorker({
    store,
    managerClient: {
      createBoundedTask: async ({ name }) => { posts += 1; return { name, uuid: 'uuid-2', status: 'done' }; },
      getTask: async () => null,
    },
    brainClient: { publishTerminalSummary: async () => ({ ok: true }) },
    clock: () => 1000,
    jitterMs: 0,
  });
  const result = await worker.processOnce();
  assert.equal(result.sent, 1);
  assert.equal(posts, 1);
  assert.equal(result.results[0].result.status, 'idacc_done');
});

test('Brain failures retry as outbox events without changing manager state', async () => {
  const store = new InMemoryIntegrationOutboxStore();
  store.enqueue('brain_terminal_summary', { submissionId: 'sub-brain', reviewOutcome: 'rejected' }, { id: 'brain-1' });
  let calls = 0;
  const worker = new ContributionOutboxWorker({
    store,
    managerClient: {
      createBoundedTask: async () => { throw new Error('not used'); },
      getTask: async () => { throw new Error('not used'); },
    },
    brainClient: {
      publishTerminalSummary: async () => {
        calls += 1;
        if (calls === 1) throw new BrainClientError('offline', { retryable: true });
        return { ok: true };
      },
    },
    clock: () => 1000,
    maxAttempts: 3,
    jitterMs: 0,
  });
  const first = await worker.processOnce();
  assert.equal(first.retried, 1);
  assert.equal(store.rows()[0].status, 'retry');
  const row = store.rows()[0];
  row.availableAt = 1000;
  const second = await worker.processOnce();
  assert.equal(second.sent, 1);
  assert.equal(store.rows()[0].status, 'sent');
  assert.equal(calls, 2);
});

test('sanitizer rejects missing opaque submission ids', () => {
  assert.throws(() => sanitizeBrainTerminalSummary({ reviewOutcome: 'approved' }), /submission id is required/);
});
