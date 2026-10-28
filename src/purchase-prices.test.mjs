import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { registerWrites } from "./writes.mjs";

test("purchases atomically queue shop CP/SP while fuel prices still update immediately", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings_id text, name text, kind text,
        purchase_price numeric(14,2), selling_price numeric(14,2), price_at timestamptz, created_at timestamptz DEFAULT now(),
        unit text,gst numeric,active boolean DEFAULT true);
      CREATE TABLE purchases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid, user_id text, shift_id text,
        kind text, status text, doc_no text, doc_date date, due_date date, amount numeric, charges numeric, net numeric,
        mode text, category text, reference text, note text, created_by text);
      CREATE TABLE purchase_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purchase_id uuid REFERENCES purchases(id), product_id uuid, equipment_id text,
        description text, qty numeric, rate numeric, amount numeric, qty_received numeric);
      CREATE TABLE balances (outlet_id uuid, product_id uuid, on_hand numeric, min_qty numeric, PRIMARY KEY(outlet_id,product_id));
      CREATE TABLE sales (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),outlet_id uuid,status text,user_id text,shift_id text,
        doc_no text,doc_date date,due_date date,amount numeric,charges numeric,net numeric,mode text,category text,reference text,vehicle text,note text,created_by text);
      CREATE TABLE sale_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_id uuid,product_id uuid,equipment_id text,description text,qty numeric,rate numeric,amount numeric);
      CREATE TABLE equipment (id uuid DEFAULT gen_random_uuid(), outlet_id uuid, product_id uuid, kind text, label text, live_qty numeric);
      CREATE TABLE activity (outlet_id text, actor_id text, action text, detail text, target_table text, target_id uuid);
      INSERT INTO products (settings_id,name,kind,purchase_price,selling_price,created_at) VALUES
        ('dealer','Oil','lube',250,400,'2026-01-01'), ('dealer','Water','fmcg',10,20,'2026-01-01'),
        ('dealer','Petrol','fuel',80,100,'2026-01-01'), ('other-dealer','Other oil','lube',1,2,'2026-01-01');
      INSERT INTO equipment (outlet_id,product_id,kind,label,live_qty) SELECT '00000000-0000-4000-8000-000000000001',id,'tank','Tank',0 FROM products WHERE name='Petrol';
    `);
    await db.exec(readFileSync(new URL("../db/product-prices.sql", import.meta.url), "utf8"));
    await db.exec(readFileSync(new URL("../db/stock-batches.sql", import.meta.url), "utf8"));
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
    const outlet = "00000000-0000-4000-8000-000000000001";
    registerWrites(app, { pool, wrap: (handler) => handler, bad, assertOutlet: async () => ({ id: outlet, settings_id: "dealer" }) });
    async function purchase(name, rate, sellingPrice, options = {}) {
      const line = { productName: name, qty: 100, qtyReceived: 100, rate, amount: 100 * rate, ...options.line };
      if (sellingPrice !== undefined) line.sellingPrice = sellingPrice;
      const body = { outletId: "outlet", kind: "purchase", status: "received", docDate: "2026-10-28", lines: [line], ...options.body };
      const res = { status(code) { assert.equal(code, 201); return this; }, json(value) { return value; } };
      await routes.get("post /api/documents")({ user: { id: "owner", role: "owner", settings_id: "dealer" }, body }, res);
    }
    const prices = async (name) => (await db.query(
      "SELECT COALESCE(b.purchase_price,p.purchase_price)::float AS cp,COALESCE(b.selling_price,p.selling_price)::float AS sp FROM products p LEFT JOIN balances b ON b.product_id=p.id AND b.outlet_id=$2 WHERE p.name=$1", [name,outlet])).rows[0];
    await purchase("Oil", 300, 450);
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances")).rows[0].qty, 100);
    await purchase("Oil", 320, 470, { body: { docDate: "2026-01-03" } });
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances")).rows[0].qty, 200);
    const history = (await db.query("SELECT h.day::text, h.purchase_price::float AS cp, h.selling_price::float AS sp FROM product_daily_prices h JOIN products p ON p.id=h.product_id WHERE p.name='Oil' ORDER BY h.day")).rows;
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], { day: "2026-01-01", cp: 250, sp: 400 });
    const queued = (await db.query("SELECT s.remaining::float AS qty,s.purchase_price::float AS cp,s.selling_price::float AS sp FROM stock_batches s JOIN products p ON p.id=s.product_id WHERE p.name='Oil' AND s.remaining>0 ORDER BY s.id")).rows;
    assert.deepEqual(queued, [{ qty:100,cp:300,sp:450 },{ qty:100,cp:320,sp:470 }]);
    await purchase("Water", 15, 25);
    assert.deepEqual(await prices("Water"), { cp: 15, sp: 25 });
    await purchase("Petrol", 90, 110);
    assert.deepEqual(await prices("Petrol"), { cp: 90, sp: 110 });
    assert.equal((await db.query("SELECT live_qty::float AS qty FROM equipment")).rows[0].qty, 100);
    assert.ok((await db.query("SELECT price_at FROM products WHERE name='Petrol'")).rows[0].price_at);
    await purchase("Oil", 999, undefined);
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
    await purchase("Oil", 999, 999, { body: { kind: "purchase_order" }, line: { qtyReceived: 0 } });
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
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
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances b JOIN products p ON p.id=b.product_id WHERE p.name='Oil'")).rows[0].qty, 300);
    await purchase("Oil", 0, 0);
    assert.deepEqual(await prices("Oil"), { cp: 300, sp: 450 });
    const body = {
      outletId: outlet,kind: "sale",status: "paid",docDate: "2026-10-28",amount: 50500,net: 50500,
      lines: [{ productName: "Oil",qty: 150,rate: 450,amount: 50500 }],
    };
    const response = { status(code) { assert.equal(code,201); return this; },json() {} };
    await routes.get("post /api/documents")({ user:{ id:"owner",role:"owner",settings_id:"dealer" },body },response);
    assert.deepEqual(await prices("Oil"), { cp:320,sp:470 });
    assert.deepEqual((await db.query("SELECT stock_cost::float AS cost,rate::float AS rate,amount::float AS amount FROM sale_items")).rows[0],
      { cost:46000,rate:450,amount:50500 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances b JOIN products p ON p.id=b.product_id WHERE p.name='Oil'")).rows[0].qty,250);
    const request = (body) => routes.get("post /api/documents")({ user:{ id:"owner",role:"owner",settings_id:"dealer" },body },response);
    await assert.rejects(request({ ...body,lines:[{ ...body.lines[0],qty:-5 }] }), /Sale quantity cannot be negative/);
    await request({ ...body,status:"cancelled",lines:[{ productName:"Oil",qty:10,rate:470,amount:4700 }] });
    const cancelled = (await db.query("SELECT id FROM sales WHERE status='cancelled'")).rows[0].id;
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances b JOIN products p ON p.id=b.product_id WHERE p.name='Oil'")).rows[0].qty,250);
    await db.query("UPDATE sales SET status='paid' WHERE id=$1", [cancelled]);
    assert.deepEqual((await db.query("SELECT stock_cost::float AS cost FROM sale_items WHERE sale_id=$1", [cancelled])).rows[0], { cost:3200 });
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances b JOIN products p ON p.id=b.product_id WHERE p.name='Oil'")).rows[0].qty,240);
    await db.query("UPDATE sales SET status='cancelled' WHERE id=$1", [cancelled]);
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances b JOIN products p ON p.id=b.product_id WHERE p.name='Oil'")).rows[0].qty,250);
    const productId = (await db.query("SELECT id FROM products WHERE name='Oil'")).rows[0].id;
    const patch = (prices) => routes.get("patch /api/products/:id")({
      user:{ id:"owner",role:"owner",settings_id:"dealer" },params:{ id:productId },body:{ outletId:outlet,...prices },
    }, { json() {} });
    await patch({ sellingPrice:480 });
    assert.deepEqual(await prices("Oil"), { cp:320,sp:480 });
    await patch({ purchasePrice:250 });
    assert.deepEqual(await prices("Oil"), { cp:250,sp:480 });
    assert.deepEqual((await db.query("SELECT purchase_price::float AS cp,selling_price::float AS sp FROM stock_batches WHERE product_id=$1 AND remaining>0 ORDER BY id", [productId])).rows,
      [{ cp:250,sp:480 },{ cp:999,sp:450 },{ cp:0,sp:0 }]);
    assert.equal((await db.query("SELECT stock_cost::float AS cost FROM sale_items WHERE qty=150")).rows[0].cost,46000);
  } finally { await db.close(); }
});
