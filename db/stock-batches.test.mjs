import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL("./stock-batches.sql", import.meta.url), "utf8");
const outlet = "00000000-0000-4000-8000-000000000001";
const secondOutlet = "00000000-0000-4000-8000-000000000002";
const product = "00000000-0000-4000-8000-000000000003";

export async function stockDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),settings_id uuid,name text,kind text,
      purchase_price numeric(14,2),selling_price numeric(14,2),created_at timestamptz DEFAULT now(),price_at timestamptz);
    CREATE TABLE balances(outlet_id uuid,product_id uuid REFERENCES products(id),on_hand numeric(14,3) DEFAULT 0,
      min_qty numeric DEFAULT 0,PRIMARY KEY(outlet_id,product_id));
    CREATE TABLE sales(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),outlet_id uuid,status text);
    CREATE TABLE sale_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_id uuid REFERENCES sales(id),product_id uuid,
      qty numeric,rate numeric,amount numeric);
    CREATE TABLE purchase_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid,qty numeric,qty_received numeric,rate numeric);
    INSERT INTO products(id,kind,name,purchase_price,selling_price) VALUES('${product}','lube','Oil',10,20);
    INSERT INTO balances(outlet_id,product_id,on_hand) VALUES('${outlet}','${product}',5),('${secondOutlet}','${product}',4);
  `);
  await db.exec(migration);
  return db;
}

test("FIFO incoming batches promote at zero, split sale costs, restore exact batches and isolate outlets", async () => {
  const db = await stockDatabase();
  try {
    const stock = async (id = outlet) => (await db.query("SELECT on_hand::float AS total,purchase_price::float AS cp,selling_price::float AS sp FROM balances WHERE outlet_id=$1", [id])).rows[0];
    const batchRows = async () => (await db.query("SELECT remaining::float AS qty,purchase_price::float AS cp,selling_price::float AS sp FROM stock_batches WHERE outlet_id=$1 ORDER BY id", [outlet])).rows;
    await db.query("SELECT move_shop_stock($1,$2,100,30,40)", [outlet, product]);
    await db.query("SELECT move_shop_stock($1,$2,50,50,60)", [outlet, product]);
    assert.deepEqual(await stock(), { total: 155, cp: 10, sp: 20 });
    assert.deepEqual(await batchRows(), [{ qty: 5, cp: 10, sp: 20 }, { qty: 100, cp: 30, sp: 40 }, { qty: 50, cp: 50, sp: 60 }]);
    await db.exec(migration);
    assert.equal((await batchRows()).length, 3);
    const sale = (await db.query("INSERT INTO sales(outlet_id,status) VALUES($1,'paid') RETURNING id", [outlet])).rows[0].id;
    const item = (await db.query("INSERT INTO sale_items(sale_id,product_id,qty,rate,amount) VALUES($1,$2,8,20,160) RETURNING id", [sale, product])).rows[0].id;
    await db.query("SELECT move_shop_stock($1,$2,-8,NULL,NULL,NULL,$3)", [outlet, product, item]);
    assert.deepEqual(await stock(), { total: 147, cp: 30, sp: 40 });
    assert.deepEqual((await db.query("SELECT stock_cost::float AS cost,rate::float AS rate,amount::float AS amount FROM sale_items WHERE id=$1", [item])).rows[0], { cost: 140, rate: 20, amount: 160 });
    assert.deepEqual(await stock(secondOutlet), { total: 4, cp: 10, sp: 20 });
    assert.deepEqual(await batchRows(), [{ qty: 0, cp: 10, sp: 20 }, { qty: 97, cp: 30, sp: 40 }, { qty: 50, cp: 50, sp: 60 }]);
    await db.query("UPDATE sales SET status='cancelled' WHERE id=$1", [sale]);
    assert.deepEqual(await stock(), { total: 155, cp: 10, sp: 20 });
    await db.query("UPDATE sales SET status='paid' WHERE id=$1", [sale]);
    assert.deepEqual(await stock(), { total: 147, cp: 30, sp: 40 });
    await db.query("DELETE FROM sale_items WHERE id=$1", [item]);
    assert.deepEqual(await stock(), { total: 155, cp: 10, sp: 20 });
    await db.exec("BEGIN");
    await assert.rejects(db.query("SELECT move_shop_stock($1,$2,-1000)", [outlet, product]), /Insufficient stock/);
    await db.exec("ROLLBACK");
    assert.deepEqual(await stock(), { total: 155, cp: 10, sp: 20 });
    await db.query("SELECT move_shop_stock($1,$2,-5)", [outlet, product]);
    assert.deepEqual(await stock(), { total: 150, cp: 30, sp: 40 });
    await db.query("SELECT move_shop_stock($1,$2,-100)", [outlet, product]);
    assert.deepEqual(await stock(), { total: 50, cp: 50, sp: 60 });
    await db.query("SELECT move_shop_stock($1,$2,-50)", [outlet, product]);
    await db.query("SELECT move_shop_stock($1,$2,100,70,80)", [outlet, product]);
    assert.deepEqual(await stock(), { total: 100, cp: 70, sp: 80 });
  } finally { await db.close(); }
});

test("unused incoming purchase edits/deletes adjust the queue; consumed purchases cannot be rewritten", async () => {
  const db = await stockDatabase();
  try {
    const item = (await db.query("INSERT INTO purchase_items(product_id,qty,qty_received,rate) VALUES($1,100,100,30) RETURNING id", [product])).rows[0].id;
    await db.query("SELECT move_shop_stock($1,$2,100,30,40,$3)", [outlet, product, item]);
    await db.query("UPDATE purchase_items SET qty=80,qty_received=80,rate=35 WHERE id=$1", [item]);
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances WHERE outlet_id=$1", [outlet])).rows[0].qty, 85);
    assert.equal((await db.query("SELECT purchase_price::float AS cp FROM balances WHERE outlet_id=$1", [outlet])).rows[0].cp, 10);
    await db.query("SELECT move_shop_stock($1,$2,-6)", [outlet, product]);
    await assert.rejects(db.query("UPDATE purchase_items SET rate=99 WHERE id=$1", [item]), /already been sold/);
    await assert.rejects(db.query("DELETE FROM purchase_items WHERE id=$1", [item]), /already been sold/);
    const unused = (await db.query("INSERT INTO purchase_items(product_id,qty,qty_received,rate) VALUES($1,50,50,45) RETURNING id", [product])).rows[0].id;
    await db.query("SELECT move_shop_stock($1,$2,50,45,55,$3)", [outlet, product, unused]);
    await db.query("DELETE FROM purchase_items WHERE id=$1", [unused]);
    assert.equal((await db.query("SELECT on_hand::float AS qty FROM balances WHERE outlet_id=$1", [outlet])).rows[0].qty, 79);
  } finally { await db.close(); }
});
