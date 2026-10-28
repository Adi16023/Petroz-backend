import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { registerPublicBills } from "./public-bills.mjs";
import { registerWrites } from "./writes.mjs";

test("public bill links persist, expose only bill content, and stop working after cancellation or deletion", async () => {
  const db = new PGlite();
  let server;
  const settings = "00000000-0000-4000-8000-000000000001";
  const outletId = "00000000-0000-4000-8000-000000000002";
  const otherOutlet = "00000000-0000-4000-8000-000000000003";
  const actor = "00000000-0000-4000-8000-000000000004";
  try {
    await db.exec(`
      CREATE TABLE settings (id uuid PRIMARY KEY, company_image text, banner_image text);
      CREATE TABLE outlets (id uuid PRIMARY KEY, settings_id uuid, name text, code text, address text, phone text, gstin text, next_bill_no int);
      CREATE TABLE billing (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings_id uuid, outlet_id uuid, bill_no text,
        billed_at timestamptz, customer_name text, vehicle_no text, mobile text, payment_mode text,
        pump_nozzle text, attendant text, lines jsonb DEFAULT '[]', total numeric, created_by uuid
      );
      CREATE TABLE payment_methods (outlet_id uuid, code text, name text, active boolean);
      CREATE TABLE activity (outlet_id uuid, actor_id uuid, action text, detail text, target_table text, target_id uuid);
      INSERT INTO settings VALUES ('${settings}', null, null);
      INSERT INTO outlets VALUES ('${outletId}', '${settings}', 'Test Station', 'OUT', 'Station Road', '1234567890', 'GST123', 1);
      INSERT INTO outlets VALUES ('${otherOutlet}', '${settings}', 'Other Station', 'OTHER', '', '', '', 1);
      INSERT INTO billing (settings_id,outlet_id,bill_no,billed_at,total) VALUES ('${settings}','${outletId}','OUT-00001',now(),100);
    `);
    const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
    const migration = schema.slice(schema.indexOf("ALTER TABLE billing ADD COLUMN IF NOT EXISTS public_token"), schema.indexOf("CREATE TABLE IF NOT EXISTS payment_methods"));
    await db.exec(migration);
    const legacy = (await db.query("SELECT * FROM billing")).rows[0];
    assert.match(legacy.public_token, /^[a-f0-9]{64}$/);
    await db.exec(migration);
    assert.equal((await db.query("SELECT public_token FROM billing")).rows[0].public_token, legacy.public_token);
    const pool = { query: (sql, params) => db.query(sql, params) };
    const bad = (message, status = 400) => Object.assign(new Error(message), { status });
    const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
    const app = express();
    app.use(express.json());
    registerPublicBills(app, { pool, wrap, bad });
    app.use((req, res, next) => {
      if (req.headers.authorization !== "Bearer test") return res.status(401).json({ error: "Sign in required." });
      req.user = { id: actor, settings_id: settings, role: "owner" };
      next();
    });
    registerWrites(app, { pool, wrap, bad, assertOutlet: async (_pool, _user, id) => {
      const row = (await db.query("SELECT * FROM outlets WHERE id=$1", [id])).rows[0];
      if (!row) throw bad("Outlet not found.", 404);
      return row;
    } });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, body, auth = true) => fetch(`${base}${path}`, {
      method: body ? (path.endsWith("/cancel") ? "PATCH" : "POST") : "GET",
      headers: { ...(auth ? { Authorization: "Bearer test" } : {}), "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const savedResponse = await request("/api/billing", {
      outletId, customerName: "Customer", mobile: "9876543210", vehicleNo: "AB123",
      lines: [{ fuel: "Petrol", qty: 2, rate: 100, discount: 10 }], paymentMode: "Cash",
    });
    assert.equal(savedResponse.status, 201);
    const { bill } = await savedResponse.json();
    assert.notEqual(bill.publicToken, legacy.public_token);
    assert.match(bill.publicToken, /^[a-f0-9]{64}$/);
    assert.equal(bill.station.name, "Test Station");
    await db.exec("UPDATE outlets SET name = 'Renamed station'");
    await db.exec(migration);
    const response = await request(`/api/public/bills/${bill.publicToken}`, null, false);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
    const content = await response.json();
    assert.equal(content.station.name, "Test Station");
    assert.equal(content.total, 190);
    assert.equal(content.customerName, "Customer");
    assert.deepEqual(Object.keys(content).sort(), [
      "billNo", "billedAt", "customerName", "vehicleNo", "mobile", "paymentMode",
      "pumpNozzle", "attendant", "lines", "total", "station",
    ].sort());
    for (const token of ["bad", "a".repeat(64), bill.id]) {
      assert.equal((await request(`/api/public/bills/${token}`, null, false)).status, 404);
    }
    assert.equal((await request(`/api/billing/${bill.id}/cancel`, { outletId }, false)).status, 401);
    assert.equal((await request(`/api/billing/${"-".repeat(36)}/cancel`, { outletId })).status, 400);
    assert.equal((await request(`/api/billing/${bill.id}/cancel`, { outletId: otherOutlet })).status, 404);
    const cancelled = await request(`/api/billing/${bill.id}/cancel`, { outletId });
    assert.equal(cancelled.status, 200);
    const cancelledBill = await cancelled.json();
    const repeated = await request(`/api/billing/${bill.id}/cancel`, { outletId });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).cancelledAt, cancelledBill.cancelledAt);
    assert.equal((await request(`/api/public/bills/${bill.publicToken}`, null, false)).status, 404);
    await db.query("DELETE FROM billing WHERE id = $1", [legacy.id]);
    assert.equal((await request(`/api/public/bills/${legacy.public_token}`, null, false)).status, 404);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
  }
});
