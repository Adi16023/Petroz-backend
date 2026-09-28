import "dotenv/config";
import { createPool } from "./pool.mjs";

const expected = [
  "activity",
  "attendance",
  "balances",
  "dealers",
  "document_lines",
  "documents",
  "equipment",
  "outlets",
  "parties",
  "party_outlets",
  "products",
  "readings",
  "shift_duties",
  "shifts",
];

const pool = createPool();
try {
  const { rows } = await pool.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename`,
    [expected],
  );
  const found = rows.map((row) => row.tablename);
  const missing = expected.filter((name) => !found.includes(name));
  if (missing.length) {
    console.error(`Missing tables: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Connected. ${found.length} tables are present.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
