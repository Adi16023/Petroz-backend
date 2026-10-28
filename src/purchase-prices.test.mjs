import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { registerWrites } from "./writes.mjs";

test("purchases atomically update stock and current CP/SP in save order, preserving earlier daily prices", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings_id text, name text, kind text,
        purchase_price numeric(14,2), selling_price numeric(14,2), price_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE purchases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id text, user_id text, shift_id text,
        kind text, status text, doc_no text, doc_date date, due_date date, amount numeric, charges numeric, net numeric,
        mode text, category text, reference text, note text, created_by text);
      CREATE TABLE purchase_items (purchase_id uuid REFERENCES purchases(id), product_id uuid, equipment_id text,
        description text, qty numeric, rate numeric, amount numeric, qty_received numeric);
      CREATE TABLE balances (outlet_id text, product_id uuid, on_hand numeric, min_qty numeric, PRIMARY KEY(outlet_id,product_id));
      CREATE TABLE equipment (id uuid DEFAULT gen_random_uuid(), outlet_id text, product_id uuid, kind text, label text, live_qty numeric);
      CREATE TABLE activity (outlet_id text, actor_id text, action text, detail text, target_table text, target_id uuid);
      INSERT INTO products (settings_id,name,kind,purchase_price,selling_price,created_at) VALUES
        ('dealer','Oil','lube',250,400,'2026-01-01'), ('dealer','Water','fmcg',10,20,'2026-01-01'),
        ('dealer','Petrol','fuel',80,100,'2026-01-01'), ('other-dealer','Other oil','lube',1,2,'2026-01-01');
      INSERT INTO equipment (outlet_id,product_id,kind,label,live_qty) SELECT 'outlet',id,'tank','Tank',0 FROM products WHERE name='Petrol';
    `);
    await db.exec(readFileSync(new URL("../db/product-prices.sql", import.meta.url), "utf8"));
    const routes = new Map();
    const app = Object.fromEntries(["get", "post", "put", "patch", "delete"].map((method) => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
    let failActivity = false;
    const client = {
      query: (sql, params) => {
        if (failActivity && sql.includes("INSERT INTO activity")) throw new Error("Activity failed");
        return db.query(sql, params);
      },
      release() {},
    };
    const pool = { query: client.query, connect: async () => client };
    const bad = (message, status = 400) => Object.assign(new Error(message), { status });
    registerWrites(app, { pool, wrap: (handler) => handler, bad, assertOutlet: async () => ({ id: "outlet", settings_id: "dealer" }) });
    async function purchase(name, rate, sellingPrice, options = {}) {
      const line = { productName: name, qty: 100, qtyReceived: 100, rate, amount: 100 * rate, ...options.line };
      if (sellingPrice !== undefined) line.sellingPrice = sellingPrice;
      const body = { outletId: "outlet", kind: "purchase", status: "received", docDate: "2026-10-28", lines: [line], ...options.body };
      const res = { status(code) { assert.equal(code, 201); return this; }, json(value) { return value; } };
      await routes.get("post /api/documents")({ user: { id: "owner", role: "owner", settings_id: "dealer" }, body }, res);
    }
    const prices = async (name) => (await db.query("SELECT purchase_price::float AS cp, selling_price::float AS sp FROM products WHERE name=$1", [name])).rows[0];
    await purchase("Oil", 300, 450);
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances")).rows[0].qty, 100);
    await purchase("Oil", 320, 470, { body: { docDate: "2026-01-03" } });
    assert.deepEqual(await prices("Oil"), { cp: 320, sp: 470 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances")).rows[0].qty, 200);
    const history = (await db.query("SELECT h.day::text, h.purchase_price::float AS cp, h.selling_price::float AS sp FROM product_daily_prices h JOIN products p ON p.id=h.product_id WHERE p.name='Oil' ORDER BY h.day")).rows;
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], { day: "2026-01-01", cp: 250, sp: 400 });
    const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS day")).rows[0].day;
    assert.deepEqual(history[1], { day: today, cp: 320, sp: 470 });
    await purchase("Water", 15, 25);
    assert.deepEqual(await prices("Water"), { cp: 15, sp: 25 });
    await purchase("Petrol", 90, 110);
    assert.deepEqual(await prices("Petrol"), { cp: 90, sp: 110 });
    assert.equal((await db.query("SELECT live_qty::float AS qty FROM equipment")).rows[0].qty, 100);
    assert.ok((await db.query("SELECT price_at FROM products WHERE name='Petrol'")).rows[0].price_at);
    await purchase("Oil", 999, undefined);
    assert.deepEqual(await prices("Oil"), { cp: 320, sp: 470 });
    await purchase("Oil", 999, 999, { body: { kind: "purchase_order" }, line: { qtyReceived: 0 } });
    assert.deepEqual(await prices("Oil"), { cp: 320, sp: 470 });
    for (const invalid of [-1, null, "", "bad", true, 1e15]) {
      await assert.rejects(purchase("Oil", 300, invalid), /valid selling price/);
    }
    await assert.rejects(purchase("Oil", -1, 450), /valid purchase rate/);
    await assert.rejects(purchase("Other oil", 300, 450), /existing product/);
    const before = (await db.query("SELECT count(*)::int AS n FROM purchases")).rows[0].n;
    failActivity = true;
    await assert.rejects(purchase("Oil", 500, 600), /Activity failed/);
    failActivity = false;
    assert.equal((await db.query("SELECT count(*)::int AS n FROM purchases")).rows[0].n, before);
    assert.deepEqual(await prices("Oil"), { cp: 320, sp: 470 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances b JOIN products p ON p.id=b.product_id WHERE p.name='Oil'")).rows[0].qty, 300);
    await purchase("Oil", 0, 0);
    assert.deepEqual(await prices("Oil"), { cp: 0, sp: 0 });
  } finally { await db.close(); }
});
