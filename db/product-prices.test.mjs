import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL("./product-prices.sql", import.meta.url), "utf8");

test("daily product prices preserve earlier days across every price writer and repeated migrations", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE products (
      id uuid PRIMARY KEY, kind text, purchase_price numeric(14,2), selling_price numeric(14,2), created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO products VALUES ('00000000-0000-4000-8000-000000000001', 'lube', 250, 400, '2026-01-01T20:00:00Z');`);
    await db.exec(migration);
    await db.exec(migration);
    let rows = (await db.query("SELECT day::text, purchase_price::float, selling_price::float FROM product_daily_prices ORDER BY day")).rows;
    assert.deepEqual(rows, [{ day: "2026-01-02", purchase_price: 250, selling_price: 400 }]);
    await db.exec("UPDATE products SET purchase_price = 280, selling_price = 450");
    const today = (await db.query("SELECT (statement_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS day")).rows[0].day;
    rows = (await db.query("SELECT day::text, purchase_price::float, selling_price::float FROM product_daily_prices ORDER BY day")).rows;
    assert.deepEqual(rows, [
      { day: "2026-01-02", purchase_price: 250, selling_price: 400 },
      { day: today, purchase_price: 280, selling_price: 450 },
    ]);
    await db.exec("UPDATE products SET selling_price = 460");
    await db.exec(migration);
    rows = (await db.query("SELECT day::text, purchase_price::float, selling_price::float FROM product_daily_prices ORDER BY day")).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].purchase_price, 250);
    assert.equal(rows[0].selling_price, 400);
    assert.equal(rows[1].purchase_price, 280);
    assert.equal(rows[1].selling_price, 460);
    await db.exec("BEGIN; UPDATE products SET purchase_price = 999; ROLLBACK;");
    assert.equal((await db.query("SELECT purchase_price::float AS cost FROM product_daily_prices ORDER BY day DESC LIMIT 1")).rows[0].cost, 280);
    await db.exec("INSERT INTO products (id,kind,purchase_price,selling_price) VALUES ('00000000-0000-4000-8000-000000000002','fmcg',10,20)");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM product_daily_prices")).rows[0].count, 3);
    await db.exec("INSERT INTO products (id,kind,purchase_price,selling_price) VALUES ('00000000-0000-4000-8000-000000000003','fuel',90,100)");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM product_daily_prices")).rows[0].count, 3);
    await db.exec("DELETE FROM products");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM product_daily_prices")).rows[0].count, 0);
  } finally {
    await db.close();
  }
});
