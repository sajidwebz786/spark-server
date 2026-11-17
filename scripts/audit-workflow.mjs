// Explicit demo reset and end-to-end API audit. Never run against a non-local DB.
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
const server = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(server, '.env'), quiet: true });
if (!['localhost', '127.0.0.1'].includes(process.env.DB_HOST) || process.env.MAIL_MODE !== 'outbox' || process.env.DATABASE_URL) throw new Error('This demo reset requires a local DB and outbox-only mail.');
const db = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await db.connect();
const base = process.env.AUDIT_API_URL || 'http://localhost:5001/api';
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };
async function call(route, method = 'GET', body, token, expected = 200) {
  const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}
const admin = (await call('/auth/login', 'POST', { email: process.env.AUDIT_ADMIN_EMAIL || 'hrms@sparkinfosol.com', password: process.env.AUDIT_ADMIN_PASSWORD || 'Admin@2026' })).user;
const a = (route, method = 'GET', body, status = 200) => call(route, method, body, admin.portalToken, status);
const quote = x => '"' + x.replaceAll('"', '""') + '"';
async function insert(table, values) {
  const entries = Object.entries({ ...values, createdAt: new Date(), updatedAt: new Date() });
  return (await db.query(`INSERT INTO ${quote(table)} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, entries.map(([, value]) => value))).rows[0];
}

try {
  // Backup every table before changing profiles; never overwrite the original backup.
  const backup = {};
  for (const { tablename } of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) backup[tablename] = (await db.query(`SELECT * FROM ${quote(tablename)}`)).rows;
  const backupDir = path.resolve(server, '../.local-backups'); fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, `before-demo-reset-${Date.now()}.json`), JSON.stringify(backup));
  await db.query('BEGIN');
  for (const table of ['LearningAttempts', 'LearningPaths', 'ExtensionRequests', 'WorkTasks', 'SprintBoards', 'ProjectAssignments', 'Certifications', 'Notifications', 'FinalSettlements', 'GeneratedLetters', 'PerformanceReviews', 'AttendanceRecords', 'RelievingCases', 'ExpenseClaims', 'LeaveRequests', 'PayrollRuns', 'BgvChecks', 'OnboardingTasks']) await db.query(`DELETE FROM ${quote(table)}`);
  await db.query('DELETE FROM "Users" WHERE role=\'Employee\'');
  await db.query('DELETE FROM "Employees"');
  for (const table of ['OfferLetterFiles', 'CandidateOnboardingDocuments', 'CandidateTests', 'Interviews', 'Offers', 'Candidates']) if (backup[table]) await db.query(`DELETE FROM ${quote(table)}`);
  await db.query("DELETE FROM \"MasterRecords\" WHERE module='employee-request' OR code LIKE 'AUDIT-%'");
  await db.query('COMMIT');
  const initial = await a('/bootstrap');
  const jobs = initial.jds.filter(j => j.status === 'Open');
  assert.ok(jobs.length && initial.panelists.length, 'Need at least one open job and panelist');
  const names = ['Asha Rao (Demo)', 'Nikhil Dev (Demo)', 'Meera Candidate (Demo)', 'Arjun Candidate (Demo)'];
  const candidates = [];
  for (let i = 0; i < 4; i++) candidates.push(await a('/candidates', 'POST', { name: names[i], email: `spark.demo.${i + 1}@example.test`, skills: i % 2 ? ['Node.js', 'PostgreSQL', 'Testing'] : ['React', 'JavaScript', 'REST APIs'], experienceYears: 3, roleApplied: jobs[i % jobs.length].title, JobDescriptionId: jobs[i % jobs.length].id, status: 'Applied', source: 'Workflow demo', notes: 'Synthetic demonstration profile; do not email externally.' }, 201));
  check('Candidate enrolment persists profiles', candidates.length === 4);
  check('Skill-based open-job matching returns scores', (await a(`/candidates/${candidates[0].id}/matches`)).every(j => Number.isFinite(j.score)));
  const proof = new PDFDocument({ margin: 50 });
  const chunks = []; proof.on('data', x => chunks.push(x));
  const pdfDone = new Promise(resolve => proof.on('end', resolve));
  proof.fontSize(22).text('SPARK DEMO DOCUMENT').moveDown().fontSize(12).text('Synthetic evidence used to test upload and HR review. This is not an identity document or employment record.'); proof.end(); await pdfDone;
  const pdfBytes = Buffer.concat(chunks);
  const employees = [];
  for (const [i, candidate] of candidates.slice(0, 2).entries()) {
    await a(`/candidates/${candidate.id}/action`, 'POST', { action: 'documents' });
    const mail = (await a('/bootstrap')).mails.find(m => m.to === candidate.email && m.kind?.includes('Document Upload Requested'));
    check(`Candidate ${i + 1} upload request addressed correctly and queued`, mail?.status === 'Queued');
    const token = mail.html.match(/candidate-onboarding\/([^"<\s]+)/)[1];
    const page = await call(`/candidate-onboarding/${token}`);
    await a('/offers', 'POST', { CandidateId: candidate.id }, 400);
    check(`Candidate ${i + 1} offer blocked before document review`, true);
    for (const doc of page.documents) {
      const form = new FormData(); form.append('document', new Blob([pdfBytes], { type: 'application/pdf' }), 'demo-proof.pdf');
      await call(`/candidate-onboarding/${token}/documents/${doc.id}`, 'POST', form);
      await a(`/candidate-documents/${doc.id}/review`, 'PATCH', { status: 'Verified', remarks: 'Synthetic document reviewed for demo' });
    }
    const offer = await a('/offers', 'POST', { CandidateId: candidate.id, designation: i ? 'Backend Engineer' : 'Frontend Engineer', department: 'Engineering', annualCtc: i ? 960000 : 1200000, joiningDate: '2026-09-18', candidateAddress: 'Demo address, Hyderabad', workLocation: 'Hyderabad', reportingManager: 'Demo Engineering Manager', hrName: 'Spark HR', noticePeriod: '30 days', probationPeriod: '3 months', sendMail: false }, 201);
    check(`Offer ${i + 1} uses Spark Info Solutions`, offer.html.includes('Spark Info Solutions'));
    const dispatched = await a(`/offers/${offer.id}/dispatch`, 'POST', {});
    check(`Offer ${i + 1} reflects queued delivery honestly`, dispatched.offer.status === 'Queued');
    await call(`/candidate-onboarding/${token}/accept-offer`, 'POST', { confirm: true });
    check(`Acceptance ${i + 1} does not create employee`, (await a('/bootstrap')).employees.length === i);
    await a(`/candidates/${candidate.id}/induct`, 'POST', { inductedAt: '2026-09-18' }, 400);
    await a(`/candidates/${candidate.id}/onboarding-session`, 'POST', { scheduledAt: '2026-09-18T04:00:00Z', meetingLink: 'http://localhost:5173/demo-session' });
    const employee = await a(`/candidates/${candidate.id}/induct`, 'POST', { email: candidate.email, inductedAt: '2026-09-18', sessionCompleted: true }, 201);
    const repeated = await a(`/candidates/${candidate.id}/induct`, 'POST', { email: candidate.email, inductedAt: '2026-09-18', sessionCompleted: true });
    check(`Induction ${i + 1} is repeat-safe`, repeated.id === employee.id);
    employees.push(employee);
  }
  // Keep two unconverted candidates, with interview and document workflows populated.
  await a('/interviews', 'POST', { CandidateId: candidates[2].id, PanelistId: initial.panelists[0].id, stage: 'Technical interview (demo)', scheduledAt: '2026-10-09T05:30:00Z', meetingLink: 'http://localhost:5173/demo-session' }, 201);
  await a(`/candidates/${candidates[3].id}/action`, 'POST', { action: 'documents' });
  await a(`/candidates/${candidates[2].id}/action`, 'POST', { action: 'test' });
  const active = await a('/bootstrap');
  check('Exactly two active candidates and two inducted employees', active.candidates.length === 2 && active.employees.length === 2);
  check('Converted candidates are absent from candidate lists', active.candidates.every(c => !employees.some(e => e.CandidateId === c.id)));
  check('Interview invitation is addressed to candidate', active.mails.some(m => m.to === candidates[2].email && m.kind === 'Candidate Interview'));
  check('No payroll before induction month', (await a('/payroll/run', 'POST', { month: '2026-08' }, 201)).length === 0);
  const payroll = await a('/payroll/run', 'POST', { month: '2026-09' }, 201);
  check('First payroll prorates from induction date', payroll.every(p => p.paidDays === 13 && p.daysInMonth === 30));
  const secondPayroll = await a('/payroll/run', 'POST', { month: '2026-09' }, 201);
  check('Repeating payroll creates no duplicates', payroll.map(p => p.id).join() === secondPayroll.map(p => p.id).join());
  for (const run of payroll) await a(`/payroll/${run.id}/credit`, 'PATCH', {});
  for (const [index, employee] of employees.entries()) {
    const user = (await call('/auth/login', 'POST', employee.credentials)).user;
    const ecall = (route, method, body, status) => call(route, method, body, user.portalToken, status || 200);
    const own = await ecall('/bootstrap');
    check(`Employee ${index + 1} sees own profile only`, own.employees.length === 1 && own.employees[0].id === employee.id && own.candidates.length === 0);
    check(`Employee ${index + 1} receives skill training`, own.employees[0].LearningPaths.length === 3 && own.employees[0].LearningPaths[0].curriculum.skills.length > 0);
    check(`Employee ${index + 1} does not receive answer keys`, own.employees[0].LearningPaths.every(p => p.curriculum.tests.every(t => t.questions.every(q => !('correctAnswer' in q)))));
    await ecall('/payroll/run', 'POST', { month: '2026-10' }, 403);
    await ecall('/attendance/clock-in', 'POST', { EmployeeId: employees[1 - index].id }, 403);
    check(`Employee ${index + 1} cannot run payroll or mark another employee attendance`, true);
    const leave = await ecall('/leaves', 'POST', { EmployeeId: employee.id, type: 'Annual Leave', startDate: '2026-10-12', endDate: '2026-10-13', reason: 'Demo personal leave' }, 201);
    await a(`/leaves/${leave.id}`, 'PATCH', { status: 'Approved' }); await a(`/leaves/${leave.id}`, 'PATCH', { status: 'Approved' });
    check(`Leave approval ${index + 1} deducts balance once`, (await ecall('/bootstrap')).employees[0].leaveBalance === 22);
    await ecall('/attendance/clock-in', 'POST', { EmployeeId: employee.id, date: '2026-10-05', location: 'Demo office', workMode: 'Office' }, 201);
    await ecall('/attendance/clock-out', 'POST', { EmployeeId: employee.id, date: '2026-10-05', location: 'Demo office' });
    await ecall('/employee-requests', 'POST', { subject: 'Demo equipment request', description: 'Please arrange development equipment.', category: 'Equipment' }, 201);
    await ecall('/mail/send', 'POST', { to: 'HR_ADMIN', subject: `Demo HR query from ${employee.name}`, body: 'Please confirm my onboarding and training schedule.' }, 201);
    const path = own.employees[0].LearningPaths.find(p => p.level === 'Beginner');
    const test = path.curriculum.tests[0];
    await ecall(`/learning-paths/${path.id}/assessments/${test.id}/complete`, 'POST', { score: 100 }, 400);
    const result = await ecall(`/learning-paths/${path.id}/assessments/${test.id}/complete`, 'POST', { answers: Object.fromEntries(test.questions.map(q => [q.id, 2])) });
    check(`Weekly assessment ${index + 1} scored from answers`, result.curriculum.tests[0].score === 100);
    for (const [route, name] of [[`/learning-paths/${path.id}/pdf/0`, `training-${index + 1}.pdf`], [`/payroll/${payroll[index].id}/pdf`, `payslip-${index + 1}.pdf`]]) {
      const response = await fetch(base + route, { headers: { Authorization: `Bearer ${user.portalToken}` } });
      const bytes = Buffer.from(await response.arrayBuffer());
      check(`${name} is a downloadable PDF`, response.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-');
      fs.mkdirSync(pathModule(server, '../.local-logs'), { recursive: true }); fs.writeFileSync(pathModule(server, '../.local-logs', name), bytes);
    }
    await insert('ProjectAssignments', { EmployeeId: employee.id, title: 'Demo onboarding mini project', description: 'Apply assigned skills to a small HR workflow.', deliverables: 'Implementation and test notes', evaluationCriteria: 'Correctness and documentation', durationDays: 15, status: 'Assigned' });
    const sprint = await insert('SprintBoards', { EmployeeId: employee.id, name: 'Demo induction sprint', sprintGoal: 'Complete onboarding and first training week', status: 'Active', startDate: '2026-10-05', endDate: '2026-10-16' });
    await insert('WorkTasks', { EmployeeId: employee.id, SprintBoardId: sprint.id, title: 'Read induction guide', description: 'Review company policies and first skill reference.', status: 'To Do', priority: 'Medium', storyPoints: 2, timesheetHours: 0 });
    await insert('Certifications', { EmployeeId: employee.id, title: 'Skill development completion', level: 'Beginner', status: 'In Progress' });
    await insert('PerformanceReviews', { EmployeeId: employee.id, cycle: '2026 Q4', selfRating: 3, managerRating: 3, finalRating: 3, status: 'Manager Review', recommendation: 'Demo review: continue skill development' });
    await insert('ExpenseClaims', { EmployeeId: employee.id, category: 'Travel', amount: 450, spentOn: '2026-10-05', description: 'Demo onboarding travel claim', status: 'Submitted' });
    await insert('BgvChecks', { EmployeeId: employee.id, type: 'Demo background check', vendor: 'Demo HR review', status: 'Clear', remarks: 'Synthetic demonstration only', completedAt: new Date() });
    await insert('GeneratedLetters', { EmployeeId: employee.id, type: 'Induction confirmation', status: 'Generated', html: `<h1>Spark Info Solutions</h1><p>${employee.name} was inducted on ${employee.inductedAt}. Demonstration record.</p>` });
  }
  for (const module of ['designation', 'company-policy', 'holiday', 'attendance-shift', 'salary-structures', 'deductions', 'benefits', 'payroll-reports', 'billing', 'leave-policy', 'attendance-settings']) await insert('MasterRecords', { module, name: `Demo ${module.replaceAll('-', ' ')}`, code: `AUDIT-${module}`, category: 'Demo', owner: 'Spark HR', status: 'Active', description: 'Editable demonstration configuration. Review before production use.', amount: module === 'billing' ? 1000 : 0, effectiveDate: '2026-10-01', metadata: {} });
  check('Anonymous users cannot read admin bootstrap', (await fetch(base + '/bootstrap')).status === 401);
  const report = { checkedAt: new Date().toISOString(), passed: checks, profiles: { candidates: candidates.slice(2).map(c => ({ id: c.id, name: c.name })), employees: employees.map(e => ({ id: e.id, name: e.name, ...e.credentials })) }, limitations: ['Email delivery is outbox-only.', 'Meeting links are local demo pages, not live conferences.', 'No AI provider configured; reference library is labeled.', 'No connected browser for visual/button coverage.'] };
  fs.mkdirSync(pathModule(server, '../.local-logs'), { recursive: true });
  fs.writeFileSync(pathModule(server, '../.local-logs/workflow-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: checks.length, employees: report.profiles.employees }));
} finally { await db.end(); }
function pathModule(...args) { return path.resolve(...args); }
