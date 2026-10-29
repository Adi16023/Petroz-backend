import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { assertOutlet } from "./auth.mjs";
import { registerOffers, validateOffer } from "./offers.mjs";

const migration = readFileSync(new URL("../db/offers.sql", import.meta.url), "utf8");
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const outlet = "11111111-1111-4111-8111-111111111111";
const otherOutlet = "22222222-2222-4222-8222-222222222222";
const otherDealerOutlet = "33333333-3333-4333-8333-333333333333";
const offer = {
  outletId: outlet, name: "Fuel offer", description: "", type: "fuel", applicable: "Petrol",
  discount: "litre", value: 2, minimum: 0, maximum: 0, benefit: "", start: "2026-10-29",
  end: "2026-11-29", audience: "All customers", enabled: true,
};

test("validates every offer type, amounts, real dates and required fields", () => {
  for (const type of ["fuel", "product", "service", "combo"]) {
    assert.equal(validateOffer({ ...offer, type, discount: "fixed", benefit: "Free wash" }, bad).type, type);
  }
  for (const change of [
    { type: "unknown" }, { name: "" }, { audience: "" }, { applicable: "" }, { name: "x".repeat(121) },
    { description: 1 }, { enabled: "true" }, { value: -1 }, { value: 0.001 }, { minimum: -1 },
    { maximum: Infinity }, { value: NaN }, { value: "2" }, { value: 1e15 }, { discount: "unknown" },
    { discount: "percent", value: 101 }, { type: "product" }, { type: "service", benefit: "" },
    { type: "combo", benefit: "" }, { start: "2026-02-30" }, { start: "invalid" },
    { start: "2026-12-01" }, { end: "2026-10-28" },
  ]) assert.throws(() => validateOffer({ ...offer, ...change }, bad));
  assert.equal(validateOffer({ ...offer, start: "2028-02-29", end: "2028-02-29" }, bad).start, "2028-02-29");
});

test("offers migration and routes persist CRUD, preserve counters and enforce access with real PostgreSQL", async () => {
  const db = new PGlite();
  const app = express();
  let server;
  try {
    await db.exec(`CREATE TABLE outlets (
      id uuid PRIMARY KEY, settings_id text, name text, code text, address text, phone text,
      gstin text, owner_whatsapp text, next_bill_no int, bill jsonb
    );
    INSERT INTO outlets (id, settings_id, name) VALUES
      ('${outlet}', 'dealer', 'First'), ('${otherOutlet}', 'dealer', 'Second'),
      ('${otherDealerOutlet}', 'other-dealer', 'Other');`);
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM offers")).rows[0].count, 0);
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { role: req.headers["x-role"] || "owner", settings_id: "dealer" };
      next();
    });
    registerOffers(app, {
      pool: db, bad, assertOutlet,
      wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
    });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/offers`;
    const write = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    for (const type of ["fuel", "product", "service", "combo"]) {
      const response = await fetch(url, write("POST", { ...offer, type, discount: "fixed", benefit: "Free wash", usage: 999, given: 999 }));
      assert.equal(response.status, 201);
      const saved = await response.json();
      assert.equal(saved.type, type);
      assert.equal(saved.start, offer.start);
      assert.equal(saved.end, offer.end);
      assert.equal(saved.value, 2);
      assert.equal(saved.usage, 0);
      assert.equal(saved.given, 0);
    }
    let response = await fetch(`${url}?outletId=${outlet}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    let rows = await response.json();
    assert.equal(rows.length, 4);
    const id = rows[0].id;
    await db.query("UPDATE offers SET usage=3, given=6 WHERE id=$1", [id]);
    response = await fetch(`${url}/${id}`, write("PATCH", { ...offer, name: "Updated", usage: 900, given: 900 }));
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.name, "Updated");
    assert.equal(updated.usage, 3);
    assert.equal(updated.given, 6);
    await db.exec(migration);
    rows = await (await fetch(`${url}?outletId=${outlet}`)).json();
    assert.equal(rows.find((row) => row.id === id).name, "Updated");
    assert.deepEqual(await (await fetch(`${url}?outletId=${otherOutlet}`)).json(), []);
    assert.equal((await fetch(`${url}?outletId=${otherDealerOutlet}`)).status, 404);
    assert.equal((await fetch(`${url}`)).status, 400);
    assert.equal((await fetch(`${url}?outletId=bad`)).status, 400);
    for (const role of ["manager", "staff", "auditor", "credit_customer", "attendance"]) {
      assert.equal((await fetch(`${url}?outletId=${outlet}`, { headers: { "x-role": role } })).status, 403);
      assert.equal((await fetch(url, { ...write("POST", offer), headers: { "Content-Type": "application/json", "x-role": role } })).status, 403);
      assert.equal((await fetch(`${url}/${id}`, { ...write("PATCH", offer), headers: { "Content-Type": "application/json", "x-role": role } })).status, 403);
      assert.equal((await fetch(`${url}/${id}?outletId=${outlet}`, { method: "DELETE", headers: { "x-role": role } })).status, 403);
    }
    assert.equal((await fetch(`${url}/${id}`, write("PATCH", { ...offer, outletId: otherOutlet }))).status, 404);
    assert.equal((await fetch(`${url}/${id}`, write("PATCH", { ...offer, outletId: otherDealerOutlet }))).status, 404);
    assert.equal((await fetch(`${url}/${id}?outletId=${otherOutlet}`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${url}/${id}?outletId=${otherDealerOutlet}`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${url}/bad`, write("PATCH", offer))).status, 400);
    assert.equal((await fetch(`${url}/bad?outletId=${outlet}`, { method: "DELETE" })).status, 400);
    assert.equal((await fetch(url, write("POST", { ...offer, end: "2026-10-28" }))).status, 400);
    assert.equal((await fetch(`${url}/${id}?outletId=${outlet}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${url}/${id}?outletId=${outlet}`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${url}/${id}`, write("PATCH", offer))).status, 404);
    await db.query("DELETE FROM outlets WHERE id=$1", [outlet]);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM offers")).rows[0].count, 0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await db.close();
  }
});
