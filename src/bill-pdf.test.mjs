import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { registerBillPdf, registerPublicBillPdf, billPdfObjectKey } from "./bill-pdf.mjs";
import { registerPublicBills, billDto } from "./public-bills.mjs";
import { registerWrites } from "./writes.mjs";

test("bill PDF cache pointer, public readiness, and cancel clear the key", async () => {
  const db = new PGlite();
  let server;
  const settings = "00000000-0000-4000-8000-000000000001";
  const outletId = "00000000-0000-4000-8000-000000000002";
  const actor = "00000000-0000-4000-8000-000000000004";
  try {
    await db.exec(`
      CREATE TABLE settings (id uuid PRIMARY KEY, company_image text, banner_image text);
      CREATE TABLE outlets (id uuid PRIMARY KEY, settings_id uuid, name text, code text, address text, city text, state text, pincode text, phone text, gstin text, brand text, next_bill_no int, bill jsonb NOT NULL DEFAULT '{}'::jsonb);
      CREATE TABLE billing (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings_id uuid, outlet_id uuid, bill_no text,
        billed_at timestamptz, customer_name text, customer_gstin text, vehicle_no text, mobile text, payment_mode text,
        pump_nozzle text, attendant text, lines jsonb DEFAULT '[]', total numeric, created_by uuid
      );
      CREATE TABLE payment_methods (outlet_id uuid, code text, name text, active boolean);
      CREATE TABLE activity (outlet_id uuid, actor_id uuid, action text, detail text, target_table text, target_id uuid);
      INSERT INTO settings VALUES ('${settings}', null, null);
      INSERT INTO outlets VALUES ('${outletId}', '${settings}', 'Test Station', 'OUT', 'Station Road', 'Thanjavur', 'Tamil Nadu', '613001', '1234567890', 'GST123', 'jio-bp', 1, '{}'::jsonb);
    `);
    const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
    const migration = schema.slice(
      schema.indexOf("ALTER TABLE billing ADD COLUMN IF NOT EXISTS public_token"),
      schema.indexOf("CREATE TABLE IF NOT EXISTS payment_methods"),
    );
    await db.exec(migration);

    const pool = { query: (sql, params) => db.query(sql, params) };
    const bad = (message, status = 400) => Object.assign(new Error(message), { status });
    const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    registerPublicBills(app, { pool, wrap, bad });
    registerPublicBillPdf(app, { pool, wrap, bad });
    app.use((req, res, next) => {
      if (req.headers.authorization !== "Bearer test") return res.status(401).json({ error: "Sign in required." });
      req.user = { id: actor, settings_id: settings, role: "owner" };
      next();
    });
    registerBillPdf(app, {
      pool, wrap, bad,
      assertOutlet: async (_pool, _user, id) => {
        const row = (await db.query("SELECT * FROM outlets WHERE id=$1", [id])).rows[0];
        if (!row) throw bad("Outlet not found.", 404);
        return row;
      },
    });
    registerWrites(app, {
      pool, wrap, bad,
      assertOutlet: async (_pool, _user, id) => {
        const row = (await db.query("SELECT * FROM outlets WHERE id=$1", [id])).rows[0];
        if (!row) throw bad("Outlet not found.", 404);
        return row;
      },
    });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, { method = "GET", body, auth = true } = {}) => fetch(`${base}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: "Bearer test" } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const saved = await request("/api/billing", {
      method: "POST",
      body: {
        outletId, customerName: "Customer", mobile: "9876543210",
        lines: [{ fuel: "Petrol", qty: 1, rate: 100 }], paymentMode: "Cash",
      },
    });
    assert.equal(saved.status, 201);
    const { bill } = await saved.json();
    assert.equal(bill.pdfReady, false);

    const missing = await request(`/api/billing/${bill.id}/pdf?outletId=${outletId}&generate=0`);
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), {
      ready: false,
      url: null,
      billNo: bill.billNo,
      downloadPath: `/api/billing/${bill.id}/pdf/file?outletId=${outletId}`,
    });

    const publicMissing = await request(`/api/public/bills/${bill.publicToken}/pdf?generate=0`, { auth: false });
    assert.equal(publicMissing.status, 200);
    const publicBody = await publicMissing.json();
    assert.equal(publicBody.ready, false);
    assert.equal(publicBody.downloadPath, `/api/public/bills/${bill.publicToken}/pdf/file`);

    // Simulate a worker having uploaded: set pointer only (S3 not configured in test).
    const key = billPdfObjectKey(outletId, bill.id);
    await db.query(`UPDATE billing SET pdf_object_key = $2 WHERE id = $1`, [bill.id, key]);
    const dto = billDto((await db.query("SELECT * FROM billing WHERE id = $1", [bill.id])).rows[0]);
    assert.equal(dto.pdfReady, true);

    // Without S3 credentials, ready bill cannot mint a signed URL.
    const readyNoStorage = await request(`/api/billing/${bill.id}/pdf?outletId=${outletId}`);
    assert.equal(readyNoStorage.status, 503);

    const cancelled = await request(`/api/billing/${bill.id}/cancel`, {
      method: "PATCH",
      body: { outletId },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).pdfReady, false);
    assert.equal(
      (await db.query("SELECT pdf_object_key FROM billing WHERE id = $1", [bill.id])).rows[0].pdf_object_key,
      null,
    );
    assert.equal((await request(`/api/public/bills/${bill.publicToken}/pdf`, { auth: false })).status, 404);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
  }
});
