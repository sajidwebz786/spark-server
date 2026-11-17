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

const Employee = sequelize.define('Employee', { email: DataTypes.STRING });
const PayrollRun = sequelize.define('PayrollRun', { month: DataTypes.STRING });
const ExpenseClaim = sequelize.define('ExpenseClaim', { category: DataTypes.STRING });
const LeaveRequest = sequelize.define('LeaveRequest', { type: DataTypes.STRING });
const WorkTask = sequelize.define('WorkTask', { title: DataTypes.STRING });
const LearningPath = sequelize.define('LearningPath', { level: DataTypes.STRING });
Employee.hasMany(PayrollRun);
PayrollRun.belongsTo(Employee);
Employee.hasMany(ExpenseClaim);
ExpenseClaim.belongsTo(Employee);
Employee.hasMany(LeaveRequest);
LeaveRequest.belongsTo(Employee);
Employee.hasMany(WorkTask);
WorkTask.belongsTo(Employee);
Employee.hasMany(LearningPath);
LearningPath.belongsTo(Employee);

await sequelize.authenticate();
const employee = await Employee.findOne({
  where: { email: { [Op.iLike]: 'JD730731@infolinx.com' } },
  include: [PayrollRun, ExpenseClaim, LeaveRequest, WorkTask, LearningPath]
});

console.log(JSON.stringify({
  employee: employee?.email || null,
  payrollRuns: employee?.PayrollRuns?.length || 0,
  janToJun: (employee?.PayrollRuns || []).filter((run) => ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].includes(run.month)).length,
  expenses: employee?.ExpenseClaims?.length || 0,
  leaves: employee?.LeaveRequests?.length || 0,
  tasks: employee?.WorkTasks?.length || 0,
  learningPaths: employee?.LearningPaths?.length || 0
}, null, 2));

await sequelize.close();
