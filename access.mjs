import { isEmployeeEmail } from './employee-email.mjs';

export function installAccess({ app, sequelize, verifyPortalToken, verifySignedToken, asyncRoute }) {
  const m = sequelize.models;
  app.use('/api', asyncRoute(async (req, res, next) => {
    if (req.path === '/health' || req.path === '/auth/login' || req.path.startsWith('/candidate-onboarding/')) return next();
    if (/^\/candidate-tests\/\d+\/(public|submit)$/.test(req.path)) {
      const claims = verifySignedToken(req.query.token, 'candidate-onboarding');
      const test = await m.CandidateTest.findByPk(req.path.split('/')[2]);
      if (!claims || !test || test.CandidateId !== claims.id) return res.status(401).json({ message: 'Candidate assessment link is invalid or expired.' });
      return next();
    }
    const claims = verifyPortalToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!claims || claims.type) return res.status(401).json({ message: 'Please sign in to continue.' });
    const user = await m.User.findByPk(claims.id);
    if (!user || user.status !== 'Active' || user.email !== claims.email) return res.status(401).json({ message: 'Account access is no longer active.' });
    if (user.role === 'Employee' && !isEmployeeEmail(user.email)) return res.status(403).json({ message: 'Employee portal access requires a @sparkinfosol.com email.' });
    req.user = user;
    if (req.path === '/auth/change-password') { req.body.email = user.email; return next(); }
    if (user.role !== 'Employee') return next();
    const deny = () => res.status(403).json({ message: 'Your employee role does not allow this action.' });
    if (!user.EmployeeId) return deny();
    if (req.path === '/employee-requests' && req.method === 'POST') return next();
    if (req.path === '/bootstrap' || req.path === '/employee-portal/bootstrap') return next();
    if ((/^\/mail\/\d+\/attachments\/\d+$/.test(req.path) && req.method === 'GET') || (/^\/mail\/\d+\/read$/.test(req.path) && req.method === 'POST')) return next();
    if (req.path === '/mail/send' && req.method === 'POST') {
      if (req.body.to !== 'HR_ADMIN') return deny();
      return next();
    }
    if (/^\/(attendance\/(clock-in|clock-out)|leaves|expenses|extension-requests|relieving)$/.test(req.path) && req.method === 'POST') {
      if (Number(req.body.EmployeeId) !== user.EmployeeId) return deny();
      return next();
    }
    const owned = req.path.match(/^\/(learning-paths|payroll|projects|work-tasks|certifications)\/(\d+)(.*)$/);
    if (owned) {
      const model = { 'learning-paths': m.LearningPath, payroll: m.PayrollRun, projects: m.ProjectAssignment, 'work-tasks': m.WorkTask, certifications: m.Certification }[owned[1]];
      const record = await model.findByPk(owned[2]);
      if (!record || record.EmployeeId !== user.EmployeeId) return deny();
      if (req.method === 'GET' && /\/pdf/.test(owned[3])) return next();
      if (owned[1] === 'learning-paths' && req.method === 'POST' && /\/assessments\/[^/]+\/complete$/.test(owned[3])) return next();
      if (['projects', 'work-tasks'].includes(owned[1]) && req.method === 'PATCH') {
        const permitted = owned[1] === 'projects' ? ['submissionUrl', 'status'] : ['status', 'dailyUpdate', 'timesheetHours'];
        req.body = Object.fromEntries(Object.entries(req.body).filter(([key]) => permitted.includes(key)));
        return next();
      }
      return deny();
    }
    if (/^\/learning\/\d+\/test$/.test(req.path) && req.method === 'GET') return next();
    if (/^\/learning\/\d+\/attempts$/.test(req.path) && req.method === 'POST' && Number(req.body.EmployeeId) === user.EmployeeId) return next();
    return deny();
  }));
}

export function scopedBootstrap(payload, user) {
  if (user.role !== 'Employee') return payload;
  const own = list => (list || []).filter(x => x.EmployeeId === user.EmployeeId);
  const employees = payload.employees.filter(e => e.id === user.EmployeeId).map(e => e.toJSON ? e.toJSON() : structuredClone(e));
  for (const employee of employees) for (const path of employee.LearningPaths || []) {
    path.curriculum = { ...path.curriculum, tests: (path.curriculum?.tests || []).map(t => ({ ...t, questions: (t.questions || []).map(({ correctAnswer, ...q }) => q) })) };
  }
  return { ...payload, employees, candidates: [], jds: [], panelists: [], interviews: [], offers: [], candidateTests: [], candidateOnboardingDocuments: [], auditLogs: [],
    masterRecords: payload.masterRecords.filter(r => ['holiday', 'leave-policy', 'company-policy', 'role-policies', 'announcement'].includes(r.module) || (r.module === 'employee-request' && r.metadata?.EmployeeId === user.EmployeeId)),
    mails: payload.mails.filter(mail => String(mail.from || '').toLowerCase() === user.email.toLowerCase() || String(mail.to || '').toLowerCase().split(/[,;]\s*/).includes(user.email.toLowerCase())),
    learningAttempts: own(payload.learningAttempts), extensionRequests: own(payload.extensionRequests), projectAssignments: own(payload.projectAssignments), sprintBoards: own(payload.sprintBoards), workTasks: own(payload.workTasks), certifications: own(payload.certifications),
    learningCourses: payload.learningCourses.map(course => ({ ...course.toJSON(), questions: (course.questions || []).map(({ correctAnswer, answer, ...q }) => q) }))
  };
}
