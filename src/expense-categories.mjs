const DEFAULT_EXPENSE_CATEGORIES = [
  "Tea / Water",
  "Electricity",
  "Maintenance / Repair",
  "Cleaning",
  "Transport",
  "Office / Stationery",
  "Vendor Payment",
  "Fleet Expense",
  "Nozzle Adjustment",
  "Tyre Air / Washer",
  "Maintenance",
  "Miscellaneous",
];

function clipName(value) {
  return String(value ?? "").trim().slice(0, 100);
}

function listFromDesk(desk) {
  const raw = desk && typeof desk === "object" && !Array.isArray(desk) ? desk.expenseCategories : null;
  if (!Array.isArray(raw)) return [];
  return raw.map(clipName).filter(Boolean);
}

function mergeCategories(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const name = clipName(raw);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

async function loadExpenseCategories(pool, outletId) {
  const [deskRes, usedRes] = await Promise.all([
    pool.query(`SELECT desk FROM outlets WHERE id = $1`, [outletId]),
    pool.query(
      `SELECT DISTINCT category
         FROM expenses
        WHERE outlet_id = $1
          AND category IS NOT NULL
          AND btrim(category) <> ''
        ORDER BY category`,
      [outletId],
    ),
  ]);
  const custom = listFromDesk(deskRes.rows[0]?.desk);
  const used = usedRes.rows.map((row) => row.category);
  return {
    custom,
    categories: mergeCategories(DEFAULT_EXPENSE_CATEGORIES, custom, used),
  };
}

async function saveCustomCategory(pool, outletId, name) {
  const trimmed = clipName(name);
  if (!trimmed) {
    const error = new Error("Category name is required.");
    error.status = 400;
    throw error;
  }
  const { rows } = await pool.query(`SELECT desk FROM outlets WHERE id = $1 FOR UPDATE`, [outletId]);
  const desk = rows[0]?.desk && typeof rows[0].desk === "object" && !Array.isArray(rows[0].desk)
    ? { ...rows[0].desk }
    : {};
  const custom = listFromDesk(desk);
  const exists = custom.some((item) => item.toLowerCase() === trimmed.toLowerCase());
  if (!exists) {
    custom.push(trimmed);
    desk.expenseCategories = custom;
    await pool.query(`UPDATE outlets SET desk = $2::jsonb WHERE id = $1`, [outletId, JSON.stringify(desk)]);
  }
  return loadExpenseCategories(pool, outletId);
}

export function registerExpenseCategories(app, { pool, wrap, bad, assertOutlet }) {
  app.get("/api/expense-categories", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.query.outletId);
    const loaded = await loadExpenseCategories(pool, outlet.id);
    res.json({ categories: loaded.categories });
  }));

  app.post("/api/expense-categories", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const name = clipName(req.body?.name);
    if (!name) throw bad("Category name is required.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const loaded = await saveCustomCategory(client, outlet.id, name);
      await client.query("COMMIT");
      res.status(201).json({ categories: loaded.categories });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));
}

export { DEFAULT_EXPENSE_CATEGORIES, mergeCategories, listFromDesk };
