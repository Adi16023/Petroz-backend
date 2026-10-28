import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes } from "node:crypto";
import { registerContacts, encryptPassword, decryptPassword, validateContact } from "./contacts.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const customer = { tab: "customers", name: "Customer", category: "Fleet", phone: "9876543210" };

test("validates all three record types and rejects invalid input", () => {
  for (const tab of ["customers", "business"]) assert.equal(validateContact({ ...customer, tab }, bad).tab, tab);
  assert.throws(() => validateContact({ ...customer, phone: "bad" }, bad), /phone/);
  assert.throws(() => validateContact({ ...customer, tab: "unknown" }, bad), /tab/);
  assert.throws(() => validateContact({ ...customer, email: "bad" }, bad), /email/);
  const login = { tab: "logins", name: "Portal", category: "Banking", company: "Bank", username: "user", password: "pass", website: "https://example.com" };
  assert.equal(validateContact(login, bad).website, login.website);
  assert.throws(() => validateContact({ ...login, website: "javascript:alert(1)" }, bad), /website/);
  assert.throws(() => validateContact({ ...login, password: "" }, bad), /password/);
  assert.equal(validateContact({ ...customer, password: "discard" }, bad).password, "");
});

test("credential encryption round trips, randomizes ciphertext and rejects tampering", () => {
  const originalKey = process.env.CONTACTS_ENCRYPTION_KEY;
  const originalJwtSecret = process.env.JWT_SECRET;
  try {
    process.env.CONTACTS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    const value = encryptPassword("private-password");
    assert.equal(decryptPassword(value), "private-password");
    assert.notEqual(encryptPassword("private-password"), value);
    assert.ok(!value.includes("private-password"));
    const parts = value.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    assert.throws(() => decryptPassword(parts.join(".")));
    delete process.env.CONTACTS_ENCRYPTION_KEY;
    process.env.JWT_SECRET = randomBytes(32).toString("hex");
    const derivedKeyValue = encryptPassword("private-password");
    assert.equal(decryptPassword(derivedKeyValue), "private-password");
    assert.notEqual(encryptPassword("private-password"), derivedKeyValue);
    process.env.JWT_SECRET = "";
    assert.throws(() => encryptPassword("password"), /requires JWT_SECRET/);
    assert.equal(encryptPassword(""), "");
  } finally {
    if (originalKey === undefined) delete process.env.CONTACTS_ENCRYPTION_KEY;
    else process.env.CONTACTS_ENCRYPTION_KEY = originalKey;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }
});

test("routes persist records, enforce outlet access and reject unauthorized roles", async () => {
  const app = express();
  app.use(express.json());
  const stored = [];
  let lastQuery;
  const pool = { query: async (sql, params) => {
    lastQuery = { sql, params };
    if (sql.startsWith("INSERT")) {
      const [outlet_id, tab, name, company, category, phone, email, website, username, password_encrypted, notes] = params;
      const row = { id: "11111111-1111-4111-8111-111111111111", outlet_id, tab, name, company, category, phone, email, website, username, password_encrypted, notes };
      stored.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("DELETE")) return { rows: stored.splice(0, 1) };
    if (sql.startsWith("UPDATE")) {
      const row = stored.find((item) => item.id === params[0] && item.outlet_id === params[1] && item.tab === params[11]);
      if (!row) return { rows: [] };
      row.name = params[2];
      return { rows: [row] };
    }
    return { rows: stored.filter((row) => row.outlet_id === params[0]) };
  } };
  app.use((req, _res, next) => { req.user = { role: req.headers["x-role"] || "owner" }; next(); });
  registerContacts(app, {
    pool, bad, wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next),
    assertOutlet: async (_pool, _user, id) => {
      if (id !== "allowed") throw bad("Outlet not found.", 404);
      return { id };
    },
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/contacts`;
  try {
    let response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...customer, outletId: "allowed" }) });
    assert.equal(response.status, 201);
    const created = await response.json();
    response = await fetch(`${url}?outletId=allowed`);
    assert.equal((await response.json()).length, 1);
    assert.equal(response.headers.get("cache-control"), "no-store");
    response = await fetch(`${url}/${created.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...customer, name: "Updated", outletId: "allowed" }) });
    assert.equal((await response.json()).name, "Updated");
    assert.match(lastQuery.sql, /outlet_id=\$2 AND tab=\$12/);
    assert.equal((await fetch(`${url}?outletId=other`)).status, 404);
    assert.equal((await fetch(`${url}?outletId=allowed`, { headers: { "x-role": "staff" } })).status, 403);
    assert.equal((await fetch(`${url}/${created.id}?outletId=allowed`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${url}/${created.id}?outletId=allowed`, { method: "DELETE" })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
