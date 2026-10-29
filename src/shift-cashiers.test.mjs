import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCashierIds, assertShiftCashiers, withDocumentCashiers } from "./shift-cashiers.mjs";
import { registerWrites } from "./writes.mjs";
import { shiftReadingQty } from "./shift-readings.mjs";
import { syncDeskEquipment } from "./desk-equipment.mjs";

const outlet = { id: "00000000-0000-4000-8000-000000000001", settings_id: "00000000-0000-4000-8000-000000000002" };
const cashierId = "00000000-0000-4000-8000-000000000003";
const secondCashierId = "00000000-0000-4000-8000-000000000004";
const shiftId = "00000000-0000-4000-8000-000000000005";
const dealerId = "00000000-0000-4000-8000-000000000006";
const docId = "00000000-0000-4000-8000-000000000007";
const nozzleId = "00000000-0000-4000-8000-000000000008";
const user = { id: dealerId, name: "Dealer", role: "owner", settings_id: outlet.settings_id };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function harness({ cashierIds = [cashierId], validCashiers = true, documentTable, missingShift = false, expenseHistory = [], nozzles = [], readings = [], priorReadings = [], fuelLines = [], invalidFuelRate = false, closedShiftReadings, outletAllowed = true, failActivity = false, dsrDays = [], ownedShopSales = [], shopProduct = null } = {}) {
  const calls = [];
  const shift = {
    id: shiftId, outlet_id: outlet.id, label: "Morning", status: "open",
    starts_at: "2026-10-23T06:00:00Z", ends_at: "2026-10-23T14:00:00Z",
    duties: [], entry: { cashierIds, nozzleIds: [nozzleId] },
  };
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (failActivity && sql.includes("INSERT INTO activity")) throw new Error("Activity could not be saved.");
    if (sql.includes("kind = 'dsr' AND status = 'locked'")) {
      assert.match(sql, /outlet_id = \$1/);
      assert.match(sql, /doc_date BETWEEN/);
      assert.match(sql, /AT TIME ZONE 'Asia\/Kolkata'/);
      const day = (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      return { rows: dsrDays.filter((row) =>
        row.outletId === params[0] && row.status === "locked" &&
        row.day >= day(params[1]) && row.day <= day(params[2])) };
    }
    if (sql.includes("SELECT * FROM shifts")) return { rows: missingShift ? [] : [shift] };
    if (sql.includes("SELECT l.id AS sale_item_id")) return { rows: ownedShopSales };
    if (sql.includes("SELECT id, name, kind FROM products")) return { rows: [shopProduct ?? { id: docId, name: "Petrol", kind: "fuel" }] };
    if (sql.includes("SELECT id, name FROM users")) {
      assert.match(sql, /settings_id = \$2/);
      assert.match(sql, /role IN \('staff', 'manager'\)/);
      assert.match(sql, /staff_type = 'cashier'/);
      assert.match(sql, /active = true/);
      assert.match(sql, /outlet_id IS NULL OR outlet_id = \$3/);
      assert.deepEqual(params.slice(1), [outlet.settings_id, outlet.id]);
      return { rows: validCashiers ? params[0].map((id) => ({ id, name: "Cashier" })) : [] };
    }
    if (sql.includes("SELECT id FROM users")) return { rows: [{ id: cashierId }] };
    if (sql.includes("SELECT id FROM equipment")) return { rows: [{ id: nozzleId }] };
    if (sql.startsWith("SELECT id, outlet_id, shift_id FROM")) {
      return { rows: documentTable && sql.includes(`FROM ${documentTable} `) ? [{ id: docId, outlet_id: outlet.id, shift_id: shiftId }] : [] };
    }
    if (sql.includes("SELECT s.id, s.outlet_id, s.entry")) {
      return { rows: cashierIds.map((id) => ({ ...shift, cashier_id: id, cashier_name: id === cashierId ? "Ravi" : "Meena" })) };
    }
    if (sql.includes("SELECT e.doc_date, e.category")) return { rows: expenseHistory };
    if (sql.includes("SELECT e.id, e.label, e.meter")) return { rows: nozzles };
    if (sql.includes("SELECT equipment_id, kind, qty FROM dip_readings")) return { rows: readings };
    if (sql.includes("SELECT DISTINCT ON (r.equipment_id)")) {
      assert.match(sql, /r.kind = 'closing'/);
      assert.match(sql, /s.status = 'closed'/);
      assert.match(sql, /s.closed_at DESC NULLS LAST, r.at DESC/);
      assert.equal(sql.includes("starts_at"), false);
      assert.deepEqual(params, [outlet.id, shiftId]);
      if (closedShiftReadings) {
        const candidates = closedShiftReadings.filter((row) =>
          row.outlet_id === params[0] && row.shift_id !== params[1] && row.status === "closed");
        candidates.sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
        const byNozzle = new Map();
        for (const row of candidates) if (!byNozzle.has(row.equipment_id)) byNozzle.set(row.equipment_id, row);
        return { rows: [...byNozzle.values()] };
      }
      return { rows: priorReadings };
    }
    if (sql.includes("SELECT e.id, e.product_id, pr.name")) return { rows: nozzles };
    if (sql.includes("SELECT p.id, p.selling_price")) {
      return { rows: nozzles.map((row) => ({ id: row.product_id, selling_price: row.selling_price })) };
    }
    if (sql.includes("SELECT e.id AS equipment_id, p.selling_price")) {
      return { rows: nozzles.map((row) => ({ equipment_id: row.id, selling_price: row.selling_price })) };
    }
    if (sql.includes("SELECT l.equipment_id, l.qty, l.rate")) return { rows: fuelLines };
    if (sql.includes("SELECT l.id FROM sale_items")) return { rows: invalidFuelRate ? [{ id: docId }] : [] };
    if (sql.includes("INSERT INTO shifts")) return { rows: [{ id: shiftId }] };
    if (sql.includes("RETURNING id")) return { rows: [{ id: docId }] };
    return { rows: [] };
  };
  const client = { query, release: () => calls.push({ sql: "RELEASE", params: [] }) };
  const pool = { query, connect: async () => client };
  const routes = new Map();
  const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map((method) => [
    method, (path, handler) => routes.set(`${method} ${path}`, handler),
  ]));
  registerWrites(app, {
    pool, wrap: (handler) => handler, bad,
    assertOutlet: async (_pool, _user, id) => {
      assert.equal(id, outlet.id);
      if (!outletAllowed) throw bad("This pump is not on your desk.", 403);
      return outlet;
    },
  });
  async function request(route, body = {}, actor = user) {
    const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await routes.get(route)({ user: actor, body, params: { id: route.includes("documents") ? docId : shiftId } }, response);
    return response;
  }
  return { calls, shift, pool, request };
}

const receiptId = "00000000-0000-4000-8000-000000000009";
const secondReceiptId = "00000000-0000-4000-8000-000000000010";
const receiptBody = { id: receiptId, counts: { "500": 2, coins: 5.5 }, cashTotal: 10000, knownReceiptIds: [] };
const receiptRoute = "post /api/shifts/:id/cash-receipts";
const lockedDsr = { id: docId, outletId: outlet.id, day: "2026-10-23", status: "locked" };

test("locked DSR blocks every closed-shift edit path before writes, but permits viewing", async () => {
  for (const [route, body] of [
    ["put /api/shifts/:id/entry", {}],
    [receiptRoute, receiptBody],
    ["patch /api/shifts/:id", { status: "open", startsAt: "2026-10-24T06:00:00Z" }],
    ["delete /api/shifts/:id", {}],
    ["post /api/documents", { outletId: outlet.id, shiftId, kind: "expense", amount: 10 }],
    ["patch /api/documents/:id", { amount: 10 }],
    ["delete /api/documents/:id", { reason: "Delete" }],
    ["post /api/readings", { outletId: outlet.id, shiftId, kind: "closing", qty: 100 }],
  ]) {
    const h = harness({ dsrDays: [lockedDsr], documentTable: "expenses" });
    h.shift.status = "closed";
    await assert.rejects(h.request(route, body), { status: 423, message: /DSR is locked/ });
    assert.equal(h.calls.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)), false, route);
  }
  const h = harness({ dsrDays: [lockedDsr] });
  h.shift.status = "closed";
  const viewed = await h.request("get /api/shifts/:id/entry");
  assert.equal(viewed.body.shift.dsrLocked, true);
  assert.equal(viewed.body.shift.status, "closed");
});

test("DSR lock does not affect open or upcoming shifts, including when they are being closed", async () => {
  for (const status of ["open", "upcoming"]) {
    for (const [route, body] of [
      ["put /api/shifts/:id/entry", {}],
      [receiptRoute, receiptBody],
      ["patch /api/shifts/:id", { label: "Updated" }],
      ["put /api/shifts/:id/entry", { submit: true }],
    ]) {
      const h = harness({ dsrDays: [lockedDsr] });
      h.shift.status = status;
      const response = await h.request(route, body);
      assert.ok(response.statusCode < 400, `${status}: ${route}`);
    }
  }
});

test("unlocking DSR restores editing for closed shifts", async () => {
  const dsr = { ...lockedDsr };
  const h = harness({ dsrDays: [dsr] });
  h.shift.status = "closed";
  await assert.rejects(h.request("put /api/shifts/:id/entry"), { status: 423 });
  dsr.status = "open";
  const viewed = await h.request("get /api/shifts/:id/entry");
  assert.equal(viewed.body.shift.dsrLocked, false);
  await h.request("put /api/shifts/:id/entry");
  await h.request(receiptRoute, receiptBody);
  assert.ok(h.calls.some(({ sql }) => sql.includes("UPDATE shifts")));
});

test("DSR locks are scoped to the shift outlet and dates, including overnight shifts in IST", async () => {
  for (const dsr of [
    { ...lockedDsr, outletId: dealerId },
    { ...lockedDsr, day: "2026-10-22" },
    { ...lockedDsr, day: "2026-10-24" },
  ]) {
    const h = harness({ dsrDays: [dsr] });
    h.shift.status = "closed";
    assert.equal((await h.request("get /api/shifts/:id/entry")).body.shift.dsrLocked, false);
    await h.request("put /api/shifts/:id/entry");
  }
  const overnight = harness({ dsrDays: [{ ...lockedDsr, day: "2026-10-24" }] });
  Object.assign(overnight.shift, { status: "closed", starts_at: "2026-10-23T12:30:00Z", ends_at: "2026-10-23T20:30:00Z" });
  await assert.rejects(overnight.request("put /api/shifts/:id/entry"), { status: 423 });
});

test("cash received atomically appends denominations with the actual actor and adds to the existing cash total", async () => {
  const h = harness();
  h.shift.entry.totals = { cash: 10000, upi: 1000 };
  h.shift.expected_cash = 9500;
  const response = await h.request(receiptRoute, { ...receiptBody, userId: cashierId, userName: "Forged", at: "2000-01-01" });
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.cashTotal, 11005.5);
  assert.equal(response.body.expectedCash, 10505.5);
  assert.equal(response.body.declaredCash, null);
  const [receipt] = response.body.cashReceipts;
  assert.equal(receipt.userId, user.id);
  assert.equal(receipt.userName, user.name);
  assert.ok(Math.abs(Date.now() - Date.parse(receipt.at)) < 5000);
  assert.equal(receipt.counts["500"], 2);
  assert.equal(receipt.counts["10"], 0);
  assert.equal(receipt.counts.coins, 5.5);
  assert.equal(receipt.amount, 1005.5);
  const update = h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb"));
  const saved = JSON.parse(update.params[1]);
  assert.equal(saved.totals.upi, 1000);
  assert.deepEqual(saved.cashReceipts, [receipt]);
  const activity = h.calls.find(({ sql }) => sql.includes("INSERT INTO activity"));
  assert.equal(activity.params[1], user.id);
  assert.equal(activity.params[2], "cash_received");
  assert.ok(h.calls.findIndex(({ sql }) => sql === "BEGIN") < h.calls.indexOf(update));
  assert.ok(h.calls.indexOf(activity) < h.calls.findIndex(({ sql }) => sql === "COMMIT"));
  assert.equal(h.calls.at(-1).sql, "RELEASE");
});

test("cash receipt retries are idempotent and do not duplicate cash or activity", async () => {
  const h = harness();
  const initial = await h.request(receiptRoute, receiptBody);
  h.shift.entry = JSON.parse(h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb")).params[1]);
  const writes = h.calls.filter(({ sql }) => sql.startsWith("UPDATE shifts") || sql.includes("INSERT INTO activity")).length;
  const retry = await h.request(receiptRoute, receiptBody);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.cashTotal, initial.body.cashTotal);
  assert.equal(retry.body.cashReceipts.length, 1);
  assert.equal(h.calls.filter(({ sql }) => sql.startsWith("UPDATE shifts") || sql.includes("INSERT INTO activity")).length, writes);
  await assert.rejects(h.request(receiptRoute, { ...receiptBody, counts: { "500": 3 } }), { status: 409 });
});

test("cash receipts from another session are included once when adding or saving a stale entry", async () => {
  const h = harness();
  const first = await h.request(receiptRoute, receiptBody);
  h.shift.entry = JSON.parse(h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb")).params[1]);
  const second = await h.request(receiptRoute, { ...receiptBody, id: secondReceiptId, counts: { "100": 2 } }, { ...user, id: cashierId, name: "Ravi", role: "staff" });
  assert.equal(second.body.cashTotal, 11205.5);
  assert.deepEqual(second.body.cashReceipts.map((receipt) => receipt.userName), ["Dealer", "Ravi"]);
  h.shift.entry = JSON.parse(h.calls.filter(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb")).at(-1).params[1]);
  await h.request("put /api/shifts/:id/entry", {
    entry: { totals: { cash: first.body.cashTotal }, cashReceiptIds: [receiptId], cashReceipts: [{ userName: "Forged" }] },
  });
  const saved = JSON.parse(h.calls.filter(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb")).at(-1).params[1]);
  assert.equal(saved.totals.cash, 11205.5);
  assert.deepEqual(saved.cashReceipts, second.body.cashReceipts);
});

test("saving a loaded shift preserves receipts without adding their totals again", async () => {
  const h = harness();
  const added = await h.request(receiptRoute, receiptBody);
  h.shift.entry = JSON.parse(h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb")).params[1]);
  await h.request("put /api/shifts/:id/entry", { entry: { totals: { cash: added.body.cashTotal }, cashReceiptIds: [receiptId] } });
  const saved = JSON.parse(h.calls.filter(({ sql }) => sql.includes("UPDATE shifts SET entry = $2::jsonb")).at(-1).params[1]);
  assert.equal(saved.totals.cash, 11005.5);
  assert.deepEqual(saved.cashReceipts, added.body.cashReceipts);
  const reloaded = await h.request("get /api/shifts/:id/entry");
  assert.deepEqual(reloaded.body.cashReceipts, added.body.cashReceipts);
});

test("cash receipt validation rejects invalid denominations and zero amounts before writing", async () => {
  for (const counts of [null, [], {}, { "100": -1 }, { "100": 1.5 }, { "100": "2" }, { "500": 100001 }, { "2000": 1 }, { coins: -1 }, { coins: 0.001 }, { coins: Infinity }]) {
    const h = harness();
    await assert.rejects(h.request(receiptRoute, { ...receiptBody, counts }), { status: 400 });
    assert.equal(h.calls.some(({ sql }) => sql.startsWith("UPDATE shifts")), false);
  }
  const h = harness();
  await assert.rejects(h.request(receiptRoute, { ...receiptBody, cashTotal: -1 }), { status: 400 });
  assert.ok(h.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(h.calls.some(({ sql }) => sql === "COMMIT"), false);
});

test("cash received enforces roles, outlet access and valid cashier assignments", async () => {
  const forbidden = harness();
  await assert.rejects(forbidden.request(receiptRoute, receiptBody, { ...user, role: "auditor" }), { status: 403 });
  assert.equal(forbidden.calls.length, 0);
  const unassigned = harness({ cashierIds: [] });
  await assert.rejects(unassigned.request(receiptRoute, receiptBody), { status: 400 });
  assert.ok(unassigned.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(unassigned.calls.some(({ sql }) => sql.startsWith("UPDATE shifts")), false);
  const missing = harness({ missingShift: true });
  await assert.rejects(missing.request(receiptRoute, receiptBody), { status: 404 });
  const denied = harness({ outletAllowed: false });
  await assert.rejects(denied.request(receiptRoute, receiptBody), { status: 403 });
  assert.equal(denied.calls.some(({ sql }) => sql === "BEGIN"), false);
});

test("cash receipt activity failures roll back the cash update and release the connection", async () => {
  const h = harness({ failActivity: true });
  await assert.rejects(h.request(receiptRoute, receiptBody), /Activity could not be saved/);
  assert.ok(h.calls.some(({ sql }) => sql.startsWith("UPDATE shifts")));
  assert.ok(h.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(h.calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(h.calls.at(-1).sql, "RELEASE");
});

test("adding cash on a closed shift preserves its status and cash variance", async () => {
  const h = harness();
  Object.assign(h.shift, { status: "closed", expected_cash: 10000, declared_cash: 9900 });
  h.shift.entry.totals = { cash: 10000 };
  const response = await h.request(receiptRoute, receiptBody);
  assert.equal(response.body.expectedCash, 11005.5);
  assert.equal(response.body.declaredCash, 10905.5);
  assert.equal(h.shift.status, "closed");
});

const shiftBody = {
  outletId: outlet.id, label: "Morning", startsAt: "2026-10-23T06:00:00Z", endsAt: "2026-10-23T14:00:00Z",
  staffIds: [cashierId], cashierIds: [cashierId], nozzleIds: [nozzleId],
};

test("cashier validation rejects omitted, empty, malformed and null assignments", async () => {
  for (const value of [undefined, [], null, "cashier", ["invalid"], [null]]) {
    const { pool } = harness();
    await assert.rejects(assertCashierIds(pool, value, outlet, bad), { status: 400 });
  }
});

test("cashier validation checks active role and dealer/outlet membership and deduplicates IDs", async () => {
  const { pool } = harness();
  assert.deepEqual(await assertCashierIds(pool, [cashierId, cashierId], outlet, bad), [cashierId]);
  await assert.rejects(assertCashierIds(harness({ validCashiers: false }).pool, [cashierId], outlet, bad), /Select active cashiers/);
});

test("shift validation scopes and locks the shift before checking its cashiers", async () => {
  const { pool, calls } = harness();
  await assertShiftCashiers(pool, shiftId, outlet, bad, true);
  assert.match(calls[0].sql, /outlet_id = \$2 FOR UPDATE/);
  assert.deepEqual(calls[0].params, [shiftId, outlet.id]);
  await assert.rejects(assertShiftCashiers(pool, "invalid", outlet, bad), { status: 400 });
  await assert.rejects(assertShiftCashiers(harness({ missingShift: true }).pool, shiftId, outlet, bad), { status: 404 });
});

test("shift creation requires cashiers and does not write on invalid assignments", async () => {
  for (const ids of [undefined, [], null, ["invalid"]]) {
    const h = harness();
    await assert.rejects(h.request("post /api/shifts", { ...shiftBody, cashierIds: ids }), { status: 400 });
    assert.equal(h.calls.some(({ sql }) => sql.includes("INSERT")), false);
  }
  const h = harness();
  const response = await h.request("post /api/shifts", shiftBody);
  assert.equal(response.statusCode, 201);
  const inserted = h.calls.find(({ sql }) => sql.includes("INSERT INTO shifts"));
  assert.deepEqual(JSON.parse(inserted.params[6]).cashierIds, [cashierId]);
});

test("shift editing cannot clear assignments, but can repair a historical shift", async () => {
  for (const ids of [[], null, ["invalid"]]) {
    const h = harness();
    await assert.rejects(h.request("patch /api/shifts/:id", { cashierIds: ids }), { status: 400 });
    assert.equal(h.calls.some(({ sql }) => /^\s*UPDATE/.test(sql)), false);
  }
  const legacy = harness({ cashierIds: [] });
  await assert.rejects(legacy.request("patch /api/shifts/:id", { status: "closed" }), /Assign at least one cashier/);
  await legacy.request("patch /api/shifts/:id", { cashierIds: [cashierId] });
  const update = legacy.calls.find(({ sql }) => sql.includes("UPDATE shifts SET"));
  assert.deepEqual(JSON.parse(update.params[12]).cashierIds, [cashierId]);
});

test("inactive or cross-outlet cashiers are rejected for shift creation, editing and closing", async () => {
  for (const [route, body] of [
    ["post /api/shifts", shiftBody],
    ["patch /api/shifts/:id", { cashierIds: [cashierId] }],
    ["patch /api/shifts/:id", { status: "closed" }],
  ]) {
    const h = harness({ validCashiers: false });
    await assert.rejects(h.request(route, body), /Select active cashiers/);
    assert.equal(h.calls.some(({ sql }) => /^\s*(INSERT|UPDATE)/.test(sql)), false);
  }
});

test("all shift-linked document kinds reject an unassigned shift and roll back before writes", async () => {
  for (const kind of ["sale", "expense", "receipt", "payment", "adjustment", "transfer", "purchase"]) {
    const h = harness({ cashierIds: [] });
    await assert.rejects(h.request("post /api/documents", {
      outletId: outlet.id, shiftId, kind, amount: 100,
    }), /Assign at least one cashier/);
    assert.equal(h.calls.some(({ sql }) => /INSERT|DELETE|UPDATE/.test(sql.replace("FOR UPDATE", ""))), false);
    assert.ok(h.calls.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(h.calls.at(-1).sql, "RELEASE");
  }
});

test("valid shift sales keep the dealer as creator and customer as counterparty", async () => {
  const h = harness();
  const response = await h.request("post /api/documents", {
    outletId: outlet.id, shiftId, partyId: secondCashierId, kind: "sale", amount: 100,
  });
  assert.equal(response.statusCode, 201);
  const insert = h.calls.find(({ sql }) => sql.includes("INSERT INTO sales"));
  assert.equal(insert.params[1], secondCashierId);
  assert.equal(insert.params[15], dealerId);
  assert.ok(h.calls.some(({ sql }) => sql === "COMMIT"));
});

test("standalone documents remain allowed without a shift cashier", async () => {
  const h = harness({ cashierIds: [] });
  assert.equal((await h.request("post /api/documents", { outletId: outlet.id, kind: "expense", amount: 100 })).statusCode, 201);
  assert.equal(h.calls.some(({ sql }) => sql.includes("SELECT * FROM shifts")), false);
});

test("shift-linked documents reject missing and cross-outlet shifts before inserting", async () => {
  const h = harness({ missingShift: true });
  await assert.rejects(h.request("post /api/documents", {
    outletId: outlet.id, shiftId, kind: "sale", amount: 100,
  }), { status: 404 });
  const selection = h.calls.find(({ sql }) => sql.includes("SELECT * FROM shifts"));
  assert.deepEqual(selection.params, [shiftId, outlet.id]);
  assert.equal(h.calls.some(({ sql }) => sql.includes("INSERT")), false);
});

test("document updates validate existing shift associations across all document tables", async () => {
  for (const documentTable of ["sales", "purchases", "expenses", "banking", "documents"]) {
    const h = harness({ cashierIds: [], documentTable });
    await assert.rejects(h.request("patch /api/documents/:id", { amount: 150 }), /Assign at least one cashier/);
    assert.equal(h.calls.some(({ sql }) => sql.includes("UPDATE")), false);
  }
});

test("shift entry rejects forged entry assignments before changing stock or documents", async () => {
  const h = harness({ cashierIds: [] });
  await assert.rejects(h.request("put /api/shifts/:id/entry", {
    entry: { cashierIds: [cashierId] }, expenses: [{ amount: 100 }],
  }), /Assign at least one cashier/);
  assert.equal(h.calls.some(({ sql }) => /INSERT|DELETE|UPDATE/.test(sql.replace("FOR UPDATE", ""))), false);
  assert.ok(h.calls.some(({ sql }) => sql === "ROLLBACK"));
});

test("valid shift entry preserves stored cashiers instead of client-supplied IDs", async () => {
  const h = harness();
  await h.request("put /api/shifts/:id/entry", { entry: { cashierIds: [dealerId] } });
  const update = h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET entry"));
  assert.deepEqual(JSON.parse(update.params[1]).cashierIds, [cashierId]);
  assert.ok(h.calls.some(({ sql }) => sql === "COMMIT"));
});

test("shift entry history returns cashier names as paidBy and preserves the real creator as by", async () => {
  const h = harness({
    cashierIds: [cashierId, secondCashierId],
    expenseHistory: [{ doc_date: "2026-10-23", category: "Tea", amount: 100, mode: "cash", note: "Tea", party_name: "Dealer" }],
  });
  const response = await h.request("get /api/shifts/:id/entry");
  assert.deepEqual(response.body.shift.cashierNames, ["Ravi", "Meena"]);
  assert.equal(response.body.history[0].paidBy, "Ravi, Meena");
  assert.equal(response.body.history[0].by, "Dealer");
});

test("document cashier attribution includes all cashiers without changing audit or customer IDs", async () => {
  const h = harness({ cashierIds: [cashierId, secondCashierId] });
  const original = { id: docId, outletId: outlet.id, shiftId, createdBy: dealerId, partyId: "customer", decidedBy: dealerId };
  const [doc] = await withDocumentCashiers(h.pool, [original]);
  assert.deepEqual(doc.cashierNames, ["Ravi", "Meena"]);
  assert.deepEqual(doc.cashierIds, [cashierId, secondCashierId]);
  assert.equal(doc.handledBy, "Ravi, Meena");
  assert.equal(doc.createdBy, dealerId);
  assert.equal(doc.partyId, "customer");
  assert.equal(doc.decidedBy, dealerId);
  assert.equal(original.handledBy, undefined);
});

test("historical shifts are explicitly unassigned and standalone records stay unchanged", async () => {
  const h = harness({ cashierIds: [] });
  const standalone = { id: docId, createdBy: dealerId };
  const docs = await withDocumentCashiers(h.pool, [standalone, { shiftId, outletId: outlet.id }]);
  assert.equal(docs[0], standalone);
  assert.equal(docs[1].handledBy, "Unassigned cashier");
  const other = await withDocumentCashiers(harness().pool, [{ shiftId, outletId: "another-outlet" }]);
  assert.equal(other[0].handledBy, "Unassigned cashier");
});

test("shift entry persists the actual opening and closing values separately", async () => {
  const h = harness({ nozzles: [{ id: nozzleId, product_id: docId, selling_price: 100 }] });
  await h.request("put /api/shifts/:id/entry", {
    pumps: [{ equipmentId: nozzleId, opening: 12000, closing: 12450, rate: 0 }],
  });
  const insert = h.calls.find(({ sql }) => sql.includes("INSERT INTO dip_readings (shift_id"));
  assert.deepEqual(insert.params.slice(3), [12000, 12450]);
});

test("opening correction uses only that shift's saved meters and never changes a closing or dip", () => {
  const entry = { meters: { [nozzleId]: 12000 } };
  assert.equal(shiftReadingQty({ equipment_id: nozzleId, kind: "opening", qty: 12450 }, entry), 12000);
  assert.equal(shiftReadingQty({ equipment_id: nozzleId, kind: "closing", qty: 12450 }, entry), 12450);
  assert.equal(shiftReadingQty({ equipment_id: nozzleId, kind: "dip", qty: 12450 }, entry), 12450);
  assert.equal(shiftReadingQty({ equipment_id: nozzleId, kind: "opening", qty: 12450 }, {}), 12450);
  assert.equal(shiftReadingQty({ equipment_id: nozzleId, kind: "opening", qty: 12450 }, { meters: { [nozzleId]: 0 } }), 0);
});

test("existing shift entry uses its own saved opening and actual closing instead of a later nozzle meter", async () => {
  const h = harness({
    nozzles: [{ id: nozzleId, label: "Pump 1", meter: 99999 }],
    readings: [
      { equipment_id: nozzleId, kind: "opening", qty: 12450 },
      { equipment_id: nozzleId, kind: "closing", qty: 12450 },
    ],
    priorReadings: [{ equipment_id: nozzleId, qty: 11800 }],
  });
  h.shift.entry.meters = { [nozzleId]: 12000 };
  const response = await h.request("get /api/shifts/:id/entry");
  assert.equal(response.body.nozzles[0].opening, 12000);
  assert.equal(response.body.nozzles[0].closing, 12450);
  assert.equal(response.body.nozzles[0].qty, 450);
});

test("new shifts carry the previous shift closing, not its opening", async () => {
  const h = harness({
    nozzles: [{ id: nozzleId, label: "Pump 1", meter: 99999 }],
    priorReadings: [{ equipment_id: nozzleId, qty: 12450 }],
  });
  const response = await h.request("get /api/shifts/:id/entry");
  assert.equal(response.body.nozzles[0].opening, 12450);
  assert.equal(response.body.nozzles[0].closing, 12450);
  assert.equal(response.body.nozzles[0].qty, 0);
});

test("a shift's explicit readings remain authoritative without saved entry meters", async () => {
  const h = harness({
    nozzles: [{ id: nozzleId, label: "Pump 1", meter: 99999 }],
    readings: [
      { equipment_id: nozzleId, kind: "opening", qty: 12000 },
      { equipment_id: nozzleId, kind: "closing", qty: 12450 },
    ],
    priorReadings: [{ equipment_id: nozzleId, qty: 11800 }],
  });
  const response = await h.request("get /api/shifts/:id/entry");
  assert.equal(response.body.nozzles[0].opening, 12000);
  assert.equal(response.body.nozzles[0].closing, 12450);
});

test("closing locks current fuel rates and recalculates lines and sale totals before closing atomically", async () => {
  const h = harness();
  await h.request("patch /api/shifts/:id", { status: "closed" });
  const lock = h.calls.findIndex(({ sql }) => sql.includes("FOR SHARE OF p"));
  const lines = h.calls.findIndex(({ sql }) => sql.includes("UPDATE sale_items l SET rate"));
  const totals = h.calls.findIndex(({ sql }) => sql.includes("UPDATE sales s SET amount"));
  const close = h.calls.findIndex(({ sql }) => sql.includes("UPDATE shifts SET"));
  const commit = h.calls.findIndex(({ sql }) => sql === "COMMIT");
  assert.ok(lock > 0 && lines > lock && totals > lines && close > totals && commit > close);
  assert.match(h.calls[lines].sql, /ROUND\(l.qty \* p.selling_price, 2\)/);
  assert.match(h.calls[lines].sql, /s.category = 'shift_fuel' AND s.status <> 'cancelled'/);
  assert.match(h.calls[totals].sql, /net = totals.amount \+ s.tax \+ s.charges/);
  assert.deepEqual(h.calls[lock].params, [shiftId, outlet.id, [nozzleId]]);
  for (const index of [lines, totals]) assert.deepEqual(h.calls[index].params, [shiftId, outlet.id]);
});

test("missing or invalid current fuel rates abort closing without committing", async () => {
  const h = harness({ invalidFuelRate: true });
  await assert.rejects(h.request("patch /api/shifts/:id", { status: "closed" }), /valid current fuel rate/);
  assert.ok(h.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(h.calls.some(({ sql }) => sql.includes("UPDATE shifts SET") || sql === "COMMIT"), false);
});

test("editing or approving a closed shift does not reprice it at later rates", async () => {
  for (const status of ["open", "closed"]) {
    const h = harness();
    h.shift.status = status;
    await h.request("patch /api/shifts/:id", status === "closed" ? { status: "closed" } : { label: "Evening" });
    assert.equal(h.calls.some(({ sql }) => sql.includes("UPDATE sale_items l SET rate")), false);
  }
});

test("rewriting lube shift entries restores original FIFO allocations before consuming the replacement lines", async () => {
  const h = harness({
    ownedShopSales: [{ sale_item_id: nozzleId, product_id: docId, qty: 8, kind: "lube" }],
    shopProduct: { id: docId, name: "Oil", kind: "lube" },
  });
  await h.request("put /api/shifts/:id/entry", {
    lubes: [{ productId: docId, qty: 8, rate: 20, mode: "cash" }],
  });
  const moves = h.calls.filter(({ sql }) => sql.includes("SELECT move_shop_stock"));
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0].params, [outlet.id,docId,8,null,null,null,nozzleId,true]);
  assert.deepEqual(moves[1].params, [outlet.id,docId,-8,null,null,null,docId,false]);
  const restoration = h.calls.indexOf(moves[0]);
  const deletion = h.calls.findIndex(({ sql }) => sql.includes("DELETE FROM sale_items"));
  const consumption = h.calls.indexOf(moves[1]);
  assert.ok(restoration < deletion && deletion < consumption);
  const line = h.calls.find(({ sql }) => sql.includes("INSERT INTO sale_items (sale_id, product_id, description"));
  assert.equal(line.params[4], 20);
});

test("stale entry rates cannot overwrite current product prices, including during direct submit", async () => {
  for (const submit of [false, true]) {
    const h = harness({ nozzles: [{ id: nozzleId, product_id: docId, kind: "fuel", selling_price: "105.50" }] });
    await h.request("put /api/shifts/:id/entry", {
      submit,
      pumps: [{ equipmentId: nozzleId, opening: 1000, closing: 1100, test: 2, rate: 95 }],
    });
    const line = h.calls.find(({ sql }) => sql.includes("INSERT INTO sale_items (sale_id, product_id, equipment_id"));
    assert.equal(line.params[4], 98);
    assert.equal(line.params[5], 105.5);
    assert.equal(line.params[6], 10339);
    assert.equal(h.calls.some(({ sql }) => sql.includes("UPDATE products SET selling_price")), false);
    assert.ok(h.calls.some(({ sql }) => sql.includes("FOR SHARE OF p")));
  }
});

test("closed shift entry displays its saved rate even after catalog prices change", async () => {
  const h = harness({
    nozzles: [{ id: nozzleId, selling_price: 120, price_at: "2026-10-24T00:00:00Z" }],
    fuelLines: [{ equipment_id: nozzleId, qty: 100, rate: 105.5, test_qty: 0 }],
  });
  h.shift.status = "closed";
  const response = await h.request("get /api/shifts/:id/entry");
  assert.equal(response.body.nozzles[0].rate, 105.5);
});

test("open and upcoming entries always display current product prices instead of their saved sale rate", async () => {
  for (const status of ["open", "upcoming"]) {
    const h = harness({
      nozzles: [{ id: nozzleId, selling_price: 120 }],
      fuelLines: [{ equipment_id: nozzleId, qty: 100, rate: 95, test_qty: 0 }],
    });
    h.shift.status = status;
    h.shift.entry.fuelRates = { [nozzleId]: 95 };
    const response = await h.request("get /api/shifts/:id/entry");
    assert.equal(response.body.nozzles[0].rate, 120);
  }
});

test("closing snapshots rates even for nozzles without fuel sales", async () => {
  const h = harness({ nozzles: [{ id: nozzleId, product_id: docId, selling_price: 105.5 }] });
  await h.request("patch /api/shifts/:id", { status: "closed" });
  const update = h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET"));
  assert.deepEqual(JSON.parse(update.params[12]).fuelRates, { [nozzleId]: 105.5 });
});

test("closed entry saves ignore forged rates and preserve the stored snapshot", async () => {
  const h = harness({ nozzles: [{ id: nozzleId, product_id: docId, kind: "fuel", selling_price: 120 }] });
  h.shift.status = "closed";
  h.shift.entry.fuelRates = { [nozzleId]: 105.5 };
  await h.request("put /api/shifts/:id/entry", {
    pumps: [{ equipmentId: nozzleId, opening: 1000, closing: 1100, rate: 1 }],
    entry: { fuelRates: { [nozzleId]: 1 } },
  });
  const insert = h.calls.find(({ sql }) => sql.includes("INSERT INTO sale_items (sale_id, product_id, equipment_id"));
  assert.equal(insert.params[5], 105.5);
  assert.equal(insert.params[6], 10550);
});

test("carry-forward follows actual closure order, not the shifts' scheduled time", async () => {
  const row = {
    equipment_id: nozzleId, outlet_id: outlet.id, status: "closed",
    starts_at: "2026-10-23T06:00:00Z", closed_at: "2026-10-23T08:00:00Z", qty: 12000,
  };
  const h = harness({
    nozzles: [{ id: nozzleId, label: "Pump 1", meter: 99999 }],
    closedShiftReadings: [
      { ...row, shift_id: "morning" },
      { ...row, shift_id: "late-night", starts_at: "2026-10-22T22:00:00Z", closed_at: "2026-10-23T10:00:00Z", qty: 12500 },
      { ...row, shift_id: "unclosed", status: "open", closed_at: "2026-10-23T12:00:00Z", qty: 14000 },
      { ...row, shift_id: "other-outlet", outlet_id: "another-outlet", closed_at: "2026-10-23T13:00:00Z", qty: 15000 },
      { ...row, shift_id: shiftId, closed_at: "2026-10-23T14:00:00Z", qty: 16000 },
    ],
  });
  const response = await h.request("get /api/shifts/:id/entry");
  assert.equal(response.body.nozzles[0].opening, 12500);
  assert.equal(response.body.nozzles[0].closing, 12500);
});

test("explicit closure timestamps actual closure and preserves the timestamp on closed-shift edits", async () => {
  const h = harness();
  await h.request("patch /api/shifts/:id", { status: "closed" });
  const patch = h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET"));
  assert.match(patch.sql, /WHEN \$5::shift_status = 'closed' AND status <> 'closed' THEN clock_timestamp\(\)/);
  assert.match(patch.sql, /WHEN \$5::shift_status <> 'closed' THEN NULL/);
  assert.match(patch.sql, /ELSE closed_at/);
});

test("entry submission posts transactions without changing shift status or closure metadata", async () => {
  for (const status of ["open", "upcoming", "closed"]) {
    for (const submit of [false, true]) {
      const h = harness();
      Object.assign(h.shift, { status, closed_at: status === "closed" ? "2026-10-23T14:00:00Z" : null, closed_by: status === "closed" ? dealerId : null });
      const response = await h.request("put /api/shifts/:id/entry", {
        submit,
        entry: { totals: { cash: 100 } },
        payments: [{ mode: "cash", amount: 100 }],
      });
      const updates = h.calls.filter(({ sql }) => /UPDATE shifts/.test(sql) && /entry = \$2::jsonb/.test(sql));
      assert.ok(updates.length > 0);
      for (const { sql } of updates) {
        assert.doesNotMatch(sql, /\bstatus\s*=/);
        assert.doesNotMatch(sql, /\bclosed_(at|by)\s*=/);
      }
      assert.equal(response.body.shift.status, status);
      const payments = h.calls.filter(({ sql }) => /INSERT INTO documents/.test(sql) && sql.includes("'payment'"));
      assert.equal(payments.length, 1);
      assert.ok(payments[0].params.includes(submit || status === "closed" ? "approved" : "draft"));
    }
  }
});

test("saving a fuel rate updates matching fuel records used by nozzles without changing closed shifts", async () => {
  const h = harness();
  await h.request("patch /api/products/:id", { outletId: outlet.id, sellingPrice: 140 });
  const update = h.calls.find(({ sql }) => sql.includes("UPDATE products SET selling_price = $3"));
  assert.deepEqual(update.params, [outlet.settings_id, ["petrol", "ms", "petrol / ms", "petrol (ms)"], 140]);
  assert.match(update.sql, /kind = 'fuel'/);
  assert.equal(h.calls.some(({ sql }) => /UPDATE (shifts|sale_items|sales)/.test(sql)), false);
});

test("saving pumps reuses the existing fuel product instead of creating or zeroing a shadow product", async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT id FROM products")) return { rows: [{ id: docId }] };
    if (sql.includes("RETURNING id")) return { rows: [{ id: nozzleId }] };
    return { rows: [] };
  } };
  await syncDeskEquipment(db, {
    settingsId: outlet.settings_id, outletId: outlet.id,
    desk: { pumps: [{ id: "pump", name: "P1", nozzles: [{ fuel: "Petrol", on: true }] }] },
    scope: { fuels: false, tanks: false, pumps: true },
  });
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO products")), false);
  const nozzle = calls.find(({ sql }) => sql.includes("INSERT INTO equipment") && sql.includes("'nozzle'"));
  assert.equal(nozzle.params[2], docId);
  const lookup = calls.find(({ sql }) => sql.includes("SELECT id FROM products"));
  assert.deepEqual(lookup.params, [outlet.settings_id, "petrol"]);
});

test("saving pumps reuses configured tanks rather than creating duplicate automatic tanks", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE products (id uuid PRIMARY KEY, settings_id uuid, kind text, name text, active boolean, price_at timestamptz, created_at timestamptz);
      CREATE TABLE equipment (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid, product_id uuid, parent_id uuid,
        kind text, label text, capacity numeric, live_qty numeric, meter numeric, pump_name text,
        settings_ref text, active boolean DEFAULT true
      );
      CREATE UNIQUE INDEX equipment_ref ON equipment(outlet_id, settings_ref) WHERE settings_ref IS NOT NULL AND settings_ref <> '';
      CREATE TABLE dip_readings (equipment_id uuid, kind text, qty numeric, remarks text, at timestamptz);
      CREATE TABLE sale_items (equipment_id uuid);
      CREATE TABLE purchase_items (equipment_id uuid);
      CREATE TABLE document_items (equipment_id uuid);
    `);
    await db.query("INSERT INTO products (id, settings_id, kind, name, active) VALUES ($1,$2,'fuel','Petrol',true)", [docId, outlet.settings_id]);
    await db.query("INSERT INTO equipment (id,outlet_id,product_id,kind,label,capacity,live_qty) VALUES ($1,$2,$3,'tank','Petrol tank 1',20,10)", [cashierId, outlet.id, docId]);
    const options = {
      settingsId: outlet.settings_id, outletId: outlet.id,
      desk: { pumps: [{ id: "pump", name: "P1", nozzles: [{ fuel: "Petrol", on: true }, { fuel: "Petrol", on: true }] }] },
      scope: { fuels: false, tanks: false, pumps: true },
    };
    await syncDeskEquipment(db, options);
    await syncDeskEquipment(db, options);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM equipment WHERE kind='tank'")).rows[0].count, 1);
    const nozzles = (await db.query("SELECT parent_id FROM equipment WHERE kind='nozzle'")).rows;
    assert.equal(nozzles.length, 2);
    assert.ok(nozzles.every((row) => row.parent_id === cashierId));
    const tank = (await db.query("SELECT capacity::float,live_qty::float FROM equipment WHERE id=$1", [cashierId])).rows[0];
    assert.deepEqual(tank, { capacity: 20, live_qty: 10 });

    await db.exec("DELETE FROM equipment");
    await syncDeskEquipment(db, options);
    await syncDeskEquipment(db, options);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM equipment WHERE kind='tank'")).rows[0].count, 1);
    const automatic = (await db.query("SELECT id,settings_ref FROM equipment WHERE kind='tank'")).rows[0];
    assert.equal(automatic.settings_ref, "tank:auto:petrol");
    assert.ok((await db.query("SELECT parent_id FROM equipment WHERE kind='nozzle'")).rows.every((row) => row.parent_id === automatic.id));
  } finally { await db.close(); }
});
