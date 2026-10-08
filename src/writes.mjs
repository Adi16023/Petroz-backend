import bcrypt from "bcryptjs";
import { syncDeskEquipment } from "./desk-equipment.mjs";
import { registerShiftEntry } from "./shift-entry.mjs";

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

function uuidList(value) {
  const ids = Array.isArray(value) ? [...new Set(value.map((id) => String(id)))] : [];
  const valid = ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  return valid ? ids : null;
}

function round2(value) {
  if (!Number.isFinite(value)) return 0;
  const negative = value < 0;
  const [whole, fraction = ""] = Math.abs(value).toFixed(8).split(".");
  const digits = `${fraction}000`.slice(0, 3);
  let paise = Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) paise += 1;
  let rupees = Number(whole);
  if (paise >= 100) {
    rupees += 1;
    paise -= 100;
  }
  const rounded = rupees + paise / 100;
  return negative ? -rounded : rounded;
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

function deskText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function deskAddress(basic) {
  const line = deskText(basic?.address);
  const place = [deskText(basic?.city), deskText(basic?.state)].filter(Boolean).join(", ");
  const tail = [place, deskText(basic?.pincode)].filter(Boolean).join(" - ");
  if (!tail) return line;
  if (!line) return tail;
  return `${line}, ${tail}`;
}

async function applyOutletFromDesk(pool, outlet, desk, bad) {
  const basic = desk?.basic && typeof desk.basic === "object" ? desk.basic : {};
  const invoice = desk?.invoice && typeof desk.invoice === "object" ? desk.invoice : {};
  const name = deskText(basic.outletName);
  const code = deskText(basic.code);
  const phone = deskText(basic.phone) || deskText(invoice.phone);
  const address = deskAddress(basic) || deskText(invoice.address);
  const gstin = deskText(invoice.gstin);
  if (code && code !== outlet.code) {
    const taken = await pool.query(
      `SELECT id FROM outlets WHERE settings_id = $1 AND code = $2 AND id <> $3 LIMIT 1`,
      [outlet.settings_id, code, outlet.id],
    );
    if (taken.rows.length) throw bad("That outlet code is already used.");
  }
  if (name || code || phone || address || gstin) {
    await pool.query(
      `UPDATE outlets SET
         name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
         code = CASE WHEN $3 <> '' THEN $3 ELSE code END,
         phone = CASE WHEN $4 <> '' THEN $4 ELSE phone END,
         address = CASE WHEN $5 <> '' THEN $5 ELSE address END,
         gstin = CASE WHEN $6 <> '' THEN $6 ELSE gstin END
       WHERE id = $1`,
      [outlet.id, name, code, phone, address, gstin],
    );
  }
  const dealerName = deskText(basic.dealerName);
  const email = deskText(basic.email);
  if (dealerName || email) {
    await pool.query(
      `UPDATE users SET
         name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
         email = CASE WHEN $3 <> '' THEN $3 ELSE email END
       WHERE settings_id = $1 AND role = 'owner'`,
      [outlet.settings_id, dealerName, email],
    );
  }
}

export function registerWrites(app, { pool, wrap, bad, assertOutlet }) {
  async function log(user, outletId, action, detail, targetTable, targetId) {
    await pool.query(
      `INSERT INTO activity (outlet_id, actor_id, action, detail, target_table, target_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [outletId, user.id, action, detail ?? null, targetTable ?? null, targetId ?? null],
    );
  }

  async function takeEmployeeCode(settingsId, code, exceptId) {
    const value = String(code ?? "").trim();
    if (!value) return null;
    const taken = await pool.query(
      `SELECT id FROM users
       WHERE settings_id = $1
         AND lower(employee_code) = lower($2)
         AND ($3::uuid IS NULL OR id <> $3)
       LIMIT 1`,
      [settingsId, value, exceptId ?? null],
    );
    if (taken.rows.length) throw bad("That employee ID is already used.");
    return value;
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
    const isAdvance = kind === "payment" && req.body?.category === "advance";
    if (kind === "expense" || isAdvance) {
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
    const employeeCode = await takeEmployeeCode(outlet.settings_id, req.body?.employeeCode);
    const { rows } = await pool.query(
      `INSERT INTO users (
         settings_id, outlet_id, role, name, phone, alt_phone, email, address, gstin,
         customer_type, vehicle, credit_limit, credit_period_days, credit_status, designation,
         staff_type, password_hash, bank_name, account_no, employee_code
       ) VALUES ($1,$2,$3::user_role,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'clear',$14,$15::staff_type,$16,$17,$18,$19)
       RETURNING id`,
      [
        outlet.settings_id, outlet.id, role, name, req.body?.phone || null, req.body?.altPhone || null,
        req.body?.email || null, req.body?.address || null, req.body?.gstin || null, req.body?.customerType || null,
        req.body?.vehicle || null, req.body?.creditLimit == null ? null : money(req.body.creditLimit),
        req.body?.creditPeriodDays == null ? null : Number(req.body.creditPeriodDays) || null,
        designation, staffType, passwordHash, req.body?.bankName || null, req.body?.accountNo || null,
        employeeCode,
      ],
    );
    const id = rows[0].id;
    await log(req.user, outlet.id, "created", name, "users", id);
    res.status(201).json({ id, canSignIn: role === "staff" || role === "manager" });
  }));

  app.patch("/api/parties/:id", wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, outlet_id, settings_id, role FROM users WHERE id = $1 AND ($2::uuid IS NULL OR settings_id = $2)`,
      [req.params.id, req.user.role === "super_admin" ? null : req.user.settings_id],
    );
    const row = rows[0];
    if (!row) throw bad("Party not found.", 404);
    if (row.outlet_id) await assertOutlet(pool, req.user, row.outlet_id);
    const touchesCode = req.body != null && Object.prototype.hasOwnProperty.call(req.body, "employeeCode");
    let employeeCode = null;
    if (touchesCode) {
      if (!["owner", "super_admin", "manager"].includes(req.user.role)) throw bad("You cannot edit the employee ID.", 403);
      if (!["staff", "manager"].includes(row.role)) throw bad("Employee ID is for staff.");
      employeeCode = await takeEmployeeCode(row.settings_id, req.body.employeeCode, row.id);
    }
    const body = req.body ?? {};
    const touchesProfile = ["name", "phone", "email", "address", "active", "designation", "staffType"].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key),
    );
    if (touchesProfile) {
      if (!["owner", "super_admin"].includes(req.user.role)) throw bad("You cannot edit staff.", 403);
      const name = String(body.name ?? "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "name") && !name) throw bad("Name is required.");
      let staffType = null;
      if (Object.prototype.hasOwnProperty.call(body, "staffType")) {
        staffType = String(body.staffType ?? "").trim();
        if (staffType && !STAFF_TYPES.includes(staffType)) throw bad("Pick a staff type.");
      }
      await pool.query(
        `UPDATE users SET
           name = CASE WHEN $2 THEN $3 ELSE name END,
           phone = CASE WHEN $4 THEN $5 ELSE phone END,
           email = CASE WHEN $6 THEN $7 ELSE email END,
           address = CASE WHEN $8 THEN $9 ELSE address END,
           active = CASE WHEN $10 THEN $11 ELSE active END,
           designation = CASE WHEN $12 THEN $13 ELSE designation END,
           staff_type = CASE WHEN $14 THEN $15::staff_type ELSE staff_type END,
           role = CASE WHEN $16 THEN $17::user_role ELSE role END
         WHERE id = $1`,
        [
          row.id,
          Object.prototype.hasOwnProperty.call(body, "name"),
          name,
          Object.prototype.hasOwnProperty.call(body, "phone"),
          String(body.phone ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "email"),
          String(body.email ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "address"),
          String(body.address ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "active"),
          body.active !== false,
          Object.prototype.hasOwnProperty.call(body, "designation"),
          String(body.designation ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "staffType"),
          staffType || null,
          body.role === "manager" || body.role === "staff",
          body.role === "manager" ? "manager" : "staff",
        ],
      );
    }
    await pool.query(
      `UPDATE users SET
         permission_grants = COALESCE($2::text[], permission_grants),
         permission_revokes = COALESCE($3::text[], permission_revokes),
         manager_can_assign = COALESCE($4, manager_can_assign),
         employee_code = CASE WHEN $5 THEN $6 ELSE employee_code END
       WHERE id = $1`,
      [
        row.id,
        Array.isArray(req.body?.permissionGrants) ? req.body.permissionGrants : null,
        Array.isArray(req.body?.permissionRevokes) ? req.body.permissionRevokes : null,
        req.body?.managerCanAssign == null ? null : Boolean(req.body.managerCanAssign),
        touchesCode,
        employeeCode,
      ],
    );
    await log(
      req.user,
      row.outlet_id,
      touchesCode && !Array.isArray(req.body?.permissionGrants) ? "updated" : "permission",
      touchesCode && !Array.isArray(req.body?.permissionGrants)
        ? `Employee ID ${employeeCode || "cleared"}`
        : (req.body?.detail || "Permissions updated"),
      "users",
      row.id,
    );
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
    const used = await pool.query(
      `SELECT 1 FROM equipment WHERE product_id = $1
       UNION ALL SELECT 1 FROM sale_items WHERE product_id = $1
       UNION ALL SELECT 1 FROM purchase_items WHERE product_id = $1
       UNION ALL SELECT 1 FROM document_items WHERE product_id = $1
       LIMIT 1`,
      [req.params.id],
    );
    if (used.rows.length) throw bad("This product is already used. Turn it off instead of removing it.");
    await pool.query(`DELETE FROM balances WHERE product_id = $1 AND outlet_id = $2`, [req.params.id, outlet.id]);
    await pool.query(`DELETE FROM products WHERE id = $1 AND settings_id = $2`, [req.params.id, req.user.settings_id]);
    await log(req.user, outlet.id, "deleted", req.body?.reason || "Product removed", "products", req.params.id);
    res.json({ id: req.params.id, deleted: true });
  }));

  app.patch("/api/products/:id", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const product = await pool.query(
      `SELECT id FROM products WHERE id = $1 AND settings_id = $2`,
      [req.params.id, outlet.settings_id],
    );
    if (!product.rows[0]) throw bad("Product not found.", 404);
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(body, "name") && !name) throw bad("Product name is required.");
    await pool.query(
      `UPDATE products SET
         name = CASE WHEN $2 THEN $3 ELSE name END,
         unit = CASE WHEN $4 THEN $5 ELSE unit END,
         gst = CASE WHEN $6 THEN $7 ELSE gst END,
         purchase_price = CASE WHEN $8 THEN $9 ELSE purchase_price END,
         selling_price = CASE WHEN $10 THEN $11 ELSE selling_price END,
         active = CASE WHEN $12 THEN $13 ELSE active END
       WHERE id = $1`,
      [
        req.params.id,
        Object.prototype.hasOwnProperty.call(body, "name"),
        name,
        Object.prototype.hasOwnProperty.call(body, "unit"),
        String(body.unit ?? "").trim() || null,
        Object.prototype.hasOwnProperty.call(body, "gst"),
        money(body.gst),
        Object.prototype.hasOwnProperty.call(body, "purchasePrice"),
        money(body.purchasePrice),
        Object.prototype.hasOwnProperty.call(body, "sellingPrice"),
        money(body.sellingPrice),
        Object.prototype.hasOwnProperty.call(body, "active"),
        body.active !== false,
      ],
    );
    await log(req.user, outlet.id, "updated", name || "Product updated", "products", req.params.id);
    res.json({ id: req.params.id });
  }));

  async function fuelProduct(settingsId, name) {
    const label = String(name ?? "").trim();
    if (!label || label.toLowerCase() === "not assigned") return null;
    const found = await pool.query(
      `SELECT id FROM products WHERE settings_id = $1 AND kind = 'fuel' AND lower(name) = lower($2) ORDER BY created_at LIMIT 1`,
      [settingsId, label],
    );
    if (found.rows[0]) return found.rows[0].id;
    const created = await pool.query(
      `INSERT INTO products (settings_id, kind, name, unit, gst, purchase_price, selling_price)
       VALUES ($1, 'fuel', $2, $3, 0, 0, 0)
       RETURNING id`,
      [settingsId, label, label.toLowerCase() === "cng" ? "Kg" : "Litre"],
    );
    return created.rows[0].id;
  }

  function stockKl(fuel, litres) {
    const amount = money(litres);
    const key = String(fuel ?? "").trim().toLowerCase();
    if (["petrol", "diesel", "power", "ms", "hsd"].includes(key)) return amount / 1000;
    return amount;
  }

  app.post("/api/equipment", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const kind = req.body?.kind === "nozzle" ? "nozzle" : req.body?.kind === "tank" ? "tank" : "";
    if (!kind) throw bad("Unknown equipment kind.");
    const label = String(req.body?.label ?? "").trim();
    if (!label) throw bad("Name is required.");
    const fuel = String(req.body?.productName ?? "").trim();
    const productId = await fuelProduct(outlet.settings_id, fuel);
    let parentId = null;
    if (kind === "nozzle") {
      parentId = req.body?.parentId || null;
      if (!parentId && productId) {
        const tank = await pool.query(
          `SELECT id FROM equipment WHERE outlet_id = $1 AND kind = 'tank' AND product_id = $2 ORDER BY label LIMIT 1`,
          [outlet.id, productId],
        );
        parentId = tank.rows[0]?.id ?? null;
      }
      if (!parentId) {
        const created = await pool.query(
          `INSERT INTO equipment (outlet_id, product_id, kind, label, capacity, live_qty)
           VALUES ($1, $2, 'tank', $3, 0, 0)
           RETURNING id`,
          [outlet.id, productId, fuel || label],
        );
        parentId = created.rows[0].id;
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO equipment (outlet_id, parent_id, product_id, kind, label, capacity, live_qty, meter, pump_name, active, dip_method)
       VALUES ($1, $2, $3, $4::equipment_kind, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        outlet.id,
        parentId,
        productId,
        kind,
        label,
        kind === "tank" ? stockKl(fuel, req.body?.capacityLitres) : null,
        kind === "tank" ? stockKl(fuel, req.body?.liveLitres) : 0,
        req.body?.meter == null || req.body?.meter === "" ? 0 : money(req.body.meter),
        req.body?.pumpName || null,
        req.body?.active !== false,
        req.body?.dipMethod || null,
      ],
    );
    await log(req.user, outlet.id, "created", label, "equipment", rows[0].id);
    res.status(201).json({ id: rows[0].id });
  }));

  app.delete("/api/equipment/:id", wrap(async (req, res) => {
    const found = await pool.query(`SELECT id, outlet_id, label FROM equipment WHERE id = $1`, [req.params.id]);
    const row = found.rows[0];
    if (!row) throw bad("Equipment not found.", 404);
    await assertOutlet(pool, req.user, row.outlet_id);
    const used = await pool.query(
      `SELECT 1 FROM dip_readings WHERE equipment_id = $1
       UNION ALL SELECT 1 FROM sale_items WHERE equipment_id = $1
       UNION ALL SELECT 1 FROM purchase_items WHERE equipment_id = $1
       UNION ALL SELECT 1 FROM document_items WHERE equipment_id = $1
       UNION ALL SELECT 1 FROM equipment WHERE parent_id = $1
       LIMIT 1`,
      [row.id],
    );
    if (used.rows.length) throw bad("This is already used on the desk. Turn it off instead of removing it.");
    await pool.query(`DELETE FROM equipment WHERE id = $1`, [row.id]);
    await log(req.user, row.outlet_id, "deleted", row.label, "equipment", row.id);
    res.json({ id: row.id, deleted: true });
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
    const body = req.body ?? {};
    const profile = ["label", "productName", "capacityLitres", "liveLitres", "meter", "pumpName", "active", "dipMethod"].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key),
    );
    if (profile) {
      const current = await pool.query(
        `SELECT e.product_id, pr.name AS product_name
         FROM equipment e
         LEFT JOIN products pr ON pr.id = e.product_id
         WHERE e.id = $1`,
        [row.id],
      );
      const fuel = Object.prototype.hasOwnProperty.call(body, "productName")
        ? String(body.productName ?? "").trim()
        : current.rows[0]?.product_name ?? "";
      const home = await pool.query(`SELECT settings_id FROM outlets WHERE id = $1`, [row.outlet_id]);
      const productId = Object.prototype.hasOwnProperty.call(body, "productName")
        ? await fuelProduct(home.rows[0]?.settings_id, fuel)
        : current.rows[0]?.product_id ?? null;
      await pool.query(
        `UPDATE equipment SET
           label = CASE WHEN $2 THEN $3 ELSE label END,
           product_id = CASE WHEN $4 THEN $5 ELSE product_id END,
           capacity = CASE WHEN $6 THEN $7 ELSE capacity END,
           live_qty = CASE WHEN $8 THEN $9 ELSE live_qty END,
           meter = CASE WHEN $10 THEN $11 ELSE meter END,
           pump_name = CASE WHEN $12 THEN $13 ELSE pump_name END,
           active = CASE WHEN $14 THEN $15 ELSE active END,
           dip_method = CASE WHEN $16 THEN $17 ELSE dip_method END
         WHERE id = $1`,
        [
          row.id,
          Object.prototype.hasOwnProperty.call(body, "label"),
          String(body.label ?? "").trim(),
          Object.prototype.hasOwnProperty.call(body, "productName"),
          productId,
          Object.prototype.hasOwnProperty.call(body, "capacityLitres"),
          stockKl(fuel, body.capacityLitres),
          Object.prototype.hasOwnProperty.call(body, "liveLitres"),
          stockKl(fuel, body.liveLitres),
          Object.prototype.hasOwnProperty.call(body, "meter"),
          money(body.meter),
          Object.prototype.hasOwnProperty.call(body, "pumpName"),
          String(body.pumpName ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "active"),
          body.active !== false,
          Object.prototype.hasOwnProperty.call(body, "dipMethod"),
          String(body.dipMethod ?? "").trim() || null,
        ],
      );
      if (!Object.prototype.hasOwnProperty.call(body, "mm")) {
        await log(req.user, row.outlet_id, "updated", String(body.label ?? "").trim() || "Equipment updated", "equipment", row.id);
        res.json({ id: row.id });
        return;
      }
    }
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
    const requested = uuidList(req.body?.staffIds);
    const cashierIds = uuidList(req.body?.cashierIds);
    const nozzleIds = uuidList(req.body?.nozzleIds);
    if (!requested) throw bad("Pick staff from this outlet.");
    if (!cashierIds) throw bad("Pick cashiers from this outlet.");
    if (!nozzleIds) throw bad("Pick nozzles from this outlet.");
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
    if (cashierIds.length) {
      const found = await pool.query(
        `SELECT id FROM users
         WHERE id = ANY($1::uuid[])
           AND settings_id = $2
           AND staff_type = 'cashier'
           AND active = true
           AND (outlet_id IS NULL OR outlet_id = $3)`,
        [cashierIds, outlet.settings_id, outlet.id],
      );
      if (found.rows.length !== cashierIds.length) throw bad("Pick cashiers from this outlet.");
    }
    if (nozzleIds.length) {
      const found = await pool.query(
        `SELECT id FROM equipment
         WHERE id = ANY($1::uuid[]) AND outlet_id = $2 AND kind = 'nozzle'`,
        [nozzleIds, outlet.id],
      );
      if (found.rows.length !== nozzleIds.length) throw bad("Pick nozzles from this outlet.");
    }
    const { rows } = await pool.query(
      `INSERT INTO shifts (outlet_id, label, starts_at, ends_at, status, duties, entry)
       VALUES ($1, $2, $3, $4, $5::shift_status, $6::jsonb, $7::jsonb)
       RETURNING id`,
      [outlet.id, label, startIso, endIso, status, JSON.stringify(duties), JSON.stringify({ cashierIds, nozzleIds })],
    );
    await log(req.user, outlet.id, "shift", `Opened ${label}`, "shifts", rows[0].id);
    res.status(201).json({ id: rows[0].id, staffIds: duties.map((duty) => duty.userId) });
  }));

  app.delete("/api/shifts/:id", wrap(async (req, res) => {
    const found = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [req.params.id]);
    const shift = found.rows[0];
    if (!shift) throw bad("Shift not found.", 404);
    await assertOutlet(pool, req.user, shift.outlet_id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE shift_id = $1)`, [shift.id]);
      await client.query(`DELETE FROM sales WHERE shift_id = $1`, [shift.id]);
      await client.query(`DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE shift_id = $1)`, [shift.id]);
      await client.query(`DELETE FROM purchases WHERE shift_id = $1`, [shift.id]);
      await client.query(`DELETE FROM document_items WHERE document_id IN (SELECT id FROM documents WHERE shift_id = $1)`, [shift.id]);
      await client.query(
        `UPDATE documents SET parent_id = NULL WHERE parent_id IN (SELECT id FROM documents WHERE shift_id = $1)`,
        [shift.id],
      );
      await client.query(`DELETE FROM documents WHERE shift_id = $1`, [shift.id]);
      await client.query(`DELETE FROM expenses WHERE shift_id = $1`, [shift.id]);
      await client.query(`DELETE FROM banking WHERE shift_id = $1`, [shift.id]);
      await client.query(`DELETE FROM dip_readings WHERE shift_id = $1`, [shift.id]);
      await client.query(`DELETE FROM shifts WHERE id = $1`, [shift.id]);
      await client.query(
        `INSERT INTO activity (outlet_id, actor_id, action, detail, target_table, target_id)
         VALUES ($1, $2, 'deleted', $3, 'shifts', $4)`,
        [shift.outlet_id, req.user.id, `Removed ${shift.label} and its records`, shift.id],
      );
      await client.query("COMMIT");
      res.json({ id: shift.id });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  function storedImage(value, label) {
    if (value == null || value === "") return null;
    const text = String(value);
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text)) {
      throw bad(`${label} needs a PNG or JPG.`);
    }
    if (text.length > 700_000) throw bad(`${label} is too large. Use the size shown on Settings.`);
    return text;
  }

  function billLines(body) {
    const fuels = ["Petrol", "Diesel", "Power"];
    const raw = Array.isArray(body?.lines) ? body.lines : [];
    const lines = raw.map((line) => {
      const fuel = fuels.includes(line?.fuel) ? line.fuel : "";
      const qty = money(line?.qty);
      const rate = money(line?.rate);
      const discount = money(line?.discount);
      if (!fuel) throw bad("Pick a fuel type.");
      if (!(qty > 0)) throw bad("Enter the litres.");
      if (rate < 0 || discount < 0) throw bad("Rate and discount stay at zero or above.");
      const amount = Math.max(0, round2(qty * rate - discount));
      return { fuel, qty, rate, discount, amount };
    });
    if (!lines.length) throw bad("Add a fuel line.");
    return lines;
  }

  function billDto(row) {
    return {
      id: row.id,
      outletId: row.outlet_id,
      billNo: row.bill_no,
      billedAt: row.billed_at,
      customerName: row.customer_name,
      vehicleNo: row.vehicle_no,
      mobile: row.mobile,
      paymentMode: row.payment_mode,
      pumpNozzle: row.pump_nozzle,
      attendant: row.attendant,
      lines: row.lines ?? [],
      total: Number(row.total) || 0,
    };
  }

  async function nextBillNo(outlet) {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(NULLIF(split_part(bill_no, '-', 2), '')::int), 0) + 1 AS n
       FROM billing WHERE outlet_id = $1`,
      [outlet.id],
    );
    const n = Math.max(rows[0].n, Number(outlet.next_bill_no) || 1);
    return { n, label: `${outlet.code}-${String(n).padStart(5, "0")}` };
  }

  app.get("/api/billing", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.query.outletId);
    const { rows } = await pool.query(
      `SELECT * FROM billing WHERE outlet_id = $1 ORDER BY billed_at DESC LIMIT 200`,
      [outlet.id],
    );
    const { rows: brand } = await pool.query(
      `SELECT company_image, banner_image FROM settings WHERE id = $1`,
      [outlet.settings_id],
    );
    const next = await nextBillNo(outlet);
    res.json({
      stationName: outlet.name,
      address: outlet.address || "",
      phone: outlet.phone || "",
      gstin: outlet.gstin || "",
      ownerWhatsapp: outlet.owner_whatsapp || "",
      nextBillNumber: next.n,
      nextBillNo: next.label,
      bill: outlet.bill && typeof outlet.bill === "object" ? outlet.bill : {},
      companyImage: brand[0]?.company_image || null,
      bannerImage: brand[0]?.banner_image || null,
      bills: rows.map(billDto),
    });
  }));

  app.post("/api/billing", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const lines = billLines(req.body);
    const modes = ["Cash", "UPI", "Card", "Credit"];
    const paymentMode = modes.includes(req.body?.paymentMode) ? req.body.paymentMode : "Cash";
    const billedAt = req.body?.billedAt ? new Date(req.body.billedAt) : new Date();
    if (Number.isNaN(billedAt.getTime())) throw bad("Pick a date and time.");
    const total = round2(lines.reduce((sum, line) => sum + line.amount, 0));
    const next = await nextBillNo(outlet);
    const billNo = next.label;
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO billing (
           settings_id, outlet_id, bill_no, billed_at, customer_name, vehicle_no, mobile,
           payment_mode, pump_nozzle, attendant, lines, total, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         RETURNING *`,
        [
          outlet.settings_id,
          outlet.id,
          billNo,
          billedAt.toISOString(),
          String(req.body?.customerName ?? "").trim() || null,
          String(req.body?.vehicleNo ?? "").trim() || null,
          String(req.body?.mobile ?? "").trim() || null,
          paymentMode,
          String(req.body?.pumpNozzle ?? "").trim() || null,
          String(req.body?.attendant ?? "").trim() || null,
          JSON.stringify(lines),
          total,
          req.user.id,
        ],
      ));
    } catch (error) {
      if (error.code === "23505") throw bad("That bill number was just used. Save again.");
      throw error;
    }
    await pool.query(`UPDATE outlets SET next_bill_no = $2 WHERE id = $1`, [outlet.id, next.n + 1]);
    await log(req.user, outlet.id, "created", `Bill ${billNo}`, "billing", rows[0].id);
    const following = await nextBillNo({ ...outlet, next_bill_no: next.n + 1 });
    res.status(201).json({ bill: billDto(rows[0]), nextBillNo: following.label });
  }));

  const FUEL_BRANDS = ["iocl", "bpcl", "hpcl", "nayara", "jio-bp", "shell", "reliance", "mrpl"];

  app.post("/api/outlets", wrap(async (req, res) => {
    if (req.user.role !== "owner" && req.user.role !== "super_admin") {
      throw bad("The dealer adds outlets.", 403);
    }
    const settingsId = req.user.settings_id;
    if (!settingsId) throw bad("Pick a dealer first.");
    const name = String(req.body?.name ?? "").trim();
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    const phone = String(req.body?.phone ?? "").trim();
    const address = String(req.body?.address ?? "").trim();
    if (!name) throw bad("Outlet name is required.");
    if (!code) throw bad("Outlet code is required.");
    const taken = await pool.query(
      `SELECT id FROM outlets WHERE settings_id = $1 AND lower(code) = lower($2) LIMIT 1`,
      [settingsId, code],
    );
    if (taken.rows.length) throw bad("That outlet code is already used.");
    const { rows } = await pool.query(
      `INSERT INTO outlets (settings_id, name, code, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, code, address, phone, brand`,
      [settingsId, name, code, phone || null, address || null],
    );
    const outlet = rows[0];
    await log(req.user, outlet.id, "created", name, "outlets", outlet.id);
    res.status(201).json({
      id: outlet.id,
      name: outlet.name,
      code: outlet.code,
      address: outlet.address,
      phone: outlet.phone,
      brand: outlet.brand,
    });
  }));

  app.patch("/api/outlets/:id", wrap(async (req, res) => {
    const body = req.body ?? {};
    const touchesBrand = Object.prototype.hasOwnProperty.call(body, "brand");
    const stationKeys = ["name", "code", "address", "phone", "gstin", "ownerWhatsapp", "nextBillNo"];
    const profileKeys = ["city", "state", "pincode", "businessType", "opensAt", "closesAt", "openDays", "bill", "messages", "dealerName", "email"];
    const touchesStation = stationKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
    const touchesProfile = profileKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (!touchesBrand && !touchesStation && !touchesProfile) throw bad("Nothing to save.");
    if (touchesBrand && req.user.role !== "owner" && req.user.role !== "super_admin") {
      throw bad("The dealer sets the company.", 403);
    }
    if (touchesStation && !["owner", "super_admin", "manager"].includes(req.user.role)) {
      throw bad("The dealer saves the bill settings.", 403);
    }
    const outlet = await assertOutlet(pool, req.user, req.params.id);
    let brand = null;
    if (touchesBrand) {
      brand = String(body.brand ?? "").trim();
      if (brand && !FUEL_BRANDS.includes(brand)) throw bad("Pick a company from the list.");
    }
    const name = String(body.name ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(body, "name") && !name) throw bad("Station name is required.");
    const code = String(body.code ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(body, "code") && !code) throw bad("Outlet code is required.");
    if (code) {
      const taken = await pool.query(
        `SELECT id FROM outlets WHERE settings_id = $1 AND code = $2 AND id <> $3 LIMIT 1`,
        [outlet.settings_id, code, outlet.id],
      );
      if (taken.rows.length) throw bad("That outlet code is already used.");
    }
    let nextNo = null;
    if (Object.prototype.hasOwnProperty.call(body, "nextBillNo")) {
      nextNo = Math.round(Number(body.nextBillNo));
      if (!Number.isFinite(nextNo) || nextNo < 1) throw bad("Next bill number starts at 1.");
    }
    await pool.query(
      `UPDATE outlets SET
         brand = CASE WHEN $2 THEN $3 ELSE brand END,
         name = CASE WHEN $4 THEN $5 ELSE name END,
         code = CASE WHEN $6 THEN $7 ELSE code END,
         address = CASE WHEN $8 THEN $9 ELSE address END,
         phone = CASE WHEN $10 THEN $11 ELSE phone END,
         gstin = CASE WHEN $12 THEN $13 ELSE gstin END,
         owner_whatsapp = CASE WHEN $14 THEN $15 ELSE owner_whatsapp END,
         next_bill_no = CASE WHEN $16 THEN $17 ELSE next_bill_no END
       WHERE id = $1`,
      [
        outlet.id,
        touchesBrand,
        brand,
        Object.prototype.hasOwnProperty.call(body, "name"),
        name,
        Object.prototype.hasOwnProperty.call(body, "code"),
        code,
        Object.prototype.hasOwnProperty.call(body, "address"),
        String(body.address ?? "").trim() || null,
        Object.prototype.hasOwnProperty.call(body, "phone"),
        String(body.phone ?? "").trim() || null,
        Object.prototype.hasOwnProperty.call(body, "gstin"),
        String(body.gstin ?? "").trim() || null,
        Object.prototype.hasOwnProperty.call(body, "ownerWhatsapp"),
        String(body.ownerWhatsapp ?? "").trim() || null,
        nextNo != null,
        nextNo,
      ],
    );
    if (touchesProfile) {
      const days = Array.isArray(body.openDays) ? body.openDays.slice(0, 7).map((day) => day === true) : [];
      while (days.length < 7) days.push(false);
      const bill = body.bill && typeof body.bill === "object" && !Array.isArray(body.bill) ? body.bill : {};
      const messages = body.messages && typeof body.messages === "object" && !Array.isArray(body.messages) ? body.messages : {};
      await pool.query(
        `UPDATE outlets SET
           city = CASE WHEN $2 THEN $3 ELSE city END,
           state = CASE WHEN $4 THEN $5 ELSE state END,
           pincode = CASE WHEN $6 THEN $7 ELSE pincode END,
           business_type = CASE WHEN $8 THEN $9 ELSE business_type END,
           opens_at = CASE WHEN $10 THEN $11 ELSE opens_at END,
           closes_at = CASE WHEN $12 THEN $13 ELSE closes_at END,
           open_days = CASE WHEN $14 THEN $15::jsonb ELSE open_days END,
           bill = CASE WHEN $16 THEN $17::jsonb ELSE bill END,
           messages = CASE WHEN $18 THEN $19::jsonb ELSE messages END
         WHERE id = $1`,
        [
          outlet.id,
          Object.prototype.hasOwnProperty.call(body, "city"),
          String(body.city ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "state"),
          String(body.state ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "pincode"),
          String(body.pincode ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "businessType"),
          String(body.businessType ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "opensAt"),
          String(body.opensAt ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "closesAt"),
          String(body.closesAt ?? "").trim() || null,
          Object.prototype.hasOwnProperty.call(body, "openDays"),
          JSON.stringify(days),
          Object.prototype.hasOwnProperty.call(body, "bill"),
          JSON.stringify(bill),
          Object.prototype.hasOwnProperty.call(body, "messages"),
          JSON.stringify(messages),
        ],
      );
      const dealerName = String(body.dealerName ?? "").trim();
      const email = String(body.email ?? "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "dealerName") || Object.prototype.hasOwnProperty.call(body, "email")) {
        await pool.query(
          `UPDATE users SET
             name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
             email = CASE WHEN $3 <> '' THEN $3 ELSE email END
           WHERE settings_id = $1 AND role = 'owner'`,
          [outlet.settings_id, dealerName, email],
        );
      }
    }
    await log(req.user, outlet.id, "updated", touchesStation || touchesProfile ? "Outlet saved" : (brand ? `Company set to ${brand}` : "Company cleared"), "outlets", outlet.id);
    res.json({ id: outlet.id, brand: touchesBrand ? brand || null : outlet.brand ?? null });
  }));

  app.put("/api/outlets/:id/nozzles", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.params.id);
    if (!["owner", "super_admin"].includes(req.user.role)) throw bad("The dealer saves pumps.", 403);
    const pumps = Array.isArray(req.body?.pumps) ? req.body.pumps : null;
    if (!pumps) throw bad("Pumps are required.");
    await syncDeskEquipment(pool, {
      settingsId: outlet.settings_id,
      outletId: outlet.id,
      desk: { pumps },
      scope: { fuels: false, tanks: false, pumps: true },
    });
    await log(req.user, outlet.id, "updated", "Pumps saved", "equipment", outlet.id);
    res.json({ ok: true });
  }));

  app.patch("/api/dealer", wrap(async (req, res) => {
    const hasCompany = req.body != null && Object.prototype.hasOwnProperty.call(req.body, "companyImage");
    const hasBanner = req.body != null && Object.prototype.hasOwnProperty.call(req.body, "bannerImage");
    if (hasCompany || hasBanner) {
      if (req.user.role !== "owner") throw bad("The dealer saves the bill images.", 403);
      if (!req.user.settings_id) throw bad("Pick a dealer first.");
      const company = hasCompany ? storedImage(req.body.companyImage, "Company image") : null;
      const banner = hasBanner ? storedImage(req.body.bannerImage, "Banner image") : null;
      await pool.query(
        `UPDATE settings SET
           company_image = CASE WHEN $2 THEN $3 ELSE company_image END,
           banner_image = CASE WHEN $4 THEN $5 ELSE banner_image END
         WHERE id = $1`,
        [req.user.settings_id, hasCompany, company, hasBanner, banner],
      );
    }
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
    if (req.body?.prefs && typeof req.body.prefs === "object" && !Array.isArray(req.body.prefs)) {
      if (req.user.role !== "owner" && req.user.role !== "super_admin") throw bad("The dealer saves settings.", 403);
      if (!req.user.settings_id) throw bad("Pick a dealer first.");
      await pool.query(`UPDATE settings SET prefs = $2::jsonb WHERE id = $1`, [req.user.settings_id, JSON.stringify(req.body.prefs)]);
    }
    if (req.body != null && Object.prototype.hasOwnProperty.call(req.body, "desk")) {
      if (req.user.role !== "owner" && req.user.role !== "super_admin") {
        throw bad("The dealer saves settings.", 403);
      }
      let settingsId = req.user.settings_id;
      let outlet = null;
      if (req.body.outletId) {
        outlet = await assertOutlet(pool, req.user, req.body.outletId);
        settingsId = outlet.settings_id;
      }
      if (!settingsId) throw bad("Pick a dealer first.");
      const desk = req.body.desk;
      if (!desk || typeof desk !== "object" || Array.isArray(desk)) throw bad("Settings must be an object.");
      const storedDesk = { ...desk };
      for (const key of ["basic", "fuels", "pumps", "tanks", "staff", "payments", "shifts", "invoice", "messages", "preferences"]) {
        delete storedDesk[key];
      }
      const encoded = JSON.stringify(storedDesk);
      if (encoded.length > 500000) throw bad("Settings are too large.");
      if (!outlet) {
        const found = await pool.query(
          `SELECT id, settings_id, code FROM outlets WHERE settings_id = $1 ORDER BY name LIMIT 1`,
          [settingsId],
        );
        outlet = found.rows[0] ?? null;
      }
      if (outlet) {
        await pool.query(`UPDATE outlets SET desk = $2::jsonb WHERE id = $1`, [outlet.id, encoded]);
        await applyOutletFromDesk(pool, outlet, desk, bad);
      } else {
        await pool.query(`UPDATE settings SET desk = $2::jsonb WHERE id = $1`, [settingsId, encoded]);
      }
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

  registerShiftEntry(app, { pool, wrap, bad, assertOutlet, log, money, round2, payMode });
}
