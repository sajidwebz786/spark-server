import test from 'node:test';
import assert from 'node:assert/strict';
import { requireInterviewSelection, requireActiveEmployee, requireAssessmentOrder, nextCode } from './workflow-guards.mjs';
import { canReadMail, attachmentBytes } from './mail-access.mjs';
import { installLifecycle } from './lifecycle.mjs';

const selectedInterview = { decision: 'Selected', scheduledAt: '2026-01-01T09:00:00Z', meetingLink: 'https://meet.example.com/interview' };
test('candidate status alone cannot skip interview selection', () => {
  for (const status of ['Applied', 'Selected', 'Document Upload Requested', 'Offer Accepted']) assert.throws(() => requireInterviewSelection({ status }, []), /interview/);
  assert.doesNotThrow(() => requireInterviewSelection({ status: 'Selected' }, [selectedInterview]));
  for (const status of ['Inducted', 'Rejected', 'Archived']) assert.throws(() => requireInterviewSelection({ status }, [selectedInterview]));
});

test('employee activation requires a permanent ID and actual start date', () => {
  const employee = { id: 1, employeeCode: 'SPARK-0012', status: 'Active', inductedAt: '2026-01-02' };
  assert.doesNotThrow(() => requireActiveEmployee(employee, '2026-01-03'));
  for (const change of [{ employeeCode: '' }, { status: 'Relieved' }, { inductedAt: '2026-01-04' }, { inductedAt: null }]) assert.throws(() => requireActiveEmployee({ ...employee, ...change }, '2026-01-03'));
  assert.equal(nextCode(['SPARK-0001', 'SPARK-0009', 'EMP1234']), 'SPARK-0010');
});

test('weekly assessments cannot skip unfinished prior tests', () => {
  const tests = [{ id: 'one', status: 'Pending' }, { id: 'two', status: 'Pending' }];
  assert.doesNotThrow(() => requireAssessmentOrder(tests, 'one'));
  assert.throws(() => requireAssessmentOrder(tests, 'two'), /previous/);
  tests[0].status = 'Passed';
  assert.doesNotThrow(() => requireAssessmentOrder(tests, 'two'));
});

test('attachment access matches complete email addresses, including display names', () => {
  const mail = { from: 'HR <hr@example.com>', to: 'Anne <anne@example.com>, other@example.com' };
  assert.equal(canReadMail(mail, { role: 'Employee', email: 'ANNE@example.com' }), true);
  assert.equal(canReadMail(mail, { role: 'Employee', email: 'nne@example.com' }), false);
  assert.equal(canReadMail(mail, { role: 'Employee', email: 'stranger@example.com' }), false);
  assert.equal(canReadMail(null, { role: 'HR Admin' }), false);
  assert.equal(attachmentBytes({ content: 'cGRm', encoding: 'base64' }).toString(), 'pdf');
  assert.equal(attachmentBytes({ id: 'provider-only' }), null);
});

function lifecycleFixture({ candidate = {}, offer = null, documents = [], interviews = [] } = {}) {
  const routes = new Map();
  const current = { id: 1, status: 'Selected', ...candidate, update: async () => {} };
  const models = {
    Candidate: { findByPk: async () => current },
    Interview: { findAll: async () => interviews },
    CandidateOnboardingDocument: { findAll: async () => documents },
    Offer: { findByPk: async () => offer, findOne: async () => offer },
    Employee: { findOne: async () => null }
  };
  const sequelize = { models, transaction: async fn => fn({ LOCK: { UPDATE: 'update' } }) };
  const lifecycle = installLifecycle({ app: { post: (route, handler) => routes.set(route, handler), patch() {}, get() {} }, sequelize, Op: {}, asyncRoute: fn => fn, ensureCandidateOnboardingDocuments: async () => documents });
  return { routes, lifecycle };
}

test('offer prerequisite checks reject unreviewed documents', async () => {
  const fixture = lifecycleFixture({ documents: [{ title: 'Identity Proof', status: 'Submitted' }] });
  await assert.rejects(fixture.lifecycle.approvedDocuments(1), /review every/);
  const ready = lifecycleFixture({ documents: [{ title: 'Identity Proof', status: 'Verified' }, { title: 'Signed Offer Letter', status: 'Pending' }] });
  await assert.doesNotReject(ready.lifecycle.approvedDocuments(1));
  await assert.rejects(ready.lifecycle.approvedDocuments(1, true), /review every/);
});

test('offer acceptance API rejects undelivered drafts and queued mail without confirmation', async () => {
  for (const status of ['Draft', 'Dispatch Failed', 'Queued']) {
    const fixture = lifecycleFixture({ offer: { id: 1, CandidateId: 1, status }, interviews: [selectedInterview], documents: [{ title: 'ID', status: 'Verified' }] });
    await assert.rejects(fixture.routes.get('/api/offers/:id/accept')({ params: { id: 1 }, body: {} }, {}), /Dispatch|confirmation/);
  }
});

test('induction API rejects missing acceptance and future onboarding sessions', async () => {
  const missingOffer = lifecycleFixture();
  await assert.rejects(missingOffer.routes.get('/api/candidates/:id/induct')({ params: { id: 1 }, body: {} }, {}), /accept the offer/);
  const future = lifecycleFixture({ candidate: { onboardingAt: '2999-01-01' }, offer: { status: 'Accepted' }, interviews: [selectedInterview] });
  await assert.rejects(future.routes.get('/api/candidates/:id/induct')({ params: { id: 1 }, body: { sessionCompleted: true } }, {}), /scheduled onboarding/);
});
