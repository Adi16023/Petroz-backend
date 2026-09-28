import "dotenv/config";
import express from "express";
import cors from "cors";
import { migrate } from "../db/migrate.mjs";
import { createPool } from "../db/pool.mjs";
import { assertOutlet, login, outletIdsFor, requireAuth, signToken } from "./auth.mjs";
import { ensureSeed } from "./seed.mjs";

const DOCUMENT_KINDS = [
  "sale",
  "quote",
  "order",
  "purchase_order",
  "purchase",
  "payment",
  "receipt",
  "transfer",
  "settlement",
  "expense",
  "expense_schedule",
  "salary",
  "adjustment",
  "dsr",
];

const PARTY_ROLES = [
  "owner",
  "manager",
  "staff",
  "credit_customer",
  "auditor",
  "accounts_auditor",
  "supplier",
  "bank",
  "provider",
];

function num(value) {
  if (value == null) return null;
  return Number(value);
}

function inr(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function partyDto(row, extra = {}) {
  return {
    id: row.id,
    dealerId: row.dealer_id,
    role: row.role,
    staffType: row.staff_type,
    name: row.name,
    phone: row.phone,
    altPhone: row.alt_phone,
    email: row.email,
    designation: row.designation,
    permissionGrants: row.permission_grants ?? [],
    permissionRevokes: row.permission_revokes ?? [],
    managerCanAssign: row.manager_can_assign,
    address: row.address,
    gstin: row.gstin,
    customerType: row.customer_type,
    vehicle: row.vehicle,
    creditLimit: num(row.credit_limit),
    creditPeriodDays: row.credit_period_days,
    creditStatus: row.credit_status,
    dnd: row.dnd,
    bankName: row.bank_name,
    accountNo: row.account_no,
    active: row.active,
    outletIds: row.outlet_ids ?? [],
    ...extra,
  };
}

function creditHealth(outstanding, limit) {
  const used = limit > 0 ? outstanding / limit : 0;
  if (used >= 0.85 || outstanding > 80000) return "critical";
  if (used >= 0.45 || outstanding > 20000) return "watch";
  return "healthy";
}

function lineDto(row) {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    equipmentId: row.equipment_id,
    description: row.description,
    qty: num(row.qty),
    rate: num(row.rate),
    amount: num(row.amount),
    qtyReceived: num(row.qty_received),
  };
}

function documentDto(row) {
  return {
    id: row.id,
    outletId: row.outlet_id,
    partyId: row.party_id,
    partyName: row.party_name ?? null,
    counterpartyId: row.counterparty_id,
    shiftId: row.shift_id,
    parentId: row.parent_id,
    kind: row.kind,
    status: row.status,
    docNo: row.doc_no,
    docDate: row.doc_date,
    dueDate: row.due_date,
    amount: num(row.amount),
    tax: num(row.tax),
    charges: num(row.charges),
    net: num(row.net),
    mode: row.mode,
    category: row.category,
    reference: row.reference,
    vehicle: row.vehicle,
    note: row.note,
    frequency: row.frequency,
    nextDue: row.next_due,
    reimbursable: row.reimbursable,
    deductFromShiftCash: row.deduct_from_shift_cash,
    attachment: row.attachment,
    createdBy: row.created_by,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    lines: Array.isArray(row.lines) ? row.lines.map(lineDto) : [],
  };
}

function shiftDto(row) {
  return {
    id: row.id,
    outletId: row.outlet_id,
    label: row.label,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    expectedCash: num(row.expected_cash),
    declaredCash: num(row.declared_cash),
    closedBy: row.closed_by,
    approvedBy: row.approved_by,
    unlockReason: row.unlock_reason,
    investigation: row.investigation,
    investigationNote: row.investigation_note,
  };
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
}

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const pool = createPool();
const auth = requireAuth(pool);

app.post("/api/login", wrap(async (req, res) => {
  const party = await login(pool, req.body?.phone, req.body?.password);
  const outletIds = await outletIdsFor(pool, party);
  res.json({
    token: signToken(party),
    user: partyDto({ ...party, outlet_ids: outletIds }),
  });
}));

app.use("/api", auth);

app.get("/api/me", wrap(async (req, res) => {
  const outletIds = await outletIdsFor(pool, req.user);
  res.json(partyDto({ ...req.user, outlet_ids: outletIds }));
}));

app.get("/api/dealer", wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM dealers WHERE id = $1`, [req.user.dealer_id]);
  const dealer = rows[0];
  if (!dealer) throw bad("Dealer not found.", 404);
  res.json({
    id: dealer.id,
    autoApproveBelow: num(dealer.auto_approve_below),
    varianceAlert: num(dealer.variance_alert),
    auditorCanFileFindings: dealer.auditor_can_file_findings,
    schedules: dealer.schedules ?? [],
  });
}));

app.get("/api/outlets", wrap(async (req, res) => {
  const ids = await outletIdsFor(pool, req.user);
  const { rows } = await pool.query(
    `SELECT id, name, code FROM outlets WHERE id = ANY($1::uuid[]) ORDER BY name`,
    [ids],
  );
  res.json(rows);
}));

app.get("/api/notifications", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const dealer = await pool.query(`SELECT variance_alert FROM dealers WHERE id = $1`, [req.user.dealer_id]);
  const alertAt = num(dealer.rows[0]?.variance_alert) ?? 200;
  const [shifts, attendance, expenses, tanks, credit, deposits, settlements, stock, dips] = await Promise.all([
    pool.query(`SELECT * FROM shifts WHERE outlet_id = $1`, [outlet.id]),
    pool.query(
      `SELECT a.*, p.name FROM attendance a JOIN parties p ON p.id = a.party_id WHERE a.outlet_id = $1`,
      [outlet.id],
    ),
    pool.query(
      `SELECT * FROM documents WHERE outlet_id = $1 AND kind = 'expense' AND status = 'pending'`,
      [outlet.id],
    ),
    pool.query(
      `SELECT * FROM equipment WHERE outlet_id = $1 AND kind = 'tank'`,
      [outlet.id],
    ),
    pool.query(
      `SELECT COALESCE(SUM(net), 0) AS outstanding
       FROM documents
       WHERE outlet_id = $1 AND kind = 'sale' AND mode = 'credit' AND status <> 'cancelled'`,
      [outlet.id],
    ),
    pool.query(
      `SELECT COALESCE(SUM(net), 0) AS deposited
       FROM documents
       WHERE outlet_id = $1 AND kind = 'receipt' AND category = 'cash_deposit'`,
      [outlet.id],
    ),
    pool.query(
      `SELECT category, COALESCE(SUM(amount), 0) AS gross
       FROM documents
       WHERE outlet_id = $1 AND kind = 'settlement' AND status = 'pending'
       GROUP BY category`,
      [outlet.id],
    ),
    pool.query(
      `SELECT pr.name, b.on_hand, b.min_qty
       FROM balances b JOIN products pr ON pr.id = b.product_id
       WHERE b.outlet_id = $1`,
      [outlet.id],
    ),
    pool.query(
      `SELECT r.*, e.label
       FROM readings r JOIN equipment e ON e.id = r.equipment_id
       WHERE e.outlet_id = $1 AND r.kind = 'dip'`,
      [outlet.id],
    ),
  ]);

  const notes = [];
  const open = shifts.rows.find((row) => row.status === "open");
  const onDuty = new Set();
  if (open) {
    const duties = await pool.query(
      `SELECT party_id FROM shift_duties WHERE shift_id = $1 AND checked_out_at IS NULL`,
      [open.id],
    );
    for (const duty of duties.rows) onDuty.add(duty.party_id);
  }

  for (const row of attendance.rows.filter((row) => row.spoof)) {
    notes.push({ id: `spoof-${row.id}`, tone: "bad", text: `${row.name} GPS spoof.`, href: "/attendance" });
  }
  for (const row of attendance.rows.filter((row) => !row.check_out && !onDuty.has(row.party_id))) {
    notes.push({ id: `out-${row.id}`, tone: "warn", text: `${row.name} never checked out.`, href: "/attendance" });
  }
  for (const row of expenses.rows) {
    notes.push({ id: `exp-${row.id}`, tone: "warn", text: `Expense waiting · ${inr(row.amount)}`, href: "/expenses" });
  }
  for (const row of shifts.rows.filter((row) => row.status === "closed")) {
    const variance = num(row.declared_cash) - num(row.expected_cash);
    const short = Math.abs(variance) > alertAt ? ` · cash short ${inr(Math.abs(variance))}` : "";
    notes.push({
      id: `shift-${row.id}`,
      tone: "warn",
      text: `${row.label} shift waiting for approval${short}.`,
      href: "/shifts",
    });
  }
  if (open) {
    notes.push({
      id: "dsr-open-shift",
      tone: "info",
      text: `${open.label} shift still open.`,
      href: "/dsr",
    });
  }
  if (tanks.rows.some((row) => num(row.capacity) > 0 && num(row.live_qty) / num(row.capacity) < 0.4)) {
    notes.push({ id: "dsr-low-tank", tone: "warn", text: "A tank is under 40% — check Dip.", href: "/dip" });
  }
  const outstanding = num(credit.rows[0]?.outstanding);
  if (outstanding > 0) {
    notes.push({ id: "credit-due", tone: "bad", text: `Credit still on the books · ${inr(outstanding)}.`, href: "/credit" });
  }
  const cashSales = await pool.query(
    `SELECT COALESCE(SUM(net), 0) AS cash
     FROM documents
     WHERE outlet_id = $1 AND kind = 'sale' AND mode = 'cash' AND doc_date = CURRENT_DATE AND status <> 'cancelled'`,
    [outlet.id],
  );
  const deposited = num(deposits.rows[0]?.deposited);
  const cash = num(cashSales.rows[0]?.cash);
  if (cash > deposited) {
    notes.push({ id: "bank-deposit-pending", tone: "warn", text: "Cash deposit is short of today's cash sales.", href: "/banking" });
  }
  for (const row of settlements.rows) {
    const label = row.category === "wallet" ? "Wallet" : "POS";
    notes.push({
      id: `settle-${row.category ?? "pos"}`,
      tone: "warn",
      text: `${label} settlement pending ${inr(row.gross)}.`,
      href: "/banking",
    });
  }
  for (const row of stock.rows) {
    const onHand = num(row.on_hand);
    const minQty = num(row.min_qty);
    if (onHand <= 0) {
      notes.push({ id: `stock-out-${row.name}`, tone: "bad", text: `Out of stock: ${row.name}`, href: "/lube" });
    } else if (onHand <= minQty) {
      notes.push({ id: `stock-low-${row.name}`, tone: "warn", text: `Low stock: ${row.name} — ${onHand} left (min ${minQty})`, href: "/lube" });
    }
  }
  for (const row of dips.rows.filter((row) => row.status === "pending")) {
    notes.push({ id: `dip-pending-${row.id}`, tone: "warn", text: `Pending dip reading — ${row.label}.`, href: "/dip" });
  }
  for (const row of dips.rows.filter((row) => row.status === "difference")) {
    const delta = num(row.qty) - num(row.book_qty);
    notes.push({
      id: `dip-diff-${row.id}`,
      tone: "warn",
      text: `Stock difference — ${row.label} ${Math.abs(delta).toFixed(1)} KL.`,
      href: "/dip",
    });
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  notes.sort((a, b) => rank[a.tone] - rank[b.tone]);
  res.json(notes);
}));

app.get("/api/dashboard", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const openResult = await pool.query(
    `SELECT * FROM shifts WHERE outlet_id = $1 AND status = 'open' ORDER BY starts_at DESC LIMIT 1`,
    [outlet.id],
  );
  const open = openResult.rows[0] ?? null;
  const sales = await pool.query(
    `SELECT d.net, d.mode, d.created_at, pr.kind AS product_kind, pr.name AS product_name
     FROM documents d
     LEFT JOIN document_lines l ON l.document_id = d.id
     LEFT JOIN products pr ON pr.id = l.product_id
     WHERE d.outlet_id = $1 AND d.kind = 'sale' AND d.status <> 'cancelled'
       AND d.shift_id IS NOT DISTINCT FROM $2::uuid`,
    [outlet.id, open?.id ?? null],
  );
  const yesterday = await pool.query(
    `SELECT COALESCE(SUM(d.net), 0) AS total,
            COALESCE(SUM(d.net) FILTER (WHERE pr.kind = 'fuel'), 0) AS fuel,
            COALESCE(SUM(d.net) FILTER (WHERE pr.kind IN ('lube', 'fmcg')), 0) AS shop,
            COALESCE(SUM(d.net) FILTER (WHERE d.mode = 'cash'), 0) AS cash,
            COALESCE(SUM(d.net) FILTER (WHERE d.mode = 'credit'), 0) AS credit
     FROM documents d
     LEFT JOIN document_lines l ON l.document_id = d.id
     LEFT JOIN products pr ON pr.id = l.product_id
     WHERE d.outlet_id = $1 AND d.kind = 'sale' AND d.status <> 'cancelled'
       AND d.doc_date = CURRENT_DATE - 1`,
    [outlet.id],
  );
  const tanks = await pool.query(
    `SELECT e.id, e.label, e.live_qty, e.capacity, pr.name AS product
     FROM equipment e LEFT JOIN products pr ON pr.id = e.product_id
     WHERE e.outlet_id = $1 AND e.kind = 'tank'
     ORDER BY e.label`,
    [outlet.id],
  );

  const bills = open ? sales.rows : [];
  const sum = (rows, pred = () => true) => rows.filter(pred).reduce((n, row) => n + num(row.net), 0);
  const byHour = [];
  if (open) {
    const start = new Date(open.starts_at).getHours();
    const end = new Date(open.ends_at).getHours();
    for (let hour = start; hour <= end; hour += 1) {
      const amount = sum(bills, (row) => new Date(row.created_at).getHours() === hour);
      byHour.push({ hour: String(hour).padStart(2, "0"), amount });
    }
  }
  const tenders = ["cash", "upi", "card", "credit"];
  res.json({
    outletId: outlet.id,
    openShift: open ? shiftDto(open) : null,
    totals: {
      sales: sum(bills),
      fuel: sum(bills, (row) => row.product_kind === "fuel"),
      shop: sum(bills, (row) => row.product_kind === "lube" || row.product_kind === "fmcg"),
      cash: sum(bills, (row) => row.mode === "cash"),
      credit: sum(bills, (row) => row.mode === "credit"),
    },
    yesterday: {
      sales: num(yesterday.rows[0].total),
      fuel: num(yesterday.rows[0].fuel),
      shop: num(yesterday.rows[0].shop),
      cash: num(yesterday.rows[0].cash),
      credit: num(yesterday.rows[0].credit),
    },
    byHour,
    byTender: tenders.map((tender) => ({ tender, amount: sum(bills, (row) => row.mode === tender) })),
    byProduct: [...new Set(bills.map((row) => row.product_name).filter(Boolean))].map((product) => ({
      product,
      amount: sum(bills, (row) => row.product_name === product),
    })),
    tanks: tanks.rows.map((row) => ({
      id: row.id,
      label: row.label,
      product: row.product,
      liveQty: num(row.live_qty),
      capacity: num(row.capacity),
    })),
  });
}));

app.get("/api/dsr", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const docs = await pool.query(
    `SELECT d.*, pr.kind AS product_kind
     FROM documents d
     LEFT JOIN document_lines l ON l.document_id = d.id
     LEFT JOIN products pr ON pr.id = l.product_id
     WHERE d.outlet_id = $1 AND d.doc_date = $2 AND d.status <> 'cancelled'`,
    [outlet.id, date],
  );
  const shifts = await pool.query(
    `SELECT * FROM shifts
     WHERE outlet_id = $1 AND starts_at::date <= $2::date AND ends_at::date >= $2::date
     ORDER BY starts_at`,
    [outlet.id, date],
  );
  const rows = docs.rows;
  const ofKind = (kind) => rows.filter((row) => row.kind === kind);
  const sum = (list) => list.reduce((n, row) => n + num(row.net), 0);
  const sales = ofKind("sale");
  const dsr = ofKind("dsr")[0];
  res.json({
    outletId: outlet.id,
    date,
    locked: dsr?.status === "locked",
    note: dsr?.note ?? null,
    collection: {
      total: sum(sales),
      fuel: sum(sales.filter((row) => row.product_kind === "fuel")),
      shop: sum(sales.filter((row) => row.product_kind === "lube" || row.product_kind === "fmcg")),
      cash: sum(sales.filter((row) => row.mode === "cash")),
      digital: sum(sales.filter((row) => row.mode === "upi" || row.mode === "card")),
      credit: sum(sales.filter((row) => row.mode === "credit")),
      otherIncome: sum(sales.filter((row) => row.category === "other_income")),
    },
    cash: {
      expenses: sum(ofKind("expense").filter((row) => row.status === "approved" || row.status === "paid")),
      deposited: sum(ofKind("receipt").filter((row) => row.category === "cash_deposit")),
      purchases: sum(ofKind("purchase")),
    },
    shifts: shifts.rows.map(shiftDto),
  });
}));

app.get("/api/shifts", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const status = req.query.status;
  if (status && !["upcoming", "open", "closed", "approved", "rejected"].includes(status)) {
    throw bad("Unknown shift status.");
  }
  const { rows } = await pool.query(
    `SELECT * FROM shifts
     WHERE outlet_id = $1 AND ($2::shift_status IS NULL OR status = $2::shift_status)
     ORDER BY starts_at DESC`,
    [outlet.id, status || null],
  );
  res.json(rows.map(shiftDto));
}));

app.get("/api/shifts/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [req.params.id]);
  const shift = rows[0];
  if (!shift) throw bad("Shift not found.", 404);
  await assertOutlet(pool, req.user, shift.outlet_id);
  const duties = await pool.query(
    `SELECT sd.*, p.name AS party_name, e.label AS nozzle_label
     FROM shift_duties sd
     JOIN parties p ON p.id = sd.party_id
     JOIN equipment e ON e.id = sd.nozzle_id
     WHERE sd.shift_id = $1
     ORDER BY sd.window_start`,
    [shift.id],
  );
  const readings = await pool.query(
    `SELECT r.*, e.label AS equipment_label, p.name AS party_name
     FROM readings r
     JOIN equipment e ON e.id = r.equipment_id
     LEFT JOIN parties p ON p.id = r.party_id
     WHERE r.shift_id = $1
     ORDER BY r.at`,
    [shift.id],
  );
  res.json({
    ...shiftDto(shift),
    duties: duties.rows.map((row) => ({
      id: row.id,
      partyId: row.party_id,
      partyName: row.party_name,
      nozzleId: row.nozzle_id,
      nozzleLabel: row.nozzle_label,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      checkedOutAt: row.checked_out_at,
    })),
    readings: readings.rows.map((row) => ({
      id: row.id,
      equipmentId: row.equipment_id,
      equipmentLabel: row.equipment_label,
      partyId: row.party_id,
      partyName: row.party_name,
      kind: row.kind,
      at: row.at,
      mm: num(row.mm),
      qty: num(row.qty),
      bookQty: num(row.book_qty),
      status: row.status,
      remarks: row.remarks,
    })),
  });
}));

app.get("/api/readings", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const kind = req.query.kind || null;
  if (kind && !["opening", "closing", "dip"].includes(kind)) throw bad("Unknown reading kind.");
  const { rows } = await pool.query(
    `SELECT r.*, e.label AS equipment_label, e.kind AS equipment_kind, p.name AS party_name, s.label AS shift_label
     FROM readings r
     JOIN equipment e ON e.id = r.equipment_id
     LEFT JOIN parties p ON p.id = r.party_id
     LEFT JOIN shifts s ON s.id = r.shift_id
     WHERE e.outlet_id = $1
       AND ($2::reading_kind IS NULL OR r.kind = $2::reading_kind)
       AND ($3::uuid IS NULL OR r.shift_id = $3::uuid)
     ORDER BY r.at DESC`,
    [outlet.id, kind, req.query.shiftId || null],
  );
  res.json(rows.map((row) => ({
    id: row.id,
    shiftId: row.shift_id,
    shiftLabel: row.shift_label,
    equipmentId: row.equipment_id,
    equipmentLabel: row.equipment_label,
    equipmentKind: row.equipment_kind,
    partyId: row.party_id,
    partyName: row.party_name,
    kind: row.kind,
    at: row.at,
    mm: num(row.mm),
    qty: num(row.qty),
    bookQty: num(row.book_qty),
    status: row.status,
    remarks: row.remarks,
  })));
}));

app.get("/api/equipment", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const kind = req.query.kind || null;
  if (kind && !["tank", "nozzle"].includes(kind)) throw bad("Unknown equipment kind.");
  const { rows } = await pool.query(
    `SELECT e.*, pr.name AS product_name, pr.kind AS product_kind
     FROM equipment e
     LEFT JOIN products pr ON pr.id = e.product_id
     WHERE e.outlet_id = $1 AND ($2::equipment_kind IS NULL OR e.kind = $2::equipment_kind)
     ORDER BY e.kind, e.label`,
    [outlet.id, kind],
  );
  const dto = (row) => ({
    id: row.id,
    outletId: row.outlet_id,
    parentId: row.parent_id,
    productId: row.product_id,
    productName: row.product_name,
    productKind: row.product_kind,
    kind: row.kind,
    label: row.label,
    capacity: num(row.capacity),
    liveQty: num(row.live_qty),
    meter: num(row.meter),
    tolerance: num(row.tolerance),
    dipChart: row.dip_chart ?? [],
  });
  const nozzles = rows.filter((row) => row.kind === "nozzle").map(dto);
  const tanks = rows.filter((row) => row.kind === "tank").map((row) => ({
    ...dto(row),
    nozzles: nozzles.filter((nozzle) => nozzle.parentId === row.id),
  }));
  if (kind === "nozzle") return res.json(nozzles);
  if (kind === "tank") return res.json(tanks);
  res.json([...tanks, ...nozzles.filter((nozzle) => !tanks.some((tank) => tank.id === nozzle.parentId))]);
}));

app.get("/api/products", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const { rows } = await pool.query(
    `SELECT pr.*, b.on_hand, b.min_qty
     FROM products pr
     LEFT JOIN balances b ON b.product_id = pr.id AND b.outlet_id = $1
     WHERE pr.dealer_id = $2
     ORDER BY pr.kind, pr.name`,
    [outlet.id, req.user.dealer_id],
  );
  res.json(rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    brand: row.brand,
    code: row.code,
    hsn: row.hsn,
    unit: row.unit,
    gst: num(row.gst),
    purchasePrice: num(row.purchase_price),
    sellingPrice: num(row.selling_price),
    onHand: num(row.on_hand) ?? 0,
    minQty: num(row.min_qty) ?? 0,
  })));
}));

app.get("/api/products/:id", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const product = await pool.query(
    `SELECT pr.*, b.on_hand, b.min_qty
     FROM products pr
     LEFT JOIN balances b ON b.product_id = pr.id AND b.outlet_id = $2
     WHERE pr.id = $1 AND pr.dealer_id = $3`,
    [req.params.id, outlet.id, req.user.dealer_id],
  );
  const row = product.rows[0];
  if (!row) throw bad("Product not found.", 404);
  const movement = await pool.query(
    `SELECT d.id, d.kind, d.doc_no, d.doc_date, d.status, l.qty, l.amount, l.qty_received
     FROM document_lines l
     JOIN documents d ON d.id = l.document_id
     WHERE l.product_id = $1 AND d.outlet_id = $2
     ORDER BY d.doc_date DESC, d.created_at DESC`,
    [row.id, outlet.id],
  );
  res.json({
    id: row.id,
    kind: row.kind,
    name: row.name,
    brand: row.brand,
    code: row.code,
    hsn: row.hsn,
    unit: row.unit,
    gst: num(row.gst),
    purchasePrice: num(row.purchase_price),
    sellingPrice: num(row.selling_price),
    onHand: num(row.on_hand) ?? 0,
    minQty: num(row.min_qty) ?? 0,
    movement: movement.rows.map((line) => ({
      documentId: line.id,
      kind: line.kind,
      docNo: line.doc_no,
      docDate: line.doc_date,
      status: line.status,
      qty: num(line.qty),
      amount: num(line.amount),
      qtyReceived: num(line.qty_received),
    })),
  });
}));

async function creditExtras(outletId) {
  const { rows } = await pool.query(
    `SELECT party_id,
            COALESCE(SUM(CASE
              WHEN kind = 'sale' AND mode = 'credit' AND status <> 'cancelled' THEN net
              WHEN kind = 'adjustment' AND category = 'debit_note' THEN net
              WHEN kind = 'receipt' THEN -net
              WHEN kind = 'adjustment' AND category = 'credit_note' THEN -net
              ELSE 0 END), 0) AS outstanding,
            COALESCE(SUM(CASE
              WHEN kind = 'sale' AND mode = 'credit' AND status <> 'cancelled' AND due_date < CURRENT_DATE THEN net
              ELSE 0 END), 0) AS overdue_sales,
            COALESCE(SUM(CASE WHEN kind = 'receipt' THEN net ELSE 0 END), 0) AS receipts,
            MAX(CASE
              WHEN kind = 'sale' AND mode = 'credit' AND due_date < CURRENT_DATE THEN CURRENT_DATE - due_date
              ELSE 0 END) AS overdue_days
     FROM documents
     WHERE outlet_id = $1
     GROUP BY party_id`,
    [outletId],
  );
  return new Map(rows.map((row) => [row.party_id, row]));
}

function withCredit(row, extras) {
  if (row.role !== "credit_customer") return partyDto(row);
  const extra = extras.get(row.id);
  const outstanding = num(extra?.outstanding) ?? 0;
  const overdue = Math.max(0, (num(extra?.overdue_sales) ?? 0) - (num(extra?.receipts) ?? 0));
  return partyDto(row, {
    outstanding,
    overdue,
    overdueDays: overdue > 0 ? Number(extra?.overdue_days ?? 0) : 0,
    health: creditHealth(outstanding, num(row.credit_limit) ?? 0),
  });
}

app.get("/api/parties", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const role = req.query.role || null;
  if (role && !PARTY_ROLES.includes(role)) throw bad("Unknown role.");
  const { rows } = await pool.query(
    `SELECT p.*, ARRAY[po.outlet_id] AS outlet_ids
     FROM parties p
     JOIN party_outlets po ON po.party_id = p.id
     WHERE po.outlet_id = $1 AND p.dealer_id = $2
       AND ($3::party_role IS NULL OR p.role = $3::party_role)
     ORDER BY p.name`,
    [outlet.id, req.user.dealer_id, role],
  );
  const extras = await creditExtras(outlet.id);
  res.json(rows.map((row) => withCredit(row, extras)));
}));

app.get("/api/parties/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, COALESCE(array_agg(po.outlet_id) FILTER (WHERE po.outlet_id IS NOT NULL), '{}') AS outlet_ids
     FROM parties p
     LEFT JOIN party_outlets po ON po.party_id = p.id
     WHERE p.id = $1 AND p.dealer_id = $2
     GROUP BY p.id`,
    [req.params.id, req.user.dealer_id],
  );
  const row = rows[0];
  if (!row) throw bad("Party not found.", 404);
  const allowed = await outletIdsFor(pool, req.user);
  const shared = (row.outlet_ids ?? []).filter((id) => allowed.includes(id));
  if (!shared.length && req.user.role !== "owner") throw bad("Party not found.", 404);
  const outletId = req.query.outletId || shared[0] || allowed[0];
  if (outletId) await assertOutlet(pool, req.user, outletId);
  const extras = outletId ? await creditExtras(outletId) : new Map();
  res.json(withCredit(row, extras));
}));

const documentSelect = `
  SELECT d.*, p.name AS party_name,
         COALESCE(json_agg(json_build_object(
           'id', l.id,
           'product_id', l.product_id,
           'product_name', pr.name,
           'equipment_id', l.equipment_id,
           'description', l.description,
           'qty', l.qty,
           'rate', l.rate,
           'amount', l.amount,
           'qty_received', l.qty_received
         )) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
  FROM documents d
  LEFT JOIN parties p ON p.id = d.party_id
  LEFT JOIN document_lines l ON l.document_id = d.id
  LEFT JOIN products pr ON pr.id = l.product_id
`;

app.get("/api/documents", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const kinds = req.query.kind ? String(req.query.kind).split(",").map((item) => item.trim()).filter(Boolean) : null;
  if (kinds?.some((kind) => !DOCUMENT_KINDS.includes(kind))) throw bad("Unknown document kind.");
  const modes = ["cash", "upi", "card", "credit", "neft", "rtgs", "imps", "cheque", "bank"];
  if (req.query.mode && !modes.includes(req.query.mode)) throw bad("Unknown payment mode.");
  const { rows } = await pool.query(
    `${documentSelect}
     WHERE d.outlet_id = $1
       AND ($2::document_kind[] IS NULL OR d.kind = ANY($2::document_kind[]))
       AND ($3::uuid IS NULL OR d.party_id = $3::uuid)
       AND ($4::uuid IS NULL OR d.shift_id = $4::uuid)
       AND ($5::date IS NULL OR d.doc_date >= $5::date)
       AND ($6::date IS NULL OR d.doc_date <= $6::date)
       AND ($7::text IS NULL OR d.category = $7)
       AND ($8::pay_mode IS NULL OR d.mode = $8::pay_mode)
     GROUP BY d.id, p.name
     ORDER BY d.doc_date DESC, d.created_at DESC`,
    [
      outlet.id,
      kinds,
      req.query.partyId || null,
      req.query.shiftId || null,
      req.query.from || null,
      req.query.to || null,
      req.query.category || null,
      req.query.mode || null,
    ],
  );
  res.json(rows.map(documentDto));
}));

app.get("/api/documents/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `${documentSelect} WHERE d.id = $1 GROUP BY d.id, p.name`,
    [req.params.id],
  );
  const row = rows[0];
  if (!row) throw bad("Document not found.", 404);
  await assertOutlet(pool, req.user, row.outlet_id);
  res.json(documentDto(row));
}));

app.get("/api/attendance", wrap(async (req, res) => {
  const outlet = await assertOutlet(pool, req.user, req.query.outletId);
  const { rows } = await pool.query(
    `SELECT a.*, p.name AS party_name
     FROM attendance a
     JOIN parties p ON p.id = a.party_id
     WHERE a.outlet_id = $1 AND ($2::uuid IS NULL OR a.party_id = $2::uuid)
     ORDER BY a.check_in DESC`,
    [outlet.id, req.query.partyId || null],
  );
  res.json(rows.map((row) => ({
    id: row.id,
    partyId: row.party_id,
    partyName: row.party_name,
    outletId: row.outlet_id,
    checkIn: row.check_in,
    checkOut: row.check_out,
    gpsOk: row.gps_ok,
    geofenceOk: row.geofence_ok,
    selfie: row.selfie,
    spoof: row.spoof,
    device: row.device,
    manualBy: row.manual_by,
  })));
}));

app.get("/api/activity", wrap(async (req, res) => {
  const outletId = req.query.outletId;
  if (outletId) await assertOutlet(pool, req.user, outletId);
  const allowed = await outletIdsFor(pool, req.user);
  const { rows } = await pool.query(
    `SELECT a.*, p.name AS actor_name
     FROM activity a
     LEFT JOIN parties p ON p.id = a.actor_id
     WHERE (a.outlet_id = ANY($1::uuid[]) OR a.outlet_id IS NULL)
       AND ($2::uuid IS NULL OR a.outlet_id = $2::uuid)
       AND ($3::text IS NULL OR a.action = $3)
       AND ($4::uuid IS NULL OR a.target_id = $4::uuid)
     ORDER BY a.at DESC
     LIMIT 200`,
    [allowed, outletId || null, req.query.action || null, req.query.targetId || null],
  );
  res.json(rows.map((row) => ({
    id: row.id,
    at: row.at,
    outletId: row.outlet_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    detail: row.detail,
    targetTable: row.target_table,
    targetId: row.target_id,
    status: row.status,
  })));
}));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 500 ? "Something went wrong." : error.message });
});

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set.");
  process.exit(1);
}

await migrate();
const seed = await ensureSeed(pool);
if (seed.seeded) console.log("Seeded one dealer and two outlets.");

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`Petroz API listening on ${port}`);
});
