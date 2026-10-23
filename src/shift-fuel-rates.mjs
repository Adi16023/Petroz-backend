export async function refreshShiftFuelRates(db, shiftId, outletId, bad) {
  await db.query(
    `SELECT p.id FROM products p
     WHERE EXISTS (
       SELECT 1 FROM sale_items l JOIN sales s ON s.id = l.sale_id
       WHERE l.product_id = p.id AND s.shift_id = $1 AND s.outlet_id = $2
         AND s.category = 'shift_fuel' AND s.status <> 'cancelled'
     )
     ORDER BY p.id FOR SHARE OF p`,
    [shiftId, outletId],
  );
  const invalid = await db.query(
    `SELECT l.id FROM sale_items l
     JOIN sales s ON s.id = l.sale_id
     LEFT JOIN products p ON p.id = l.product_id
     WHERE s.shift_id = $1 AND s.outlet_id = $2
       AND s.category = 'shift_fuel' AND s.status <> 'cancelled'
       AND (p.id IS NULL OR p.kind <> 'fuel' OR p.selling_price IS NULL OR p.selling_price <= 0)`,
    [shiftId, outletId],
  );
  if (invalid.rows.length) throw bad("Set a valid current fuel rate before closing this shift.");
  await db.query(
    `UPDATE sale_items l SET rate = p.selling_price, amount = ROUND(l.qty * p.selling_price, 2)
     FROM sales s, products p
     WHERE l.sale_id = s.id AND l.product_id = p.id
       AND s.shift_id = $1 AND s.outlet_id = $2
       AND s.category = 'shift_fuel' AND s.status <> 'cancelled'`,
    [shiftId, outletId],
  );
  await db.query(
    `UPDATE sales s SET amount = totals.amount,
       net = totals.amount + s.tax + s.charges
     FROM (
       SELECT l.sale_id, SUM(l.amount) AS amount FROM sale_items l
       JOIN sales fuel ON fuel.id = l.sale_id
       WHERE fuel.shift_id = $1 AND fuel.outlet_id = $2
         AND fuel.category = 'shift_fuel' AND fuel.status <> 'cancelled'
       GROUP BY l.sale_id
     ) totals WHERE s.id = totals.sale_id`,
    [shiftId, outletId],
  );
}
