import PDFDocument from 'pdfkit';
import { requireInterviewSelection, requireActiveEmployee } from './workflow-guards.mjs';

export function payrollPeriod(employee, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('Select a valid payroll month (YYYY-MM).');
  const [year, number] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, number - 1, 1));
  const end = new Date(Date.UTC(year, number, 0));
  const inducted = new Date(`${employee.inductedAt || employee.joiningDate}T00:00:00Z`);
  if (!Number.isFinite(inducted.getTime())) throw new Error('Employee induction date is missing.');
  const paidDays = Math.max(0, Math.round((end - new Date(Math.max(start, inducted))) / 86400000) + 1);
  return { paidDays, daysInMonth: end.getUTCDate(), grossPay: Math.round(Number(employee.salaryAnnual || 0) / 12 * paidDays / end.getUTCDate()) };
}

export function leaveDays(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) throw new Error('Valid start and end dates are required.');
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > 366) throw new Error('Leave end date must follow the start date, within one year.');
  return days;
}

export function installLifecycle(c) {
  const { app, sequelize, Op, asyncRoute, queueMail, writeAudit, generateLearningLifecycle, provisionPortalUser, nextEmployeeCode, candidateOnboardingUrl, ensureCandidateOnboardingDocuments, scoreCandidate, escapeHtml, upload, logoPath } = c;
  const { Candidate, Employee, Offer, CandidateOnboardingDocument: Document, OnboardingTask, PayrollRun, ExpenseClaim, LeaveRequest, User, LearningPath, JobDescription, Notification } = sequelize.models;
  const fail = (message, status = 400) => Object.assign(new Error(message), { statusCode: status });
  const requireCandidate = async id => { const x = await Candidate.findByPk(id); if (!x) throw fail('Candidate not found.', 404); return x; };
  const selectedCandidate = async id => {
    const candidate = await requireCandidate(id);
    const interviews = await sequelize.models.Interview.findAll({ where: { CandidateId: id } });
    requireInterviewSelection(candidate, interviews);
    return candidate;
  };
  const approvedDocuments = async (id, signed = false) => {
    if (!signed) await ensureCandidateOnboardingDocuments(await requireCandidate(id));
    const docs = await Document.findAll({ where: { CandidateId: id } });
    const required = docs.filter(x => signed || x.title !== 'Signed Offer Letter');
    if (!required.length || required.some(x => !['Verified', 'Not Applicable'].includes(x.status))) throw fail('HR must review every required document before continuing.');
    return docs;
  };
  c.approvedDocuments = approvedDocuments;
  c.selectedCandidate = selectedCandidate;

  app.post('/api/generated-letters', asyncRoute(async (req, res) => {
    const employee = await Employee.findByPk(req.body.EmployeeId);
    if (!employee) throw fail('Employee not found.', 404);
    if (!['Appointment Letter', 'Employment Confirmation'].includes(req.body.type)) throw fail('Choose a supported letter type.');
    const html = `<article><h1>Spark Info Solutions</h1><h2>${escapeHtml(req.body.type)}</h2><p>This confirms that ${escapeHtml(employee.name)} (${escapeHtml(employee.employeeCode)}) is employed as ${escapeHtml(employee.designation)} in ${escapeHtml(employee.department)}, effective ${escapeHtml(employee.inductedAt || employee.joiningDate)}.</p><p>Human Resources<br/>Spark Info Solutions</p></article>`;
    res.status(201).json(await sequelize.models.GeneratedLetter.create({ EmployeeId: employee.id, type: req.body.type, html, status: 'Generated' }));
  }));

  app.post('/api/employee-requests', asyncRoute(async (req, res) => {
    const employee = await Employee.findByPk(req.user.role === 'Employee' ? req.user.EmployeeId : req.body.EmployeeId);
    if (!employee || !String(req.body.subject || '').trim() || !String(req.body.description || '').trim()) throw fail('Employee, subject and description are required.');
    const record = await sequelize.models.MasterRecord.create({ module: 'employee-request', name: req.body.subject, category: req.body.category || 'HR Support', owner: employee.email, status: 'Open', description: req.body.description, metadata: { EmployeeId: employee.id, response: '' } });
    res.status(201).json(record);
  }));
  app.patch('/api/employee-requests/:id', asyncRoute(async (req, res) => {
    const record = await sequelize.models.MasterRecord.findByPk(req.params.id);
    if (!record || record.module !== 'employee-request') throw fail('Request not found.', 404);
    if (!['Open', 'In Progress', 'Resolved', 'Declined'].includes(req.body.status)) throw fail('Invalid request status.');
    res.json(await record.update({ status: req.body.status, metadata: { ...record.metadata, response: String(req.body.response || '') } }));
  }));

  app.get('/api/candidates/:id/matches', asyncRoute(async (req, res) => {
    const candidate = await requireCandidate(req.params.id);
    const jobs = await JobDescription.findAll({ where: { status: 'Open', approvalStatus: 'Approved' } });
    res.json(jobs.map(job => ({ ...job.toJSON(), score: scoreCandidate(candidate, job), matchedSkills: (candidate.skills || []).filter(s => (job.requiredSkills || []).some(r => r.toLowerCase() === s.toLowerCase())) })).sort((a, b) => b.score - a.score));
  }));

  app.patch('/api/candidate-documents/:id/review', asyncRoute(async (req, res) => {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) throw fail('Document not found.', 404);
    await selectedCandidate(doc.CandidateId);
    const { status, remarks } = req.body;
    if (!['Verified', 'Declined', 'Not Applicable'].includes(status)) throw fail('Choose Verified, Declined or Not Applicable.');
    if (status === 'Verified' && !doc.documentUrl) throw fail('Upload a document before verifying it.');
    if (status !== 'Verified' && !String(remarks || '').trim()) throw fail('A reason is required.');
    await doc.update({ status, remarks: remarks || 'Verified by HR' });
    const candidate = await requireCandidate(doc.CandidateId);
    if (status === 'Declined') await queueMail({ to: candidate.email, kind: 'Document Correction', subject: `Please replace: ${doc.title}`, html: `<p>${escapeHtml(remarks)}</p><a href="${candidateOnboardingUrl(candidate)}">Upload replacement document</a>` });
    await writeAudit({ action: `Document ${status}`, entityType: 'CandidateOnboardingDocument', entityId: doc.id, details: { remarks } });
    res.json(doc);
  }));

  app.post('/api/offers/:id/accept', asyncRoute(async (req, res) => {
    const offer = await Offer.findByPk(req.params.id);
    if (!offer) throw fail('Offer not found.', 404);
    await selectedCandidate(offer.CandidateId);
    await approvedDocuments(offer.CandidateId);
    if (!['Sent', 'Accepted', 'Queued'].includes(offer.status)) throw fail('Dispatch the offer before recording acceptance.');
    if (offer.status === 'Queued' && !String(req.body.offlineConfirmation || '').trim()) throw fail('Email is queued. Record the candidate confirmation received outside email before accepting.');
    await writeAudit({ action: 'Offer acceptance confirmed', entityType: 'Offer', entityId: offer.id, details: { offlineConfirmation: req.body.offlineConfirmation || null } });
    await offer.update({ status: 'Accepted' });
    await Candidate.update({ status: 'Offer Accepted' }, { where: { id: offer.CandidateId, status: { [Op.ne]: 'Inducted' } } });
    res.json({ offer, message: 'Acceptance recorded. Employee access starts only after induction.' });
  }));

  app.post('/api/candidates/:id/onboarding-session', asyncRoute(async (req, res) => {
    const candidate = await requireCandidate(req.params.id);
    const offer = await Offer.findOne({ where: { CandidateId: candidate.id, status: 'Accepted' } });
    if (!offer) throw fail('An accepted offer is required before scheduling onboarding.');
    await selectedCandidate(candidate.id);
    const date = new Date(req.body.scheduledAt);
    if (!Number.isFinite(date.getTime()) || ! /^(https:\/\/\S+|http:\/\/localhost:\d+\/\S+)$/.test(req.body.meetingLink || '')) throw fail('Enter an onboarding date/time and a valid HTTPS meeting link.');
    await candidate.update({ status: 'Onboarding Scheduled', onboardingAt: date, onboardingLink: req.body.meetingLink });
    const mail = await queueMail({ to: candidate.email, kind: 'Onboarding Session', subject: 'Spark Info Solutions onboarding session', html: `<p>Dear ${escapeHtml(candidate.name)}, your onboarding is scheduled for ${escapeHtml(date.toISOString())}.</p><p><a href="${escapeHtml(req.body.meetingLink)}">Join onboarding session</a></p><p><a href="${candidateOnboardingUrl(candidate)}">Review your documents and offer</a></p>` });
    res.json({ candidate, mail });
  }));

  app.post('/api/candidates/:id/induct', asyncRoute(async (req, res) => {
    await ensureCandidateOnboardingDocuments(await requireCandidate(req.params.id));
    const result = await sequelize.transaction(async transaction => {
      const candidate = await Candidate.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!candidate) throw fail('Candidate not found.', 404);
      const existing = await Employee.findOne({ where: { CandidateId: candidate.id }, transaction });
      if (existing) return { employee: existing, created: false };
      const offer = await Offer.findOne({ where: { CandidateId: candidate.id, status: 'Accepted' }, transaction });
      if (!offer) throw fail('Candidate must accept the offer before induction.');
      await selectedCandidate(candidate.id);
      if (!candidate.onboardingAt || req.body.sessionCompleted !== true) throw fail('Schedule and complete the onboarding session before induction.');
      if (new Date(candidate.onboardingAt) > new Date()) throw fail('Complete the scheduled onboarding session before induction.');
      const docs = await approvedDocuments(candidate.id, true);
      const inductedAt = req.body.inductedAt;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(inductedAt || '') || !Number.isFinite(Date.parse(inductedAt)) || inductedAt > new Date().toISOString().slice(0, 10)) throw fail('Enter the actual induction date; it cannot be in the future.');
      const email = String(req.body.email || candidate.email).trim().toLowerCase();
      if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@sparkinfosol\.com$/i.test(email)) throw fail('Employee login email must use @sparkinfosol.com.');
      if (await User.findOne({ where: { email }, transaction })) throw fail('This login email already belongs to an account.');
      if (inductedAt < new Date(candidate.onboardingAt).toISOString().slice(0, 10)) throw fail('Induction cannot precede the onboarding session.');
      await sequelize.query('SELECT pg_advisory_xact_lock(834913)', { transaction });
      const employee = await Employee.create({ employeeCode: await nextEmployeeCode(transaction), name: candidate.name, email, designation: offer.designation, department: offer.department, manager: offer.reportingManager, joiningDate: inductedAt, inductedAt, salaryAnnual: offer.annualCtc, status: 'Active', skills: candidate.skills, CandidateId: candidate.id }, { transaction });
      await OnboardingTask.bulkCreate(docs.map(doc => ({ EmployeeId: employee.id, title: doc.title, category: 'Document', status: doc.status, documentUrl: doc.documentUrl, dueDate: inductedAt })), { transaction });
      await candidate.update({ status: 'Inducted' }, { transaction });
      return { employee, created: true };
    });
    // Retrying is safe if notification or training generation was interrupted.
    const access = await provisionPortalUser({ employee: result.employee });
    await generateLearningLifecycle(result.employee);
    if (result.created) {
      await Notification.create({ EmployeeId: result.employee.id, title: 'Welcome to Spark Info Solutions', body: 'Your employee workspace, training and payroll eligibility are active from your induction date.' });
      await writeAudit({ action: 'Candidate inducted as employee', entityType: 'Employee', entityId: result.employee.id, details: { candidateId: Number(req.params.id), inductedAt: result.employee.inductedAt } });
    }
    res.status(result.created ? 201 : 200).json({ ...result.employee.toJSON(), credentials: access.password ? { email: result.employee.email, password: access.password } : undefined });
  }));

  app.post('/api/payroll/run', asyncRoute(async (req, res) => {
    payrollPeriod({ inductedAt: '2000-01-01', salaryAnnual: 0 }, req.body.month);
    const employees = await Employee.findAll({ where: { status: 'Active', id: req.body.EmployeeId || { [Op.ne]: null } } });
    if (req.body.EmployeeId && !employees.length) throw fail('Choose an active employee with a permanent employee ID.');
    const eligible = employees.filter(employee => { try { requireActiveEmployee(employee); return true; } catch { return false; } });
    if (req.body.EmployeeId && !eligible.length) throw fail('Payroll starts only after employee activation and assignment of a permanent employee ID.');
    const results = await sequelize.transaction(async transaction => {
      await sequelize.query('SELECT pg_advisory_xact_lock(834912)', { transaction });
      const runs = [];
      for (const employee of eligible) {
        const period = payrollPeriod(employee, req.body.month);
        if (!period.paidDays) continue;
        const existing = await PayrollRun.findOne({ where: { EmployeeId: employee.id, month: req.body.month }, transaction });
        if (existing) { runs.push(existing); continue; }
        // Expenses already reimbursed by an earlier run are never added again.
        const expenses = await ExpenseClaim.findAll({ where: { EmployeeId: employee.id, status: 'Approved', spentOn: { [Op.lte]: `${req.body.month}-${String(period.daysInMonth).padStart(2, '0')}` } }, transaction });
        const reimbursements = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
        const deductions = Number(req.body.deductions || 0);
        if (!Number.isFinite(deductions) || deductions < 0 || deductions > period.grossPay) throw fail('Deductions must be between zero and gross salary.');
        const run = await PayrollRun.create({ EmployeeId: employee.id, month: req.body.month, ...period, deductions, reimbursements, netPay: period.grossPay - deductions + reimbursements, status: 'Processed' }, { transaction });
        for (const expense of expenses) await expense.update({ status: 'Reimbursed' }, { transaction });
        runs.push(run);
      }
      return runs;
    });
    res.status(201).json(results);
  }));

  app.post('/api/leaves', asyncRoute(async (req, res) => {
    const days = leaveDays(req.body.startDate, req.body.endDate);
    const employee = await Employee.findByPk(req.body.EmployeeId);
    if (!employee) throw fail('Employee not found.', 404);
    requireActiveEmployee(employee);
    if (!req.body.type || !String(req.body.reason || '').trim()) throw fail('Leave type and reason are required.');
    if (req.body.startDate < (employee.inductedAt || employee.joiningDate)) throw fail('Leave cannot start before induction.');
    const overlap = await LeaveRequest.findOne({ where: { EmployeeId: employee.id, status: { [Op.in]: ['Pending', 'Approved'] }, startDate: { [Op.lte]: req.body.endDate }, endDate: { [Op.gte]: req.body.startDate } } });
    if (overlap) throw fail('A pending or approved leave request overlaps these dates.');
    res.status(201).json(await LeaveRequest.create({ EmployeeId: employee.id, type: req.body.type, startDate: req.body.startDate, endDate: req.body.endDate, days, reason: req.body.reason, status: 'Pending' }));
  }));

  app.patch('/api/leaves/:id', asyncRoute(async (req, res) => {
    if (!['Approved', 'Rejected'].includes(req.body.status)) throw fail('Choose Approved or Rejected.');
    const result = await sequelize.transaction(async transaction => {
      const leave = await LeaveRequest.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!leave) throw fail('Leave request not found.', 404);
      const employee = await Employee.findByPk(leave.EmployeeId, { transaction, lock: transaction.LOCK.UPDATE });
      if (leave.status !== 'Approved' && req.body.status === 'Approved') {
        if (employee.leaveBalance < leave.days) throw fail('Insufficient leave balance.');
        await employee.decrement('leaveBalance', { by: leave.days, transaction });
      } else if (leave.status === 'Approved' && req.body.status === 'Rejected') await employee.increment('leaveBalance', { by: leave.days, transaction });
      return leave.update({ status: req.body.status }, { transaction });
    });
    res.json(result);
  }));

  function pdf(res, filename, title, sections) {
    res.type('application/pdf').set('Content-Disposition', `attachment; filename="${filename.replace(/[^a-z0-9.-]/gi, '-')}.pdf"`);
    const doc = new PDFDocument({ margin: 48, size: 'A4', info: { Title: title, Author: 'Spark Info Solutions' } });
    doc.pipe(res);
    if (logoPath) doc.image(logoPath, 48, 32, { fit: [190, 75] });
    doc.y = 124;
    doc.fillColor('#056698').fontSize(20).text(title).moveDown();
    for (const section of sections) {
      if (doc.y > 680) doc.addPage();
      doc.fillColor('#103e60').fontSize(13).text(section.title || '').moveDown(.4);
      doc.fillColor('#243142').fontSize(10).text(section.text || '', { lineGap: 4 }).moveDown();
    }
    doc.fontSize(9).fillColor('#536071').text(`Copyright ${new Date().getFullYear()} Spark Info Solutions. All rights reserved.`);
    doc.end();
  }
  app.get('/api/learning-paths/:id/pdf/:index', asyncRoute(async (req, res) => {
    const learning = await LearningPath.findByPk(req.params.id);
    const item = learning?.curriculum?.pdfs?.[Number(req.params.index)];
    if (!item) throw fail('Training reference not found.', 404);
    const text = String(item.materialHtml || '').replace(/<\/(p|li|h[1-6]|section)>/gi, '\n\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    pdf(res, item.title, item.title, [{ title: learning.title, text }]);
  }));
  app.get('/api/payroll/:id/pdf', asyncRoute(async (req, res) => {
    const run = await PayrollRun.findByPk(req.params.id, { include: [Employee] });
    if (!run) throw fail('Payslip not found.', 404);
    pdf(res, `Spark-Payslip-${run.Employee.employeeCode}-${run.month}`, `Salary slip: ${run.month}`, [{ title: run.Employee.name, text: `Employee: ${run.Employee.employeeCode}\nDepartment: ${run.Employee.department}\nDesignation: ${run.Employee.designation}\nInduction date: ${run.Employee.inductedAt || run.Employee.joiningDate}` }, { title: 'Salary details (INR)', text: `Paid days: ${run.paidDays ?? '-'} / ${run.daysInMonth ?? '-'}\nGross pay: ${run.grossPay}\nDeductions: ${run.deductions}\nReimbursements: ${run.reimbursements}\nNet pay: ${run.netPay}\nStatus: ${run.status}` }]);
  }));
  return { approvedDocuments, selectedCandidate };
}
