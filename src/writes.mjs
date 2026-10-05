import bcrypt from "bcryptjs";

const PAY_MODES = ["cash", "upi", "card", "credit", "neft", "rtgs", "imps", "cheque", "bank"];
const STAFF_TYPES = ["cashier", "pump_boy", "supervisor", "air_boy", "dsm", "custom"];
const STAFF_LABEL = {
  cashier: "Cashier",
  pump_boy: "Pump operator",
  supervisor: "Supervisor",
  air_boy: "Air boy",
  dsm: "Dealer salesman",
  custom: "Staff",
};
const STATUSES = [
  "draft", "open", "partial", "approved", "rejected", "paid", "pending",
  "settled", "difference", "failed", "reversed", "cancelled", "locked",
  "sent", "received", "completed",
];
const FUEL_NAMES = { MS: "Petrol", HSD: "Diesel", POWER: "Power" };

function money(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function payMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("upi")) return "upi";
  if (v.includes("card")) return "card";
  if (v.includes("credit")) return "credit";
  if (v.includes("neft")) return "neft";
  if (v.includes("rtgs")) return "rtgs";
  if (v.includes("imps")) return "imps";
  if (v.includes("cheque")) return "cheque";
  if (v.includes("bank")) return "bank";
  if (PAY_MODES.includes(v)) return v;
  return "cash";
}

function day(value) {
  if (!value || value === "Today") return new Date().toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}

function optionalDay(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function registerWrites(app, { pool, wrap, bad, assertOutlet }) {
  async function log(user, outletId, action, detail, targetTable, targetId) {
    await pool.query(
      `INSERT INTO activity (outlet_id, actor_id, action, detail, target_table, target_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [outletId, user.id, action, detail ?? null, targetTable ?? null, targetId ?? null],
    );
  }

  async function partyId(user, outletId, name, explicitId) {
    if (explicitId) return explicitId;
    const label = String(name ?? "").trim();
    if (!label) return null;
    const { rows } = await pool.query(
      `SELECT id FROM users
       WHERE settings_id = $1 AND lower(name) = lower($2)
         AND (outlet_id IS NULL OR outlet_id = $3)
       LIMIT 1`,
      [user.settings_id, label, outletId],
    );
    return rows[0]?.id ?? null;
  }

  async function productId(user, name) {
    const label = String(name ?? "").trim();
    if (!label) return null;
    const fuel = FUEL_NAMES[label.toUpperCase()] ?? label;
    const { rows } = await pool.query(
      `SELECT id FROM products
       WHERE settings_id = $1 AND (lower(name) = lower($2) OR lower(name) = lower($3))
       LIMIT 1`,
      [user.settings_id, label, fuel],
    );
    return rows[0]?.id ?? null;
  }

  app.post("/api/documents", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const kind = String(req.body?.kind ?? "");
    const allowed = [
      "sale", "quote", "order", "purchase_order", "purchase", "payment", "receipt",
      "transfer", "settlement", "expense", "expense_schedule", "salary", "adjustment", "dsr",
    ];
    if (!allowed.includes(kind)) throw bad("Unknown document kind.");
    let status = req.body?.status && STATUSES.includes(req.body.status) ? req.body.status : "open";
    if (kind === "expense") {
      if (["owner", "manager", "super_admin"].includes(req.user.role)) status = "approved";
      else if (req.user.role === "staff") status = "pending";
    }
    const amount = money(req.body?.amount);
    const charges = money(req.body?.charges);
    const net = req.body?.net == null || req.body?.net === "" ? amount : money(req.body.net);
    const mode = payMode(req.body?.mode);
    const userId = await partyId(req.user, outlet.id, req.body?.partyName, req.body?.partyId);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let id;
      let table;
      if (kind === "sale") {
        table = "sales";
        const inserted = await client.query(
          `INSERT INTO sales (
             outlet_id, user_id, shift_id, status, doc_no, doc_date, due_date,
             amount, charges, net, mode, category, reference, vehicle, note, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING id`,
          [
            outlet.id, userId, req.body?.shiftId || null, status, req.body?.docNo || null,
            day(req.body?.docDate), optionalDay(req.body?.dueDate), amount, charges, net, mode,
            req.body?.category || null, req.body?.reference || null, req.body?.vehicle || null,
            req.body?.note || null, req.user.id,
          ],
        );
        id = inserted.rows[0].id;
        for (const line of lines) {
          const product = await productId(req.user, line.productName ?? line.description);
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, equipment_id, description, qty, rate, amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, product, line.equipmentId || null, line.description ?? line.productName ?? null, money(line.qty), money(line.rate), money(line.amount)],
          );
          const sold = product ? await client.query(`SELECT kind FROM products WHERE id = $1`, [product]) : { rows: [] };
          if (sold.rows[0]?.kind === "fuel") {
            await client.query(
              `UPDATE equipment SET live_qty = GREATEST(0, live_qty - $3)
               WHERE id = (
                 SELECT e.id FROM equipment e
                 WHERE e.outlet_id = $1 AND e.kind = 'tank' AND e.product_id = $2
                 ORDER BY e.label LIMIT 1
               )`,
              [outlet.id, product, money(line.qty) / 1000],
            );
          } else if (product) {
            await client.query(
              `INSERT INTO balances (outlet_id, product_id, on_hand, min_qty)
               VALUES ($1, $2, $3, 0)
               ON CONFLICT (outlet_id, product_id) DO UPDATE SET on_hand = balances.on_hand + EXCLUDED.on_hand`,
              [outlet.id, product, -money(line.qty)],
            );
          }
        }
        if (mode === "cash" && req.body?.shiftId) {
          await client.query(`UPDATE shifts SET expected_cash = expected_cash + $2 WHERE id = $1`, [req.body.shiftId, net]);
        }
      } else if (kind === "purchase" || kind === "purchase_order") {
        table = "purchases";
        const inserted = await client.query(
          `INSERT INTO purchases (
             outlet_id, user_id, shift_id, kind, status, doc_no, doc_date, due_date,
             amount, charges, net, mode, category, reference, note, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING id`,
          [outlet.id, userId, req.body?.shiftId || null, kind, status, req.body?.docNo || null, day(req.body?.docDate), optionalDay(req.body?.dueDate), amount, charges, net, mode, req.body?.category || null, req.body?.reference || null, req.body?.note || null, req.user.id],
        );
        id = inserted.rows[0].id;
        for (const line of lines) {
          const product = await productId(req.user, line.productName ?? line.description);
          const received = line.qtyReceived == null || line.qtyReceived === "" ? null : money(line.qtyReceived);
          await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, equipment_id, description, qty, rate, amount, qty_received)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, product, line.equipmentId || null, line.description ?? line.productName ?? null, money(line.qty), money(line.rate), money(line.amount), received],
          );
          const stockQty = received ?? (kind === "purchase" ? money(line.qty) : 0);
          const bought = product ? await client.query(`SELECT kind FROM products WHERE id = $1`, [product]) : { rows: [] };
          if (product && stockQty && bought.rows[0]?.kind === "fuel") {
            await client.query(
              `UPDATE equipment SET live_qty = live_qty + $3
               WHERE id = (
                 SELECT e.id FROM equipment e
                 WHERE e.outlet_id = $1 AND e.kind = 'tank' AND e.product_id = $2
                 ORDER BY e.label LIMIT 1
               )`,
              [outlet.id, product, stockQty],
            );
          } else if (product && stockQty) {
            await client.query(
              `INSERT INTO balances (outlet_id, product_id, on_hand, min_qty)
               VALUES ($1, $2, $3, 0)
               ON CONFLICT (outlet_id, product_id) DO UPDATE SET on_hand = balances.on_hand + EXCLUDED.on_hand`,
              [outlet.id, product, stockQty],
            );
          }
        }
      } else if (kind === "expense" || kind === "expense_schedule") {
        table = "expenses";
        const inserted = await client.query(
          `INSERT INTO expenses (
             outlet_id, user_id, shift_id, kind, status, doc_no, doc_date, due_date,
             amount, charges, net, mode, category, note, frequency, next_due,
             reimbursable, deduct_from_shift_cash, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING id`,
          [
            outlet.id, userId, req.body?.shiftId || null, kind, status, req.body?.docNo || null,
            day(req.body?.docDate), optionalDay(req.body?.dueDate), amount, charges, net, mode,
            req.body?.category || null, req.body?.note || null, req.body?.frequency || null,
            optionalDay(req.body?.nextDue), Boolean(req.body?.reimbursable), Boolean(req.body?.deductFromShiftCash),
            req.user.id,
          ],
        );
        id = inserted.rows[0].id;
      } else if (kind === "transfer" || kind === "settlement" || (kind === "receipt" && req.body?.category === "cash_deposit")) {
        table = "banking";
        const bankKind = kind === "receipt" ? "deposit" : kind;
        const inserted = await client.query(
          `INSERT INTO banking (
             outlet_id, user_id, shift_id, kind, status, doc_no, doc_date,
             amount, charges, net, mode, category, reference, note, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id`,
          [
            outlet.id, userId, req.body?.shiftId || null, bankKind, status, req.body?.docNo || null,
            day(req.body?.docDate), amount, charges, net, mode,
            kind === "receipt" ? "cash_deposit" : req.body?.category || null,
            req.body?.reference || null, req.body?.note || null, req.user.id,
          ],
        );
        id = inserted.rows[0].id;
      } else {
        table = "documents";
        const docKind = ["quote", "order", "payment", "receipt", "salary", "adjustment", "dsr"].includes(kind) ? kind : "adjustment";
        const inserted = await client.query(
          `INSERT INTO documents (
             outlet_id, user_id, shift_id, kind, status, doc_no, doc_date, due_date,
             amount, charges, net, mode, category, reference, vehicle, note,
             frequency, next_due, reimbursable, created_by
           ) VALUES ($1,$2,$3,$4::document_kind,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING id`,
          [
            outlet.id, userId, req.body?.shiftId || null, docKind, status, req.body?.docNo || null,
            day(req.body?.docDate), optionalDay(req.body?.dueDate), amount, charges, net, mode,
            req.body?.category || null, req.body?.reference || null, req.body?.vehicle || null,
            req.body?.note || null, req.body?.frequency || null, optionalDay(req.body?.nextDue),
            Boolean(req.body?.reimbursable), req.user.id,
          ],
        );
        id = inserted.rows[0].id;
        for (const line of lines) {
          const product = await productId(req.user, line.productName ?? line.description);
          await client.query(
            `INSERT INTO document_items (document_id, product_id, equipment_id, description, qty, rate, amount, qty_received)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, product, line.equipmentId || null, line.description ?? line.productName ?? null, money(line.qty), money(line.rate), money(line.amount), line.qtyReceived == null ? null : money(line.qtyReceived)],
          );
          if (product && line.stockQty) {
            await client.query(
              `INSERT INTO balances (outlet_id, product_id, on_hand, min_qty)
               VALUES ($1, $2, $3, 0)
               ON CONFLICT (outlet_id, product_id) DO UPDATE SET on_hand = balances.on_hand + EXCLUDED.on_hand`,
              [outlet.id, product, money(line.stockQty)],
            );
          }
        }
      }
      if (kind === "expense" && req.body?.shiftId && (mode === "cash" || req.body?.deductFromShiftCash) && status !== "rejected") {
        await client.query(
          `UPDATE shifts SET expected_cash = expected_cash - $2 WHERE id = $1`,
          [req.body.shiftId, net],
        );
      }
      await client.query(
        `INSERT INTO activity (outlet_id, actor_id, action, detail, target_table, target_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [outlet.id, req.user.id, "created", req.body?.note || `${kind} ${amount}`, table, id],
      );
      await client.query("COMMIT");
      res.status(201).json({ id, kind });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/documents/:id", wrap(async (req, res) => {
    const status = req.body?.status;
    if (status && !STATUSES.includes(status)) throw bad("Unknown status.");
    const tables = ["sales", "purchases", "expenses", "banking", "documents"];
    for (const table of tables) {
      const found = await pool.query(`SELECT id, outlet_id FROM ${table} WHERE id = $1`, [req.params.id]);
      const row = found.rows[0];
      if (!row) continue;
      await assertOutlet(pool, req.user, row.outlet_id);
      if (status) {
        const decided = table === "expenses" || table === "purchases" ? ", decided_by = $3" : "";
        await pool.query(
          `UPDATE ${table} SET status = $2${decided} WHERE id = $1`,
          decided ? [row.id, status, req.user.id] : [row.id, status],
        );
      }
      await log(req.user, row.outlet_id, "updated", `${table} ${status ?? "saved"}`, table, row.id);
      res.json({ id: row.id, status: status ?? null });
      return;
    }
    throw bad("Document not found.", 404);
  }));

  app.delete("/api/documents/:id", wrap(async (req, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw bad("A reason is required to delete.");
    const targets = [
      ["sales", "sale_items", "sale_id"],
      ["purchases", "purchase_items", "purchase_id"],
      ["documents", "document_items", "document_id"],
      ["expenses", null, null],
      ["banking", null, null],
    ];
    for (const [table, child, fk] of targets) {
      const found = await pool.query(`SELECT id, outlet_id FROM ${table} WHERE id = $1`, [req.params.id]);
      const row = found.rows[0];
      if (!row) continue;
      await assertOutlet(pool, req.user, row.outlet_id);
      if (child) await pool.query(`DELETE FROM ${child} WHERE ${fk} = $1`, [row.id]);
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [row.id]);
      await log(req.user, row.outlet_id, "deleted", reason, table, row.id);
      res.json({ id: row.id, deleted: true });
      return;
    }
    throw bad("Document not found.", 404);
  }));

  app.post("/api/parties", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw bad("Name is required.");
    const role = req.body?.role ?? "credit_customer";
    const roles = ["manager", "staff", "credit_customer", "supplier", "bank", "provider"];
    if (!roles.includes(role)) throw bad("Unknown role.");
    let staffType = null;
    let passwordHash = null;
    let designation = req.body?.designation || null;
    if (role === "staff" || role === "manager") {
      if (!["owner", "super_admin"].includes(req.user.role)) throw bad("You cannot add staff.", 403);
      const digits = String(req.body?.phone ?? "").replace(/\D/g, "");
      if (!digits) throw bad("Mobile is required.");
      const password = String(req.body?.password ?? "");
      if (password.length < 4) throw bad("Password must be at least 4 characters.");
      if (role === "staff") {
        staffType = String(req.body?.staffType ?? "");
        if (!STAFF_TYPES.includes(staffType)) throw bad("Pick a staff type.");
      }
      const taken = await pool.query(
        `SELECT id FROM users
         WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
           AND active = true
           AND role = ANY($2::user_role[])`,
        [digits, ["super_admin", "owner", "manager", "staff", "credit_customer", "auditor", "accounts_auditor"]],
      );
      if (taken.rows.length) throw bad("That mobile is already in use.");
      passwordHash = await bcrypt.hash(password, 10);
      if (!String(designation ?? "").trim()) {
        designation = role === "manager" ? "Manager" : STAFF_LABEL[staffType];
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO users (
         settings_id, outlet_id, role, name, phone, alt_phone, email, address, gstin,
         customer_type, vehicle, credit_limit, credit_period_days, credit_status, designation,
         staff_type, password_hash, bank_name, account_no
       ) VALUES ($1,$2,$3::user_role,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'clear',$14,$15::staff_type,$16,$17,$18)
       RETURNING id`,
      [
        outlet.settings_id, outlet.id, role, name, req.body?.phone || null, req.body?.altPhone || null,
        req.body?.email || null, req.body?.address || null, req.body?.gstin || null, req.body?.customerType || null,
        req.body?.vehicle || null, req.body?.creditLimit == null ? null : money(req.body.creditLimit),
        req.body?.creditPeriodDays == null ? null : Number(req.body.creditPeriodDays) || null,
        designation, staffType, passwordHash, req.body?.bankName || null, req.body?.accountNo || null,
      ],
    );
    const id = rows[0].id;
    await log(req.user, outlet.id, "created", name, "users", id);
    res.status(201).json({ id, canSignIn: role === "staff" || role === "manager" });
  }));

  app.patch("/api/parties/:id", wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, outlet_id FROM users WHERE id = $1 AND ($2::uuid IS NULL OR settings_id = $2)`,
      [req.params.id, req.user.role === "super_admin" ? null : req.user.settings_id],
    );
    const row = rows[0];
    if (!row) throw bad("Party not found.", 404);
    if (row.outlet_id) await assertOutlet(pool, req.user, row.outlet_id);
    await pool.query(
      `UPDATE users SET
         permission_grants = COALESCE($2::text[], permission_grants),
         permission_revokes = COALESCE($3::text[], permission_revokes),
         manager_can_assign = COALESCE($4, manager_can_assign)
       WHERE id = $1`,
      [
        row.id,
        Array.isArray(req.body?.permissionGrants) ? req.body.permissionGrants : null,
        Array.isArray(req.body?.permissionRevokes) ? req.body.permissionRevokes : null,
        req.body?.managerCanAssign == null ? null : Boolean(req.body.managerCanAssign),
      ],
    );
    await log(req.user, row.outlet_id, "permission", req.body?.detail || "Permissions updated", "users", row.id);
    res.json({ id: row.id });
  }));

  app.post("/api/products", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw bad("Product name is required.");
    const kind = req.body?.kind === "fmcg" ? "fmcg" : req.body?.kind === "fuel" ? "fuel" : "lube";
    const { rows } = await pool.query(
      `INSERT INTO products (settings_id, kind, name, brand, code, hsn, unit, gst, purchase_price, selling_price)
       VALUES ($1, $2::product_kind, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        outlet.settings_id, kind, name, req.body?.brand || null, req.body?.code || null, req.body?.hsn || null,
        req.body?.unit || null, money(req.body?.gst), money(req.body?.purchasePrice), money(req.body?.sellingPrice),
      ],
    );
    const id = rows[0].id;
    await pool.query(
      `INSERT INTO balances (outlet_id, product_id, on_hand, min_qty) VALUES ($1, $2, $3, $4)`,
      [outlet.id, id, money(req.body?.onHand), money(req.body?.minQty)],
    );
    await log(req.user, outlet.id, "created", name, "products", id);
    res.status(201).json({ id });
  }));

  app.delete("/api/products/:id", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId || req.query.outletId);
    const product = await pool.query(
      `SELECT id FROM products WHERE id = $1 AND settings_id = $2`,
      [req.params.id, req.user.settings_id],
    );
    if (!product.rows[0]) throw bad("Product not found.", 404);
    await pool.query(`DELETE FROM balances WHERE product_id = $1 AND outlet_id = $2`, [req.params.id, outlet.id]);
    await pool.query(`DELETE FROM products WHERE id = $1 AND settings_id = $2`, [req.params.id, req.user.settings_id]);
    await log(req.user, outlet.id, "deleted", req.body?.reason || "Product removed", "products", req.params.id);
    res.json({ id: req.params.id, deleted: true });
  }));

  app.post("/api/readings", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const kind = req.body?.kind;
    if (!["opening", "closing", "dip"].includes(kind)) throw bad("Unknown reading kind.");
    const equipment = await pool.query(
      `SELECT id, kind FROM equipment WHERE id = $1 AND outlet_id = $2`,
      [req.body?.equipmentId, outlet.id],
    );
    if (!equipment.rows[0]) throw bad("Equipment not found.", 404);
    const { rows } = await pool.query(
      `INSERT INTO dip_readings (shift_id, equipment_id, user_id, kind, mm, qty, book_qty, status, remarks)
       VALUES ($1, $2, $3, $4::reading_kind, $5, $6, $7, $8::dip_status, $9)
       RETURNING id`,
      [
        req.body?.shiftId || null,
        equipment.rows[0].id,
        req.body?.partyId || req.user.id,
        kind,
        req.body?.mm == null || req.body?.mm === "" ? null : money(req.body.mm),
        req.body?.qty == null || req.body?.qty === "" ? null : money(req.body.qty),
        req.body?.bookQty == null || req.body?.bookQty === "" ? null : money(req.body.bookQty),
        req.body?.status && ["normal", "difference", "pending"].includes(req.body.status) ? req.body.status : null,
        req.body?.remarks || null,
      ],
    );
    if (kind === "dip" && req.body?.qty != null) {
      await pool.query(`UPDATE equipment SET live_qty = $2 WHERE id = $1`, [equipment.rows[0].id, money(req.body.qty)]);
    }
    if ((kind === "opening" || kind === "closing") && req.body?.qty != null) {
      await pool.query(`UPDATE equipment SET meter = $2 WHERE id = $1`, [equipment.rows[0].id, money(req.body.qty)]);
    }
    await log(req.user, outlet.id, "reading", `${kind} reading`, "dip_readings", rows[0].id);
    res.status(201).json({ id: rows[0].id });
  }));

  app.delete("/api/readings/:id", wrap(async (req, res) => {
    const found = await pool.query(
      `SELECT r.id, e.outlet_id FROM dip_readings r JOIN equipment e ON e.id = r.equipment_id WHERE r.id = $1`,
      [req.params.id],
    );
    const row = found.rows[0];
    if (!row) throw bad("Reading not found.", 404);
    await assertOutlet(pool, req.user, row.outlet_id);
    await pool.query(`DELETE FROM dip_readings WHERE id = $1`, [row.id]);
    await log(req.user, row.outlet_id, "deleted", req.body?.reason || "Reading removed", "dip_readings", row.id);
    res.json({ id: row.id, deleted: true });
  }));

  app.patch("/api/equipment/:id", wrap(async (req, res) => {
    const found = await pool.query(`SELECT id, outlet_id, dip_chart FROM equipment WHERE id = $1`, [req.params.id]);
    const row = found.rows[0];
    if (!row) throw bad("Equipment not found.", 404);
    await assertOutlet(pool, req.user, row.outlet_id);
    const mm = money(req.body?.mm);
    const litres = money(req.body?.litres);
    const chart = Array.isArray(row.dip_chart) ? row.dip_chart.filter((point) => Number(point.mm) !== mm) : [];
    chart.push({ mm, litres });
    chart.sort((a, b) => Number(a.mm) - Number(b.mm));
    await pool.query(`UPDATE equipment SET dip_chart = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(chart)]);
    await log(req.user, row.outlet_id, "updated", `Dip chart ${mm} mm`, "equipment", row.id);
    res.json({ id: row.id });
  }));

  app.post("/api/attendance", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const party = req.body?.partyId || req.user.id;
    const { rows } = await pool.query(
      `INSERT INTO attendance (user_id, outlet_id, check_in, gps_ok, geofence_ok, selfie, spoof, device, manual_by)
       VALUES ($1, $2, now(), $3, $4, $5, false, $6, $7)
       RETURNING id`,
      [
        party,
        outlet.id,
        req.body?.manual ? false : true,
        true,
        req.body?.manual ? false : true,
        req.body?.manual ? "Manual desk" : "This browser",
        req.body?.manual ? req.user.id : null,
      ],
    );
    await log(req.user, outlet.id, "check-in", req.body?.manual ? "Manual check-in" : "GPS check-in", "attendance", rows[0].id);
    res.status(201).json({ id: rows[0].id });
  }));

  app.patch("/api/attendance/:id", wrap(async (req, res) => {
    const found = await pool.query(`SELECT id, outlet_id, user_id FROM attendance WHERE id = $1`, [req.params.id]);
    const row = found.rows[0];
    if (!row) throw bad("Attendance not found.", 404);
    await assertOutlet(pool, req.user, row.outlet_id);
    await pool.query(`UPDATE attendance SET check_out = now() WHERE id = $1 AND check_out IS NULL`, [row.id]);
    await log(req.user, row.outlet_id, "check-out", "Checked out", "attendance", row.id);
    res.json({ id: row.id });
  }));

  app.post("/api/shifts", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const label = String(req.body?.label ?? "").trim();
    const startsAt = req.body?.startsAt;
    const endsAt = req.body?.endsAt;
    if (!label || !startsAt || !endsAt) throw bad("Name, start, and end are required.");
    const startMs = Date.parse(startsAt);
    const endMs = Date.parse(endsAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw bad("End must be after the start.");
    }
    const now = Date.now();
    const status = now >= endMs ? "closed" : now >= startMs ? "open" : "upcoming";
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const requested = Array.isArray(req.body?.staffIds) ? [...new Set(req.body.staffIds.map((id) => String(id)))] : [];
    if (requested.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      throw bad("Pick staff from this outlet.");
    }
    let duties = [];
    if (requested.length) {
      const found = await pool.query(
        `SELECT id FROM users
         WHERE id = ANY($1::uuid[])
           AND settings_id = $2
           AND role IN ('staff', 'manager')
           AND active = true
           AND (outlet_id IS NULL OR outlet_id = $3)`,
        [requested, outlet.settings_id, outlet.id],
      );
      if (found.rows.length !== requested.length) throw bad("Pick staff from this outlet.");
      duties = found.rows.map((row) => ({
        id: crypto.randomUUID(),
        userId: row.id,
        nozzleId: null,
        windowStart: startIso,
        windowEnd: endIso,
        checkedOutAt: null,
      }));
    }
    const { rows } = await pool.query(
      `INSERT INTO shifts (outlet_id, label, starts_at, ends_at, status, duties)
       VALUES ($1, $2, $3, $4, $5::shift_status, $6::jsonb)
       RETURNING id`,
      [outlet.id, label, startIso, endIso, status, JSON.stringify(duties)],
    );
    await log(req.user, outlet.id, "shift", `Opened ${label}`, "shifts", rows[0].id);
    res.status(201).json({ id: rows[0].id, staffIds: duties.map((duty) => duty.userId) });
  }));

  app.delete("/api/shifts/:id", wrap(async (req, res) => {
    const found = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [req.params.id]);
    const shift = found.rows[0];
    if (!shift) throw bad("Shift not found.", 404);
    await assertOutlet(pool, req.user, shift.outlet_id);
    const used = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM sales WHERE shift_id = $1) +
         (SELECT count(*)::int FROM expenses WHERE shift_id = $1) +
         (SELECT count(*)::int FROM dip_readings WHERE shift_id = $1) +
         (SELECT count(*)::int FROM documents WHERE shift_id = $1) +
         (SELECT count(*)::int FROM purchases WHERE shift_id = $1) +
         (SELECT count(*)::int FROM banking WHERE shift_id = $1) AS n`,
      [shift.id],
    );
    if (Number(used.rows[0].n) > 0) {
      throw bad("This shift has sales, expenses, or readings, so it stays.");
    }
    await pool.query(`DELETE FROM shifts WHERE id = $1`, [shift.id]);
    await log(req.user, shift.outlet_id, "shift", `Removed ${shift.label}`, "shifts", shift.id);
    res.json({ id: shift.id });
  }));

  app.patch("/api/shifts/:id", wrap(async (req, res) => {
    const found = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [req.params.id]);
    const shift = found.rows[0];
    if (!shift) throw bad("Shift not found.", 404);
    await assertOutlet(pool, req.user, shift.outlet_id);
    const body = req.body ?? {};
    let duties = Array.isArray(shift.duties) ? shift.duties : [];
    if (body.assign?.partyId && Array.isArray(body.assign.nozzleIds)) {
      duties = duties.filter((duty) => duty.userId !== body.assign.partyId);
      for (const nozzleId of body.assign.nozzleIds) {
        duties.push({
          id: crypto.randomUUID(),
          userId: body.assign.partyId,
          nozzleId,
          windowStart: body.assign.windowStart || shift.starts_at,
          windowEnd: body.assign.windowEnd || shift.ends_at,
          checkedOutAt: null,
        });
      }
    }
    if (body.checkoutPartyId) {
      const at = new Date().toISOString();
      duties = duties.map((duty) => duty.userId === body.checkoutPartyId && !duty.checkedOutAt ? { ...duty, checkedOutAt: at } : duty);
      await pool.query(
        `UPDATE attendance SET check_out = now() WHERE user_id = $1 AND outlet_id = $2 AND check_out IS NULL`,
        [body.checkoutPartyId, shift.outlet_id],
      );
    }
    const status = ["upcoming", "open", "closed"].includes(body.status) ? body.status : shift.status;
    const label = String(body.label ?? "").trim() || shift.label;
    const startsAt = body.startsAt ? new Date(body.startsAt).toISOString() : shift.starts_at;
    const endsAt = body.endsAt ? new Date(body.endsAt).toISOString() : shift.ends_at;
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw bad("End must be after the start.");
    await pool.query(
      `UPDATE shifts SET
         label = $2,
         starts_at = $3,
         ends_at = $4,
         status = $5::shift_status,
         declared_cash = COALESCE($6, declared_cash),
         closed_by = COALESCE($7, closed_by),
         approved_by = COALESCE($8, approved_by),
         unlock_reason = COALESCE($9, unlock_reason),
         investigation = COALESCE($10::investigation_status, investigation),
         investigation_note = COALESCE($11, investigation_note),
         duties = $12::jsonb
       WHERE id = $1`,
      [
        shift.id,
        label,
        startsAt,
        endsAt,
        status,
        body.declaredCash == null ? null : money(body.declaredCash),
        body.closedBy || null,
        body.approvedBy || null,
        body.unlockReason || null,
        body.investigation && ["open", "proof_requested", "resolved"].includes(body.investigation) ? body.investigation : null,
        body.investigationNote || null,
        JSON.stringify(duties),
      ],
    );
    await log(req.user, shift.outlet_id, "shift", body.detail || `Shift ${status}`, "shifts", shift.id);
    res.json({ id: shift.id });
  }));

  app.patch("/api/dealer", wrap(async (req, res) => {
    if (req.body?.auditorCanFileFindings != null) {
      await pool.query(
        `UPDATE settings SET auditor_can_file_findings = $2 WHERE id = $1`,
        [req.user.settings_id, Boolean(req.body.auditorCanFileFindings)],
      );
    }
    if (req.body?.schedule?.name) {
      await pool.query(
        `UPDATE settings SET schedules = schedules || $2::jsonb WHERE id = $1`,
        [req.user.settings_id, JSON.stringify([{ name: req.body.schedule.name, cadence: req.body.schedule.cadence || "" }])],
      );
    }
    await log(req.user, req.user.outlet_id, "settings", "Dealer settings updated", "settings", req.user.settings_id);
    res.json({ ok: true });
  }));

  app.post("/api/activity", wrap(async (req, res) => {
    const outletId = req.body?.outletId || null;
    if (outletId) await assertOutlet(pool, req.user, outletId);
    const action = String(req.body?.action ?? "").trim();
    if (!action) throw bad("Action is required.");
    const { rows } = await pool.query(
      `INSERT INTO activity (outlet_id, actor_id, action, detail, target_table, target_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [outletId, req.user.id, action, req.body?.detail || null, req.body?.targetTable || null, req.body?.targetId || null, req.body?.status || null],
    );
    res.status(201).json({ id: rows[0].id });
  }));
}
