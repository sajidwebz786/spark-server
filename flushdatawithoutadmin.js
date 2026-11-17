import 'dotenv/config';
import { Sequelize } from 'sequelize';

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

const tables = [
  'JobDescriptions',
  'Candidates',
  'Interviews',
  'Panelists',
  'Employees',
  'OnboardingTasks',
  'Offers',
  'BgvChecks',
  'PayrollRuns',
  'LeaveRequests',
  'ExpenseClaims',
  'RelievingCases',
  'AttendanceRecords',
  'PerformanceReviews',
  'GeneratedLetters',
  'FinalSettlements',
  'Notifications',
  'Users',
  'LearningAttempts',
  'LearningCourses',
  'Departments',
  'MailLogs',
  'MasterRecords',
  'CandidateTests',
  'ExtensionRequests',
  'ProjectAssignments',
  'SprintBoards',
  'WorkTasks',
  'Certifications',
  'AuditLogs',
  'LearningPaths'
];

async function main() {
  try {
    await sequelize.authenticate();
    console.log('Database connected.');

    await sequelize.query('DELETE FROM "Users" WHERE email = \'Info@infolinx.com\'');
    console.log('Deleted admin user record from Users table.');

    for (const table of tables) {
      await sequelize.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
    }
    console.log('All tables truncated.');

    await sequelize.close();
    console.log('Done.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    await sequelize.close();
    process.exit(1);
  }
}

main();
