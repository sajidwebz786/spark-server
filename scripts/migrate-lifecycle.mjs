import dotenv from 'dotenv';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const client = new pg.Client(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : { host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`ALTER TABLE "Candidates" ADD COLUMN IF NOT EXISTS "onboardingAt" TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS "onboardingLink" TEXT;
    ALTER TABLE "Employees" ADD COLUMN IF NOT EXISTS "inductedAt" DATE, ADD COLUMN IF NOT EXISTS "skills" VARCHAR(255)[] DEFAULT '{}';
    ALTER TABLE "PayrollRuns" ADD COLUMN IF NOT EXISTS "paidDays" INTEGER, ADD COLUMN IF NOT EXISTS "daysInMonth" INTEGER;`);
  await client.query('COMMIT');
  console.log('Lifecycle migration complete. Existing records preserved.');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { await client.end(); }
