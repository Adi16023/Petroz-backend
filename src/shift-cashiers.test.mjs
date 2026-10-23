import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCashierIds, assertShiftCashiers, withDocumentCashiers } from "./shift-cashiers.mjs";
import { registerWrites } from "./writes.mjs";

const outlet = { id: "00000000-0000-4000-8000-000000000001", settings_id: "00000000-0000-4000-8000-000000000002" };
const cashierId = "00000000-0000-4000-8000-000000000003";
const secondCashierId = "00000000-0000-4000-8000-000000000004";
const shiftId = "00000000-0000-4000-8000-000000000005";
const dealerId = "00000000-0000-4000-8000-000000000006";
const docId = "00000000-0000-4000-8000-000000000007";
const nozzleId = "00000000-0000-4000-8000-000000000008";
const user = { id: dealerId, role: "owner", settings_id: outlet.settings_id };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function harness({ cashierIds = [cashierId], validCashiers = true, documentTable, missingShift = false, expenseHistory = [] } = {}) {
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
    assert.equal(h.calls.some(({ sql }) => sql.includes("UPDATE")), false);
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
    assert.equal(h.calls.some(({ sql }) => /INSERT|UPDATE/.test(sql)), false);
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
