import "dotenv/config";
import { createPool } from "./pool.mjs";
import { ensureDemo } from "../src/demo.mjs";

const pool = createPool();
try {
  const result = await ensureDemo(pool);
  console.log(JSON.stringify(result));
  const counts = await pool.query(
    `SELECT 'shifts' AS t, count(*)::int AS n FROM shifts
     UNION ALL SELECT 'documents', count(*)::int FROM documents
     UNION ALL SELECT 'sales', count(*)::int FROM sales
     UNION ALL SELECT 'purchases', count(*)::int FROM purchases
     UNION ALL SELECT 'banking', count(*)::int FROM banking
     UNION ALL SELECT 'expenses', count(*)::int FROM expenses
     UNION ALL SELECT 'users', count(*)::int FROM users
     UNION ALL SELECT 'outlets', count(*)::int FROM outlets`,
  );
  console.log(counts.rows.map((row) => `${row.t}=${row.n}`).join(" "));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
