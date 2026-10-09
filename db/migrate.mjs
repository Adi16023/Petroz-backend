import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import "dotenv/config";

const dir = path.dirname(fileURLToPath(import.meta.url));
const reshape = fs.readFileSync(path.join(dir, "reshape.sql"), "utf8");
const sql = fs.readFileSync(path.join(dir, "schema.sql"), "utf8");

function directUrl(url) {
  if (!url) throw new Error("DATABASE_URL is not set.");
  return url.includes("-pooler.") ? url.replace("-pooler.", ".") : url;
}

async function addSuperAdminRole(client) {
  const type = await client.query(`SELECT 1 FROM pg_type WHERE typname = 'user_role'`);
  if (!type.rows.length) return;
  const has = await client.query(
    `SELECT 1
     FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'user_role' AND e.enumlabel = 'super_admin'`,
  );
  if (has.rows.length) return;
  await client.query(`ALTER TYPE user_role ADD VALUE 'super_admin'`);
}

async function addAttendanceRole(client) {
  const type = await client.query(`SELECT 1 FROM pg_type WHERE typname = 'user_role'`);
  if (!type.rows.length) return;
  const has = await client.query(
    `SELECT 1
     FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'user_role' AND e.enumlabel = 'attendance'`,
  );
  if (has.rows.length) return;
  await client.query(`ALTER TYPE user_role ADD VALUE 'attendance'`);
}

export async function migrate() {
  const pool = new pg.Pool({
    connectionString: directUrl(process.env.DATABASE_URL),
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  try {
    await addSuperAdminRole(client);
    await addAttendanceRole(client);
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
  try {
    await client.query("BEGIN");
    await client.query(reshape);
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    await migrate();
    const pool = new pg.Pool({
      connectionString: directUrl(process.env.DATABASE_URL),
      ssl: { rejectUnauthorized: false },
      max: 1,
    });
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    console.log(rows.map((row) => row.tablename).join("\n"));
    await pool.end();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
