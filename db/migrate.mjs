import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { createPool } from "./pool.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(dir, "schema.sql"), "utf8");

if (process.env.DATABASE_URL?.includes("-pooler")) {
  console.error("Use the Neon direct connection string for schema changes, not the pooled URL.");
  process.exit(1);
}

const pool = createPool();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  const { rows } = await client.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename`,
  );
  console.log(rows.map((row) => row.tablename).join("\n"));
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
