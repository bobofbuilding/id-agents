'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  JsonFileRoleApplicationRepository,
  createRoleApplicationServer,
} = require('..');

async function startHarness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bittrees-role-application-'));
  const repository = new JsonFileRoleApplicationRepository(path.join(directory, 'role-applications.json'));
  const server = createRoleApplicationServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function request(harness, user, pathname, options = {}) {
  const headers = {
    'x-local-user-id': user.id,
    'x-local-user-name': user.name,
    ...(user.isReviewer ? { 'x-local-reviewer': 'true' } : {}),
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

test('agent submits, sees own application, and reviewer approves it', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const applicant = { id: 'agent-alpha', name: 'Alpha Agent' };
  const otherApplicant = { id: 'agent-beta', name: 'Beta Agent' };
  const reviewer = { id: 'reviewer-one', name: 'Reviewer One', isReviewer: true };
  const payload = {
    roleId: 'frontend-contributor',
    // These fields must not be able to override the authenticated session.
    applicantId: 'spoofed-applicant',
    applicantName: 'Spoofed Name',
    motivation: 'I can improve the portal accessibility and review flow.',
    experience: 'Maintained several JavaScript services.',
    evidenceUrls: ['https://example.test/portfolio'],
  };

  const submitted = await request(harness, applicant, '/api/role-applications', {
    method: 'POST',
    body: payload,
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.application.applicantId, applicant.id);
  assert.equal(submitted.body.application.applicantName, applicant.name);
  assert.equal(submitted.body.application.status, 'submitted');
  assert.equal(submitted.body.application.version, 1);
  const id = submitted.body.application.id;

  const mine = await request(harness, applicant, '/api/role-applications/mine');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.applications.length, 1);
  assert.equal(mine.body.applications[0].id, id);

  const otherMine = await request(harness, otherApplicant, '/api/role-applications/mine');
  assert.equal(otherMine.status, 200);
  assert.deepEqual(otherMine.body.applications, []);

  const duplicate = await request(harness, applicant, '/api/role-applications', {
    method: 'POST',
    body: { roleId: 'frontend-contributor', motivation: 'A second active application.' },
  });
  assert.equal(duplicate.status, 409);

  const unauthorizedList = await request(harness, applicant, '/api/role-applications');
  assert.equal(unauthorizedList.status, 403);

  const hiddenDetail = await request(harness, otherApplicant, `/api/role-applications/${id}`);
  assert.equal(hiddenDetail.status, 404);

  const review = await request(harness, reviewer, `/api/role-applications/${id}/review`, {
    method: 'PATCH',
    body: {
      decision: 'approved',
      expectedVersion: 1,
      reviewNote: 'Strong fit for the frontend lane.',
    },
  });
  assert.equal(review.status, 200);
  assert.equal(review.body.application.status, 'approved');
  assert.equal(review.body.application.reviewedBy, reviewer.id);
  assert.equal(review.body.application.version, 2);

  const reviewList = await request(harness, reviewer, '/api/role-applications?status=approved&roleId=frontend-contributor');
  assert.equal(reviewList.status, 200);
  assert.equal(reviewList.body.applications.length, 1);

  const staleReview = await request(harness, reviewer, `/api/role-applications/${id}/review`, {
    method: 'PATCH',
    body: { decision: 'rejected', expectedVersion: 1 },
  });
  assert.equal(staleReview.status, 409);

  const terminalReview = await request(harness, reviewer, `/api/role-applications/${id}/review`, {
    method: 'PATCH',
    body: { decision: 'rejected', expectedVersion: 2 },
  });
  assert.equal(terminalReview.status, 409);
});

test('rejected applications may be resubmitted and persistence survives repository recreation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bittrees-role-application-persist-'));
  const dataFile = path.join(directory, 'role-applications.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const repository = new JsonFileRoleApplicationRepository(dataFile);
  const first = await repository.create({
    roleId: 'ops-contributor',
    applicantId: 'agent-gamma',
    applicantName: 'Gamma Agent',
    motivation: 'I can maintain operational runbooks.',
  });
  const rejected = await repository.review(first.id, {
    decision: 'rejected',
    expectedVersion: 1,
    reviewedBy: 'reviewer-one',
    reviewNote: 'Please add a deployment example.',
  });
  assert.equal(rejected.status, 'rejected');

  const second = await repository.create({
    roleId: 'ops-contributor',
    applicantId: 'agent-gamma',
    applicantName: 'Gamma Agent',
    motivation: 'I added the requested deployment example.',
  });
  assert.notEqual(second.id, first.id);

  const reloaded = new JsonFileRoleApplicationRepository(dataFile);
  const all = await reloaded.list({ applicantId: 'agent-gamma' });
  assert.equal(all.length, 2);
  assert.equal(all[0].status, 'submitted');
  assert.equal(all[1].status, 'rejected');
});

test('authentication, validation, and reviewer filters are enforced', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const noSession = await fetch(`${harness.baseUrl}/api/role-applications/mine`);
  assert.equal(noSession.status, 401);

  const applicant = { id: 'agent-delta', name: 'Delta Agent' };
  const invalid = await request(harness, applicant, '/api/role-applications', {
    method: 'POST',
    body: { roleId: 'ops-contributor', motivation: '', evidenceUrls: ['javascript:alert(1)'] },
  });
  assert.equal(invalid.status, 400);

  const submitted = await request(harness, applicant, '/api/role-applications', {
    method: 'POST',
    body: { roleId: 'ops-contributor', motivation: 'I can help with operations.' },
  });
  assert.equal(submitted.status, 201);

  const reviewer = { id: 'reviewer-two', name: 'Reviewer Two', isReviewer: true };
  const invalidFilter = await request(harness, reviewer, '/api/role-applications?status=unknown');
  assert.equal(invalidFilter.status, 400);

  const filtered = await request(harness, reviewer, '/api/role-applications?status=submitted&roleId=ops-contributor');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.applications.length, 1);
});
