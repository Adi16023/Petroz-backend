import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCashierIds, assertShiftCashiers, withDocumentCashiers } from "./shift-cashiers.mjs";
import { registerWrites } from "./writes.mjs";
import { shiftReadingQty } from "./shift-readings.mjs";

const outlet = { id: "00000000-0000-4000-8000-000000000001", settings_id: "00000000-0000-4000-8000-000000000002" };
const cashierId = "00000000-0000-4000-8000-000000000003";
const secondCashierId = "00000000-0000-4000-8000-000000000004";
const shiftId = "00000000-0000-4000-8000-000000000005";
const dealerId = "00000000-0000-4000-8000-000000000006";
const docId = "00000000-0000-4000-8000-000000000007";
const nozzleId = "00000000-0000-4000-8000-000000000008";
const user = { id: dealerId, role: "owner", settings_id: outlet.settings_id };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function harness({ cashierIds = [cashierId], validCashiers = true, documentTable, missingShift = false, expenseHistory = [], nozzles = [], readings = [], priorReadings = [], fuelLines = [], invalidFuelRate = false, closedShiftReadings } = {}) {
  const calls = [];
  const shift = {
    id: shiftId, outlet_id: outlet.id, label: "Morning", status: "open",
    starts_at: "2026-10-23T06:00:00Z", ends_at: "2026-10-23T14:00:00Z",
    duties: [], entry: { cashierIds, nozzleIds: [nozzleId] },
  };
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT * FROM shifts")) return { rows: missingShift ? [] : [shift] };
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
      return outlet;
    },
  });
  async function request(route, body = {}) {
    const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await routes.get(route)({ user, body, params: { id: route.includes("documents") ? docId : shiftId } }, response);
    return response;
  }
  return { calls, shift, pool, request };
}

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

test("both close paths timestamp actual closure and preserve the timestamp on closed-shift edits", async () => {
  const h = harness();
  await h.request("patch /api/shifts/:id", { status: "closed" });
  const patch = h.calls.find(({ sql }) => sql.includes("UPDATE shifts SET"));
  assert.match(patch.sql, /WHEN \$5::shift_status = 'closed' AND status <> 'closed' THEN clock_timestamp\(\)/);
  assert.match(patch.sql, /WHEN \$5::shift_status <> 'closed' THEN NULL/);
  assert.match(patch.sql, /ELSE closed_at/);
  const entry = harness();
  await entry.request("put /api/shifts/:id/entry", { submit: true });
  const submit = entry.calls.find(({ sql }) => sql.includes("closed_at = CASE"));
  assert.match(submit.sql, /WHEN status <> 'closed' THEN clock_timestamp\(\) ELSE closed_at END/);
});
