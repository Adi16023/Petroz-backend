function money(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function fuelKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stockKl(fuel, value) {
  const amount = money(value);
  const key = fuelKey(fuel);
  if (!key || key === "cng" || key.includes("ev")) return amount;
  return amount / 1000;
}

function sameQty(left, right) {
  return Math.round(Number(left) * 1000) === Math.round(Number(right) * 1000);
}

async function appendPreviousClosing(pool, equipmentId, meter) {
  const latest = await pool.query(
    `SELECT qty FROM dip_readings
     WHERE equipment_id = $1 AND kind = 'closing' AND remarks = 'previous closing'
     ORDER BY at DESC
     LIMIT 1`,
    [equipmentId],
  );
  const applied = latest.rows[0] ? Number(latest.rows[0].qty) : null;
  if (applied != null && sameQty(applied, meter)) return;
  await pool.query(
    `INSERT INTO dip_readings (equipment_id, kind, qty, remarks)
     VALUES ($1, 'closing', $2, 'previous closing')`,
    [equipmentId, meter],
  );
  await pool.query(`UPDATE equipment SET meter = $2 WHERE id = $1`, [equipmentId, meter]);
}

async function upsertFuel(pool, settingsId, ref, name, fields) {
  const { rows } = await pool.query(
    `INSERT INTO products (settings_id, kind, name, unit, gst, purchase_price, selling_price, settings_ref)
     VALUES ($1, 'fuel', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (settings_id, settings_ref) WHERE settings_ref IS NOT NULL AND settings_ref <> ''
     DO UPDATE SET
       name = EXCLUDED.name,
       unit = EXCLUDED.unit,
       gst = EXCLUDED.gst,
       purchase_price = EXCLUDED.purchase_price,
       selling_price = EXCLUDED.selling_price,
       kind = 'fuel'
     RETURNING id`,
    [settingsId, name, fields.unit, fields.gst, fields.buy, fields.sell, ref],
  );
  return rows[0].id;
}

export async function syncDeskEquipment(pool, { settingsId, outletId, desk, scope }) {
  if (!settingsId || !outletId || !desk || typeof desk !== "object" || Array.isArray(desk)) return;
  const parts = {
    fuels: scope?.fuels !== false,
    tanks: scope?.tanks !== false,
    pumps: scope?.pumps !== false,
  };

  const productByFuel = new Map();
  const keptProducts = [];

  if (parts.fuels) for (const fuel of list(desk.fuels)) {
    const name = String(fuel?.name ?? "").trim();
    const id = String(fuel?.id ?? "").trim();
    if (!name || !id || fuel.on === false) continue;
    const productId = await upsertFuel(pool, settingsId, `fuel:${id}`, name, {
      unit: String(fuel.unit ?? "").trim() || "Litre",
      gst: money(fuel.gst),
      buy: money(fuel.buy),
      sell: money(fuel.sell),
    });
    productByFuel.set(fuelKey(name), productId);
    keptProducts.push(productId);
  }

  async function productFor(name) {
    const key = fuelKey(name);
    if (!key || key === "not assigned") return null;
    const known = productByFuel.get(key);
    if (known) return known;
    const productId = await upsertFuel(pool, settingsId, `fuel-name:${key}`, String(name).trim(), {
      unit: key === "cng" ? "Kg" : "Litre",
      gst: 0,
      buy: 0,
      sell: 0,
    });
    productByFuel.set(key, productId);
    keptProducts.push(productId);
    return productId;
  }

  const tankByFuel = new Map();
  const keptTanks = [];
  if (parts.tanks) for (const tank of list(desk.tanks)) {
    const name = String(tank?.name ?? "").trim();
    const id = String(tank?.id ?? "").trim();
    if (!name || !id || tank.on === false) continue;
    const fuel = String(tank.fuel ?? "").trim();
    const productId = await productFor(fuel);
    const { rows } = await pool.query(
      `INSERT INTO equipment (outlet_id, product_id, kind, label, capacity, live_qty, settings_ref)
       VALUES ($1, $2, 'tank', $3, $4, $5, $6)
       ON CONFLICT (outlet_id, settings_ref) WHERE settings_ref IS NOT NULL AND settings_ref <> ''
       DO UPDATE SET
         product_id = EXCLUDED.product_id,
         label = EXCLUDED.label,
         capacity = EXCLUDED.capacity,
         live_qty = EXCLUDED.live_qty
       RETURNING id`,
      [outletId, productId, name, stockKl(fuel, tank.capacity), stockKl(fuel, tank.current), `tank:${id}`],
    );
    keptTanks.push(rows[0].id);
    const key = fuelKey(fuel);
    if (key && !tankByFuel.has(key)) tankByFuel.set(key, rows[0].id);
  }

  const pumps = list(desk.pumps);
  const keptNozzles = [];
  if (parts.pumps && pumps.length) for (const pump of pumps) {
    const pumpId = String(pump?.id ?? "").trim();
    if (!pumpId || pump.on === false) continue;
    const pumpName = String(pump?.name ?? "").trim() || "Pump";
    const slots = list(pump.nozzles);
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      if (!slot) continue;
      const fuel = String(slot.fuel ?? "").trim();
      const key = fuelKey(fuel);
      if (!key || key === "not assigned") continue;
      let parentId = tankByFuel.get(key) ?? null;
      const productId = await productFor(fuel);
      if (!parentId) {
        const { rows } = await pool.query(
          `INSERT INTO equipment (outlet_id, product_id, kind, label, capacity, live_qty, settings_ref)
           VALUES ($1, $2, 'tank', $3, 0, 0, $4)
           ON CONFLICT (outlet_id, settings_ref) WHERE settings_ref IS NOT NULL AND settings_ref <> ''
           DO UPDATE SET product_id = EXCLUDED.product_id, label = EXCLUDED.label
           RETURNING id`,
          [outletId, productId, fuel, `tank:auto:${key}`],
        );
        parentId = rows[0].id;
        tankByFuel.set(key, parentId);
        keptTanks.push(parentId);
      }
      const previous = String(slot.previous ?? "").trim();
      const meter = previous === "" ? null : money(previous);
      const label = `${pumpName} N${index + 1}`;
      const ref = `nozzle:${pumpId}:${index}`;
      await pool.query(
        `UPDATE equipment
         SET settings_ref = $3, pump_name = $4
         WHERE outlet_id = $1 AND kind = 'nozzle' AND label = $2
           AND (settings_ref IS NULL OR settings_ref = $3)`,
        [outletId, label, ref, pumpName],
      );
      const { rows } = await pool.query(
        `INSERT INTO equipment (outlet_id, parent_id, product_id, kind, label, meter, pump_name, settings_ref, active)
         VALUES ($1, $2, $3, 'nozzle', $4, COALESCE($5::numeric, 0), $6, $7, $8)
         ON CONFLICT (outlet_id, settings_ref) WHERE settings_ref IS NOT NULL AND settings_ref <> ''
         DO UPDATE SET
           parent_id = EXCLUDED.parent_id,
           product_id = EXCLUDED.product_id,
           label = EXCLUDED.label,
           pump_name = EXCLUDED.pump_name,
           active = EXCLUDED.active
         RETURNING id`,
        [outletId, parentId, productId, label, meter, pumpName, ref, slot.on !== false],
      );
      if (meter != null) await appendPreviousClosing(pool, rows[0].id, meter);
      keptNozzles.push(rows[0].id);
    }
  }

  if (parts.pumps && pumps.length) await pool.query(
    `DELETE FROM equipment e
     WHERE e.outlet_id = $1
       AND e.kind = 'nozzle'
       AND e.settings_ref IS NOT NULL
       AND NOT (e.id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM dip_readings r WHERE r.equipment_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.equipment_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_items p WHERE p.equipment_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM document_items d WHERE d.equipment_id = e.id)`,
    [outletId, keptNozzles],
  );
  if (parts.tanks) await pool.query(
    `DELETE FROM equipment e
     WHERE e.outlet_id = $1
       AND e.kind = 'tank'
       AND e.settings_ref IS NOT NULL
       AND NOT (e.id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM equipment child WHERE child.parent_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM dip_readings r WHERE r.equipment_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.equipment_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_items p WHERE p.equipment_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM document_items d WHERE d.equipment_id = e.id)`,
    [outletId, keptTanks],
  );
  if (parts.fuels) await pool.query(
    `DELETE FROM balances b
     USING products pr
     WHERE b.product_id = pr.id
       AND b.outlet_id = $1
       AND pr.settings_id = $2
       AND pr.settings_ref IS NOT NULL
       AND NOT (pr.id = ANY($3::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM equipment e WHERE e.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_items p WHERE p.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM document_items d WHERE d.product_id = pr.id)`,
    [outletId, settingsId, keptProducts],
  );
  if (parts.fuels) await pool.query(
    `DELETE FROM products pr
     WHERE pr.settings_id = $1
       AND pr.settings_ref IS NOT NULL
       AND NOT (pr.id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM equipment e WHERE e.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM balances b WHERE b.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_items p WHERE p.product_id = pr.id)
       AND NOT EXISTS (SELECT 1 FROM document_items d WHERE d.product_id = pr.id)`,
    [settingsId, keptProducts],
  );
}
