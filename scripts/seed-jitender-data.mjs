import dotenv from 'dotenv';
import path from 'path';
import { Sequelize, DataTypes, Op } from 'sequelize';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const dbSslEnabled = /^(true|1|require)$/i.test(process.env.DB_SSL || '');
const sequelizeOptions = {
  dialect: process.env.DB_DIALECT || 'postgres',
  dialectOptions: dbSslEnabled ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  logging: false
};

const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, sequelizeOptions)
  : new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
      ...sequelizeOptions,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432
    });

const Employee = sequelize.define('Employee', {
  name: DataTypes.STRING,
  email: DataTypes.STRING,
  employeeCode: DataTypes.STRING,
  designation: DataTypes.STRING,
  salaryAnnual: DataTypes.FLOAT
});
const PayrollRun = sequelize.define('PayrollRun', {
  month: DataTypes.STRING,
  grossPay: DataTypes.FLOAT,
  deductions: DataTypes.FLOAT,
  reimbursements: DataTypes.FLOAT,
  netPay: DataTypes.FLOAT,
  status: DataTypes.STRING,
  creditedAt: DataTypes.DATE
});
const ExpenseClaim = sequelize.define('ExpenseClaim', {
  category: DataTypes.STRING,
  amount: DataTypes.FLOAT,
  spentOn: DataTypes.DATEONLY,
  description: DataTypes.TEXT,
  status: DataTypes.STRING
});
const LeaveRequest = sequelize.define('LeaveRequest', {
  type: DataTypes.STRING,
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY,
  days: DataTypes.FLOAT,
  reason: DataTypes.TEXT,
  status: DataTypes.STRING
});
const Notification = sequelize.define('Notification', {
  title: DataTypes.STRING,
  body: DataTypes.TEXT,
  channel: DataTypes.STRING,
  status: DataTypes.STRING
});
const ProjectAssignment = sequelize.define('ProjectAssignment', {
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  durationDays: DataTypes.INTEGER,
  deliverables: DataTypes.TEXT,
  status: DataTypes.STRING,
  reviewNotes: DataTypes.TEXT
});
const SprintBoard = sequelize.define('SprintBoard', {
  name: DataTypes.STRING,
  sprintGoal: DataTypes.TEXT,
  status: DataTypes.STRING,
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY
});
const WorkTask = sequelize.define('WorkTask', {
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  storyPoints: DataTypes.INTEGER,
  priority: DataTypes.STRING,
  status: DataTypes.STRING,
  dailyUpdate: DataTypes.TEXT,
  timesheetHours: DataTypes.FLOAT
});
const LearningPath = sequelize.define('LearningPath', {
  level: DataTypes.STRING,
  title: DataTypes.STRING,
  durationDays: DataTypes.INTEGER,
  extensionDays: DataTypes.INTEGER,
  curriculum: DataTypes.JSONB,
  roadmap: DataTypes.TEXT,
  status: DataTypes.STRING,
  progress: DataTypes.INTEGER,
  assessmentsPassed: DataTypes.INTEGER,
  dueDate: DataTypes.DATEONLY
});

Employee.hasMany(PayrollRun);
PayrollRun.belongsTo(Employee);
Employee.hasMany(ExpenseClaim);
ExpenseClaim.belongsTo(Employee);
Employee.hasMany(LeaveRequest);
LeaveRequest.belongsTo(Employee);
Employee.hasMany(Notification);
Notification.belongsTo(Employee);
Employee.hasMany(ProjectAssignment);
ProjectAssignment.belongsTo(Employee);
Employee.hasMany(SprintBoard);
SprintBoard.belongsTo(Employee);
SprintBoard.hasMany(WorkTask);
WorkTask.belongsTo(SprintBoard);
Employee.hasMany(WorkTask);
WorkTask.belongsTo(Employee);
Employee.hasMany(LearningPath);
LearningPath.belongsTo(Employee);

const employeeEmail = 'JD730731@infolinx.com';

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

await sequelize.authenticate();

const employee = await Employee.findOne({ where: { email: { [Op.iLike]: employeeEmail } } });
if (!employee) throw new Error(`Employee not found: ${employeeEmail}`);

const annual = employee.salaryAnnual && employee.salaryAnnual > 0 ? employee.salaryAnnual : 1800000;
await employee.update({ salaryAnnual: annual });

const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
for (const [index, month] of months.entries()) {
  const grossPay = Math.round(annual / 12);
  const reimbursements = [2500, 0, 1800, 3200, 0, 4500][index];
  const deductions = Math.round(grossPay * 0.12) + [0, 500, 0, 750, 0, 1000][index];
  const netPay = grossPay - deductions + reimbursements;
  const [run] = await PayrollRun.findOrCreate({
    where: { EmployeeId: employee.id, month },
    defaults: {
      EmployeeId: employee.id,
      month,
      grossPay,
      deductions,
      reimbursements,
      netPay,
      status: 'Credited',
      creditedAt: new Date(`${month}-28T10:00:00Z`)
    }
  });
  await run.update({ grossPay, deductions, reimbursements, netPay, status: 'Credited', creditedAt: run.creditedAt || new Date(`${month}-28T10:00:00Z`) });
}

const expenseSamples = [
  ['Travel Reimbursement', 4500, '2026-06-12', 'Client delivery meeting cab and local travel', 'Submitted'],
  ['Internet Allowance', 1500, '2026-06-25', 'Monthly remote work internet support', 'Approved'],
  ['Team Lunch', 3200, '2026-05-18', 'Sprint retrospective team lunch', 'Manager Review']
];
for (const [category, amount, spentOn, description, status] of expenseSamples) {
  const [claim] = await ExpenseClaim.findOrCreate({
    where: { EmployeeId: employee.id, category, spentOn },
    defaults: { EmployeeId: employee.id, category, amount, spentOn, description, status }
  });
  await claim.update({ amount, description, status });
}

const leaveSamples = [
  ['Casual Leave', '2026-07-22', '2026-07-22', 1, 'Personal work', 'Pending'],
  ['Work From Home', '2026-07-18', '2026-07-18', 1, 'Client release monitoring from home', 'Approved']
];
for (const [type, startDate, endDate, days, reason, status] of leaveSamples) {
  const [leave] = await LeaveRequest.findOrCreate({
    where: { EmployeeId: employee.id, type, startDate },
    defaults: { EmployeeId: employee.id, type, startDate, endDate, days, reason, status }
  });
  await leave.update({ endDate, days, reason, status });
}

const notifications = [
  ['Timesheet reminder', 'Submit daily scrum update before 6 PM.', 'In-app', 'Unread'],
  ['Payroll credited', 'June 2026 salary has been credited.', 'Email', 'Unread'],
  ['Task approval pending', 'Delivery tracker task is waiting for Team Leader review.', 'In-app', 'Unread']
];
for (const [title, body, channel, status] of notifications) {
  const [note] = await Notification.findOrCreate({
    where: { EmployeeId: employee.id, title },
    defaults: { EmployeeId: employee.id, title, body, channel, status }
  });
  await note.update({ body, channel, status });
}

const [project] = await ProjectAssignment.findOrCreate({
  where: { EmployeeId: employee.id, title: 'Delivery Operations Sprint Readiness' },
  defaults: {
    EmployeeId: employee.id,
    title: 'Delivery Operations Sprint Readiness',
    description: 'Agile onboarding project for Delivery Manager responsibilities across sprint planning, client communication, risk tracking, and delivery governance.',
    durationDays: 14,
    deliverables: 'Sprint charter, delivery tracker, risk register, demo notes, retrospective action items',
    status: 'Assigned',
    reviewNotes: 'Team Leader: Delivery Lead. Final approval after sprint review.'
  }
});
await project.update({ durationDays: 14, status: 'Assigned', reviewNotes: 'Team Leader: Delivery Lead. Final approval after sprint review.' });

const [board] = await SprintBoard.findOrCreate({
  where: { EmployeeId: employee.id, name: 'Sprint 1 - Delivery Governance' },
  defaults: {
    EmployeeId: employee.id,
    name: 'Sprint 1 - Delivery Governance',
    sprintGoal: 'Establish sprint operating rhythm, finalize delivery tracker, and prepare sprint review evidence.',
    status: 'Active',
    startDate: dateOnly('2026-07-01'),
    endDate: dateOnly('2026-07-14')
  }
});
await board.update({ status: 'Active', startDate: dateOnly('2026-07-01'), endDate: dateOnly('2026-07-14') });

const tasks = [
  ['Review sprint backlog and acceptance criteria', 'Confirm scope, blockers, owners, Definition of Done and reporting rhythm with Team Leader.', 3, 'High', 'Done', 'Backlog reviewed and acceptance criteria confirmed with Delivery Lead.', 4],
  ['Prepare delivery tracker and risk register', 'Create tracker covering sprint tasks, dependencies, risks, mitigations and escalation path.', 5, 'High', 'Review', 'Delivery tracker and risk register submitted for Team Leader approval.', 7.5],
  ['Run daily scrum update and blocker log', 'Submit daily progress update, blockers, next action and help needed from Team Leader.', 3, 'Medium', 'In Progress', 'Today: updated blocker log. Next: collect QA evidence.', 5],
  ['Submit sprint demo evidence', 'Attach demo notes, completed deliverables, pending issues and retrospective items for TL approval.', 5, 'High', 'To Do', '', 0],
  ['Finalize retrospective action items', 'Capture what went well, what needs improvement, and next sprint action owners.', 2, 'Medium', 'To Do', '', 0]
];
for (const [title, description, storyPoints, priority, status, dailyUpdate, timesheetHours] of tasks) {
  const [task] = await WorkTask.findOrCreate({
    where: { EmployeeId: employee.id, SprintBoardId: board.id, title },
    defaults: { EmployeeId: employee.id, SprintBoardId: board.id, title, description, storyPoints, priority, status, dailyUpdate, timesheetHours }
  });
  await task.update({ description, storyPoints, priority, status, dailyUpdate, timesheetHours });
}

const learningLevels = [
  ['Beginner', 'Delivery Manager Beginner Career Track', 7, 3, 'Completed', 100, 3],
  ['Intermediate', 'Delivery Manager Intermediate Career Track', 10, 5, 'In Progress', 34, 1],
  ['Advanced', 'Delivery Manager Advanced Career Track', 20, 10, 'Locked', 0, 0]
];
for (const [level, title, durationDays, extensionDays, status, progress, assessmentsPassed] of learningLevels) {
  const skills = ['Scrum Delivery', 'Stakeholder Communication', 'Risk Management', 'Sprint Reporting'];
  const curriculum = {
    skills,
    pdfs: skills.slice(0, 3).map((skill) => ({
      title: `${skill} ${level} Reference PDF`,
      topic: skill,
      materialHtml: `<article><h1>${skill} ${level}</h1><p>Role-based material for ${employee.name}.</p></article>`
    })),
    exercises: skills.map((skill) => `${level} exercise: apply ${skill} to a delivery sprint.`),
    tests: [1, 2, 3].map((n) => ({
      id: `${level.toLowerCase()}-test-${n}`,
      title: `${level} Assessment ${n}`,
      day: n * 2,
      status: n <= assessmentsPassed ? 'Passed' : 'Pending',
      score: n <= assessmentsPassed ? 82 : null
    }))
  };
  const [pathRecord] = await LearningPath.findOrCreate({
    where: { EmployeeId: employee.id, level },
    defaults: {
      EmployeeId: employee.id,
      level,
      title,
      durationDays,
      extensionDays,
      curriculum,
      roadmap: 'Beginner -> Intermediate -> Advanced -> Mini Project -> Certification -> Project Tasks',
      status,
      progress,
      assessmentsPassed,
      dueDate: dateOnly(Date.now() + durationDays * 86400000)
    }
  });
  await pathRecord.update({
    title,
    durationDays,
    extensionDays,
    curriculum,
    roadmap: 'Beginner -> Intermediate -> Advanced -> Mini Project -> Certification -> Project Tasks',
    status,
    progress,
    assessmentsPassed
  });
}

console.log(JSON.stringify({
  employee: employee.email,
  payrollRuns: months.length,
  expenses: expenseSamples.length,
  leaves: leaveSamples.length,
  tasks: tasks.length,
  learningPaths: learningLevels.length
}, null, 2));

await sequelize.close();
