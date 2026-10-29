import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { registerStockAudits, validateAudit } from "./stock-audits.mjs";
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const outlet = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const tankId = "33333333-3333-4333-8333-333333333333";
const nozzleId = "44444444-4444-4444-8444-444444444444";
const auditId = "55555555-5555-4555-8555-555555555555";
const otherOutlet = "66666666-6666-4666-8666-666666666666";
function sample() {
  return { version: 0, status: "draft", data: {
    dealerName: "Station", sapCode: "123", previousDate: "2026-10-01", auditDate: "2026-10-29", tankId: "all",
    notes: "", verifiedBy: "Verifier", designation: "Dealer", signature: "",
    fuels: [{ id: "diesel", family: "diesel", label: "HSD", opening: 1000, receipts: 2000, actual: 1500, nozzles: [{ id: nozzleId, label: "N1", previous: 500, current: 2000, testing: 0 }] }],
  } };
}
test("validates incomplete drafts, complete submissions, dates, quantities and signature uploads", () => {
  const audit = sample();
  assert.equal(validateAudit(audit, bad).data.fuels[0].label, "HSD");
  audit.data.fuels[0].actual = null;
  assert.equal(validateAudit(audit, bad).data.fuels[0].actual, null);
  assert.throws(() => validateAudit({ ...audit, status: "submitted" }, bad), /Complete/);
  for (const change of [{ auditDate: "2026-02-30" }, { auditDate: "2026-09-30" }, { signature: "data:image/svg+xml;base64,YQ==" }, { notes: "x".repeat(501) }, { fuels: [] }]) {
    assert.throws(() => validateAudit({ ...sample(), data: { ...sample().data, ...change } }, bad));
  }
  for (const value of [-1, Infinity, NaN, "1"]) {
    const broken = sample(); broken.data.fuels[0].opening = value;
    assert.throws(() => validateAudit(broken, bad));
  }
  const broken = sample(); broken.data.fuels[0].nozzles[0].current = 1;
  assert.throws(() => validateAudit(broken, bad), /Current/);
  const blankVerifier = sample(); blankVerifier.status = "submitted"; blankVerifier.data.verifiedBy = "";
  assert.throws(() => validateAudit(blankVerifier, bad), /Verifier/);
});

test("audit routes persist drafts/submissions with version conflicts and outlet/role isolation", async () => {
  const db = new PGlite();
  let server;
  try {
    await db.exec(`CREATE TABLE outlets(id uuid PRIMARY KEY);
      CREATE TABLE users(id uuid PRIMARY KEY);
      INSERT INTO outlets VALUES('${outlet}'),('${otherOutlet}');
      INSERT INTO users VALUES('${userId}');`);
    const migration = readFileSync(new URL("../db/stock-audits.sql", import.meta.url), "utf8");
    await db.exec(migration); await db.exec(migration);
    const app = express(); app.use(express.json({ limit: "4mb" }));
    app.use((req, _res, next) => { req.user = { id: userId, role: req.headers["x-role"] || "owner" }; next(); });
    registerStockAudits(app, {
      pool: db, bad, wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
      assertOutlet: async (_db, _user, id) => { if (id !== outlet && id !== otherOutlet) throw bad("Outlet not found.", 404); return { id }; },
    });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/stock-audits`;
    const write = (value, role = "owner") => ({ method: "PUT", headers: { "Content-Type": "application/json", "x-role": role }, body: JSON.stringify({ ...value, outletId: outlet }) });
    assert.deepEqual(await (await fetch(`${url}?outletId=${outlet}`)).json(), []);
    let response = await fetch(`${url}/${auditId}`, write(sample()));
    assert.equal(response.status, 200);
    let saved = await response.json(); assert.equal(saved.version, 1);
    assert.equal((await fetch(`${url}/${auditId}`, write(sample()))).status, 409);
    response = await fetch(`${url}/${auditId}?outletId=${outlet}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).data.fuels[0].opening, 1000);
    assert.equal((await fetch(`${url}/${auditId}?outletId=${otherOutlet}`)).status, 404);
    assert.equal((await fetch(`${url}/${auditId}`, { ...write({ ...sample(), version: 1 }), body: JSON.stringify({ ...sample(), version: 1, outletId: otherOutlet }) })).status, 409);
    assert.equal((await fetch(`${url}?outletId=${outlet}`, { headers: { "x-role": "staff" } })).status, 403);
    assert.equal((await fetch(`${url}/${auditId}`, write({ ...sample(), version: 1 }, "credit_customer"))).status, 403);
    saved.data.notes = "Saved note";
    response = await fetch(`${url}/${auditId}`, write({ version: 1, status: "draft", data: saved.data }));
    saved = await response.json(); assert.equal(saved.version, 2);
    assert.equal((await fetch(`${url}/${auditId}`, write({ ...sample(), version: 1 }))).status, 409);
    response = await fetch(`${url}/${auditId}`, write({ version: 2, status: "submitted", data: saved.data }));
    saved = await response.json(); assert.equal(saved.status, "submitted"); assert.ok(saved.submittedAt);
    assert.equal(saved.data.notes, "Saved note");
    assert.equal((await fetch(`${url}/${auditId}`, write({ ...sample(), version: 3 }))).status, 409);
    const history = await (await fetch(`${url}?outletId=${outlet}`)).json();
    assert.equal(history[0].status, "submitted"); assert.equal(history[0].auditDate, "2026-10-29");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM stock_audits")).rows[0].count, 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await db.close();
  }
});

test("prefill uses business-day boundaries and historical readings, not live tank stock or meter", async () => {
  const db = new PGlite();
  let server;
  try {
    await db.exec(`
      CREATE TABLE outlets(id uuid PRIMARY KEY,desk jsonb);
      CREATE TABLE products(id uuid PRIMARY KEY,name text,kind text);
      CREATE TABLE equipment(id uuid PRIMARY KEY,outlet_id uuid,product_id uuid,parent_id uuid,kind text,label text,active boolean);
      CREATE TABLE shifts(id uuid PRIMARY KEY,entry jsonb);
      CREATE TYPE dip_status AS ENUM ('normal','difference','pending');
      CREATE TABLE dip_readings(id uuid DEFAULT gen_random_uuid(),equipment_id uuid,shift_id uuid,kind text,at timestamptz,qty numeric,status dip_status);
      CREATE TABLE purchases(id uuid PRIMARY KEY,outlet_id uuid,kind text,status text,doc_date date,note text);
      CREATE TABLE purchase_items(purchase_id uuid,product_id uuid,equipment_id uuid,qty numeric,qty_received numeric);
      CREATE TABLE sales(id uuid PRIMARY KEY,outlet_id uuid,status text,doc_date date);
      CREATE TABLE sale_items(sale_id uuid,equipment_id uuid,test_qty numeric);
      INSERT INTO outlets VALUES('${outlet}','{"businessDayEnd":"01:00"}');
      INSERT INTO products VALUES('${userId}','Diesel','fuel');
      INSERT INTO equipment VALUES('${tankId}','${outlet}','${userId}',null,'tank','Diesel tank',true),
        ('${nozzleId}','${outlet}','${userId}','${tankId}','nozzle','N1',true);
      INSERT INTO dip_readings(equipment_id,kind,at,qty,status) VALUES
        ('${tankId}','dip','2026-10-02T00:30:00+05:30',1,'normal'),
        ('${tankId}','dip','2026-10-29T23:00:00+05:30',1.5,'difference'),
        ('${tankId}','dip','2026-10-30T01:00:00+05:30',9,'normal'),
        ('${tankId}','dip','2026-10-30T00:45:00+05:30',8,'pending'),
        ('${nozzleId}','closing','2026-10-02T00:30:00+05:30',500,null),
        ('${nozzleId}','closing','2026-10-30T00:30:00+05:30',2000,null),
        ('${nozzleId}','closing','2026-10-30T01:00:00+05:30',9000,null);
      INSERT INTO purchases VALUES('${auditId}','${outlet}','purchase','approved','2026-10-10','');
      INSERT INTO purchase_items VALUES('${auditId}','${userId}',null,2,null);
      INSERT INTO sales VALUES('${auditId}','${outlet}','approved','2026-10-10');
      INSERT INTO sale_items VALUES('${auditId}','${nozzleId}',10);
    `);
    const app = express();
    app.use((req, _res, next) => { req.user = { id: userId, name: "Verifier", role: "owner" }; next(); });
    registerStockAudits(app, { pool: db, bad, wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next), assertOutlet: async () => ({ id: outlet, name: "Station", code: "123" }) });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/stock-audits/prefill?outletId=${outlet}&previousDate=2026-10-01&auditDate=2026-10-29`;
    let response = await fetch(url);
    assert.equal(response.status, 200);
    let result = await response.json();
    const fuel = result.data.fuels[0];
    assert.equal(fuel.opening, 1000); assert.equal(fuel.actual, 1500); assert.equal(fuel.receipts, 2000);
    assert.deepEqual(fuel.nozzles[0], { id: nozzleId, label: "N1", previous: 500, current: 2000, testing: 10 });
    assert.deepEqual(result.warnings, []);
    await db.exec("DELETE FROM dip_readings WHERE equipment_id='" + nozzleId + "' AND qty=500");
    response = await fetch(url); result = await response.json();
    assert.equal(result.data.fuels[0].nozzles[0].previous, null);
    assert.ok(result.warnings.some((warning) => warning.includes("missing")));
    assert.equal((await fetch(url + "&tankId=" + otherOutlet)).status, 400);
    await db.query("INSERT INTO equipment VALUES($1,$2,$3,null,'tank','Second diesel tank',true)", [otherOutlet, outlet, userId]);
    response = await fetch(url + "&tankId=" + tankId);
    result = await response.json();
    assert.equal(result.data.fuels[0].receipts, null);
    assert.ok(result.warnings.some((warning) => warning.includes("not assigned to a tank")));
    assert.equal(result.data.fuels.length, 1);
    assert.equal(result.data.fuels[0].nozzles.length, 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await db.close();
  }
});
