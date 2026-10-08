const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clip(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function uuidOrNull(value) {
  const text = String(value ?? "").trim();
  return UUID.test(text) ? text : null;
}

function shiftDay(startsAt) {
  return new Date(startsAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function atOnShift(startsAt, timeText) {
  const match = String(timeText ?? "").match(/^(\d{2}):(\d{2})/);
  const day = shiftDay(startsAt);
  if (!match) return new Date().toISOString();
  const at = new Date(`${day}T${match[1]}:${match[2]}:00+05:30`);
  return Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString();
}

function entryOf(body) {
  const raw = body?.entry && typeof body.entry === "object" ? body.entry : {};
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const notes = raw.totalNotes && typeof raw.totalNotes === "object" ? raw.totalNotes : {};
  const incident = raw.incident && typeof raw.incident === "object" ? raw.incident : {};
  const handover = raw.handover && typeof raw.handover === "object" ? raw.handover : {};
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.map((name) => clip(name, 120)).filter(Boolean).slice(0, 12) : [];
  return {
    remarks: clip(raw.remarks),
    lubeNotes: clip(raw.lubeNotes),
    paymentNotes: clip(raw.paymentNotes),
    weather: clip(raw.weather, 40),
    footfall: clip(raw.footfall, 40),
    events: clip(raw.events, 40),
    otherNotes: clip(raw.otherNotes),
    totals: {
      cash: num(totals.cash) ?? 0,
      card: num(totals.card) ?? 0,
      upi: num(totals.upi) ?? 0,
      credit: num(totals.credit) ?? 0,
      other: num(totals.other) ?? 0,
    },
    totalNotes: {
      cash: clip(notes.cash, 200),
      card: clip(notes.card, 200),
      upi: clip(notes.upi, 200),
      credit: clip(notes.credit, 200),
      other: clip(notes.other, 200),
    },
    incident: {
      type: clip(incident.type, 80),
      pumpId: uuidOrNull(incident.pumpId),
      description: clip(incident.description),
      status: clip(incident.status, 40),
      resolvedTime: clip(incident.resolvedTime, 40),
      resolvedBy: clip(incident.resolvedBy, 80),
    },
    handover: {
      cashierId: uuidOrNull(handover.cashierId),
      time: clip(handover.time, 40),
      notes: clip(handover.notes),
    },
    attachments,
  };
}

async function moveStock(client, outletId, productId, kind, qtyDelta) {
  if (!productId || !qtyDelta) return;
  if (kind === "fuel") {
    await client.query(
      `UPDATE equipment SET live_qty = GREATEST(0, live_qty + $3)
       WHERE id = (
         SELECT e.id FROM equipment e
         WHERE e.outlet_id = $1 AND e.kind = 'tank' AND e.product_id = $2
         ORDER BY e.label LIMIT 1
       )`,
      [outletId, productId, qtyDelta / 1000],
    );
    return;
  }
  await client.query(
    `INSERT INTO balances (outlet_id, product_id, on_hand, min_qty)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (outlet_id, product_id) DO UPDATE SET on_hand = balances.on_hand + EXCLUDED.on_hand`,
    [outletId, productId, qtyDelta],
  );
}

export function registerShiftEntry(app, { pool, wrap, bad, assertOutlet, log, money, round2, payMode }) {
  async function loadShift(req, shiftId) {
    const found = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [shiftId]);
    const shift = found.rows[0];
    if (!shift) throw bad("Shift not found.", 404);
    const outlet = await assertOutlet(pool, req.user, shift.outlet_id);
    return { shift, outlet };
  }

  async function bundle(shift, settingsId) {
    const outletId = shift.outlet_id;
    const duties = Array.isArray(shift.duties) ? shift.duties : [];
    const [nozzles, readings, previous, fuel, lubes, payments, expenses, adjustment, history, products, staff, recent] = await Promise.all([
      pool.query(
        `SELECT e.id, e.label, e.meter, e.product_id, pr.name AS product_name, pr.unit, pr.selling_price
         FROM equipment e
         LEFT JOIN products pr ON pr.id = e.product_id
         WHERE e.outlet_id = $1 AND e.kind = 'nozzle' AND e.active = true
         ORDER BY e.label`,
        [outletId],
      ),
      pool.query(
        `SELECT equipment_id, kind, qty FROM dip_readings
         WHERE shift_id = $1 AND kind IN ('opening', 'closing')`,
        [shift.id],
      ),
      pool.query(
        `SELECT DISTINCT ON (equipment_id) equipment_id, qty
         FROM dip_readings
         WHERE kind = 'closing'
           AND equipment_id IN (
             SELECT id FROM equipment WHERE outlet_id = $1 AND kind = 'nozzle'
           )
           AND (
             (at < $2 AND COALESCE(remarks, '') <> 'previous closing')
             OR remarks = 'previous closing'
           )
         ORDER BY equipment_id, at DESC`,
        [outletId, shift.starts_at],
      ),
      pool.query(
        `SELECT l.equipment_id, l.qty, l.rate, l.test_qty
         FROM sale_items l
         JOIN sales s ON s.id = l.sale_id
         WHERE s.shift_id = $1 AND s.category = 'shift_fuel' AND s.status <> 'cancelled'`,
        [shift.id],
      ),
      pool.query(
        `SELECT s.id, s.created_at, s.doc_no, s.mode::text AS mode, s.vehicle, s.note,
                l.product_id, l.description, l.qty, l.rate, l.amount, pr.name AS product_name, pr.brand, pr.unit
         FROM sales s
         JOIN sale_items l ON l.sale_id = s.id
         LEFT JOIN products pr ON pr.id = l.product_id
         WHERE s.shift_id = $1 AND s.category = 'shift_lube' AND s.status <> 'cancelled'
         ORDER BY s.created_at`,
        [shift.id],
      ),
      pool.query(
        `SELECT d.id, d.created_at, d.mode::text AS mode, d.category, d.reference, d.note, d.vehicle, d.net, u.name AS party_name
         FROM documents d
         LEFT JOIN users u ON u.id = d.user_id
         WHERE d.shift_id = $1 AND d.kind = 'payment' AND d.category IN ('shift_payment', 'shift_other') AND d.status <> 'cancelled'
         ORDER BY d.created_at`,
        [shift.id],
      ),
      pool.query(
        `SELECT id, category, amount, mode::text AS mode, note
         FROM expenses
         WHERE shift_id = $1 AND kind = 'expense' AND status <> 'cancelled'
         ORDER BY created_at`,
        [shift.id],
      ),
      pool.query(
        `SELECT id, category, amount, note
         FROM documents
         WHERE shift_id = $1 AND kind = 'adjustment' AND category IN ('shift_cash_in', 'shift_cash_out') AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1`,
        [shift.id],
      ),
      pool.query(
        `SELECT e.doc_date, e.category, e.amount, e.mode::text AS mode, e.note, u.name AS party_name
         FROM expenses e
         LEFT JOIN users u ON u.id = e.created_by
         WHERE e.outlet_id = $1 AND (e.shift_id IS NULL OR e.shift_id <> $2) AND e.kind = 'expense' AND e.status <> 'cancelled'
         ORDER BY e.doc_date DESC, e.created_at DESC
         LIMIT 20`,
        [outletId, shift.id],
      ),
      pool.query(
        `SELECT id, name, brand, unit, selling_price
         FROM products
         WHERE settings_id = $1 AND kind IN ('lube', 'fmcg')
         ORDER BY name`,
        [settingsId],
      ),
      pool.query(
        `SELECT id, name, employee_code
         FROM users
         WHERE settings_id = $1 AND role IN ('staff', 'manager') AND active = true
           AND (outlet_id IS NULL OR outlet_id = $2)
         ORDER BY name`,
        [settingsId, outletId],
      ),
      pool.query(
        `SELECT r.equipment_id, r.kind, r.qty, r.at
         FROM dip_readings r
         JOIN equipment e ON e.id = r.equipment_id
         WHERE e.outlet_id = $1 AND e.kind = 'nozzle' AND r.kind IN ('opening', 'closing')
         ORDER BY r.at DESC
         LIMIT 60`,
        [outletId],
      ),
    ]);

    const savedMeters = shift.entry && typeof shift.entry === "object" && shift.entry.meters && typeof shift.entry.meters === "object"
      ? shift.entry.meters
      : {};
    const opening = new Map(readings.rows.filter((row) => row.kind === "opening").map((row) => [row.equipment_id, num(row.qty)]));
    const prev = new Map(previous.rows.map((row) => [row.equipment_id, num(row.qty) ?? 0]));
    const fuelByNozzle = new Map(fuel.rows.map((row) => [row.equipment_id, row]));
    const recentByNozzle = new Map();
    for (const row of recent.rows) {
      const list = recentByNozzle.get(row.equipment_id) ?? [];
      if (list.length < 5) list.push({ at: row.at, kind: row.kind, qty: num(row.qty) });
      recentByNozzle.set(row.equipment_id, list);
    }
    const dutyIds = [...new Set(duties.map((duty) => duty.userId).filter(Boolean))];
    const dutyUsers = dutyIds.length
      ? await pool.query(`SELECT id, name, employee_code FROM users WHERE id = ANY($1::uuid[])`, [dutyIds])
      : { rows: [] };

    return {
      shift: {
        id: shift.id,
        outletId,
        label: shift.label,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        status: shift.status,
        expectedCash: num(shift.expected_cash) ?? 0,
        declaredCash: num(shift.declared_cash),
        entry: shift.entry && typeof shift.entry === "object" ? shift.entry : {},
      },
      duties: dutyUsers.rows.map((row) => ({
        id: row.id,
        name: row.name,
        employeeCode: row.employee_code,
      })),
      nozzles: nozzles.rows.map((row) => {
        const savedOpen = opening.has(row.id);
        const openQty = savedOpen ? opening.get(row.id) ?? 0 : prev.get(row.id) ?? 0;
        const line = fuelByNozzle.get(row.id);
        const baseline = prev.has(row.id) ? prev.get(row.id) ?? 0 : num(row.meter) ?? 0;
        const savedPrevious = savedMeters[row.id];
        const previousReading = savedPrevious == null || savedPrevious === "" ? baseline : num(savedPrevious) ?? baseline;
        const sold = round2(openQty - previousReading);
        return {
          id: row.id,
          label: row.label,
          fuel: row.product_name || "Fuel",
          unit: row.unit || "L",
          previous: savedPrevious == null || savedPrevious === "" ? baseline : num(savedPrevious) ?? baseline,
          opening: savedOpen ? openQty : (prev.has(row.id) ? prev.get(row.id) ?? 0 : num(row.meter) ?? 0),
          qty: sold ?? 0,
          test: num(line?.test_qty) ?? 0,
          rate: num(line?.rate) ?? num(row.selling_price) ?? 0,
          recent: recentByNozzle.get(row.id) ?? [],
        };
      }),
      lubes: lubes.rows.map((row) => ({
        id: row.id,
        at: row.created_at,
        productId: row.product_id,
        productName: row.product_name || row.description,
        brand: row.brand,
        qty: num(row.qty) ?? 0,
        unit: row.unit || "",
        rate: num(row.rate) ?? 0,
        amount: num(row.amount) ?? 0,
        mode: row.mode || "cash",
        vehicle: row.vehicle,
        note: row.note,
        docNo: row.doc_no,
      })),
      payments: payments.rows.map((row) => ({
        id: row.id,
        at: row.created_at,
        mode: row.category === "shift_other" ? "other" : row.mode,
        customer: row.party_name || row.vehicle || row.note,
        reference: row.reference,
        amount: num(row.net) ?? 0,
      })),
      expenses: expenses.rows.map((row) => ({
        id: row.id,
        category: row.category,
        amount: num(row.amount) ?? 0,
        mode: row.mode || "cash",
        note: row.note,
      })),
      adjustment: adjustment.rows[0]
        ? {
            type: adjustment.rows[0].category === "shift_cash_in" ? "in" : "out",
            amount: num(adjustment.rows[0].amount) ?? 0,
            note: adjustment.rows[0].note,
          }
        : null,
      history: history.rows.map((row) => ({
        date: row.doc_date,
        category: row.category,
        amount: num(row.amount) ?? 0,
        mode: row.mode || "cash",
        note: row.note,
        by: row.party_name,
      })),
      products: products.rows.map((row) => ({
        id: row.id,
        name: row.name,
        brand: row.brand,
        unit: row.unit,
        rate: num(row.selling_price) ?? 0,
      })),
      staff: staff.rows.map((row) => ({
        id: row.id,
        name: row.name,
        employeeCode: row.employee_code,
      })),
    };
  }

  app.get("/api/shifts/:id/entry", wrap(async (req, res) => {
    const { shift, outlet } = await loadShift(req, req.params.id);
    res.json(await bundle(shift, outlet.settings_id));
  }));

  app.put("/api/shifts/:id/entry", wrap(async (req, res) => {
    const { shift, outlet } = await loadShift(req, req.params.id);
    if (shift.status === "closed") throw bad("This shift is already closed.");
    const submit = Boolean(req.body?.submit);
    const pumps = Array.isArray(req.body?.pumps) ? req.body.pumps : [];
    const meters = {};
    for (const row of pumps) {
      const id = uuidOrNull(row.equipmentId);
      if (!id || row.previous == null || row.previous === "") continue;
      meters[id] = money(row.previous);
    }
    const entry = { ...entryOf(req.body), meters };
    const lubes = Array.isArray(req.body?.lubes) ? req.body.lubes : [];
    const payments = Array.isArray(req.body?.payments) ? req.body.payments : [];
    const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
    const adjustment = req.body?.adjustment && typeof req.body.adjustment === "object" ? req.body.adjustment : null;
    const saleStatus = submit ? "paid" : "draft";
    const docStatus = submit ? "approved" : "draft";
    const expenseStatus = req.user.role === "staff" ? "pending" : submit ? "approved" : "draft";
    const docDate = shiftDay(shift.starts_at);
    const nozzleIds = pumps.map((row) => uuidOrNull(row.equipmentId)).filter(Boolean);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT l.qty, l.product_id, pr.kind
         FROM sale_items l
         JOIN sales s ON s.id = l.sale_id
         LEFT JOIN products pr ON pr.id = l.product_id
         WHERE s.shift_id = $1 AND s.category IN ('shift_fuel', 'shift_lube') AND s.status <> 'cancelled'`,
        [shift.id],
      );
      for (const row of owned.rows) {
        await moveStock(client, outlet.id, row.product_id, row.kind, Number(row.qty) || 0);
      }
      await client.query(
        `DELETE FROM sale_items WHERE sale_id IN (
           SELECT id FROM sales WHERE shift_id = $1 AND category IN ('shift_fuel', 'shift_lube')
         )`,
        [shift.id],
      );
      await client.query(
        `DELETE FROM sales WHERE shift_id = $1 AND category IN ('shift_fuel', 'shift_lube')`,
        [shift.id],
      );
      await client.query(
        `DELETE FROM dip_readings WHERE shift_id = $1 AND kind IN ('opening', 'closing')`,
        [shift.id],
      );
      await client.query(
        `DELETE FROM documents
         WHERE shift_id = $1 AND status <> 'cancelled'
           AND (
             (kind = 'payment' AND category IN ('shift_payment', 'shift_other'))
             OR (kind = 'adjustment' AND category IN ('shift_cash_in', 'shift_cash_out'))
           )`,
        [shift.id],
      );
      await client.query(`DELETE FROM expenses WHERE shift_id = $1 AND kind = 'expense'`, [shift.id]);

      const equipment = nozzleIds.length
        ? await client.query(
            `SELECT e.id, e.product_id, pr.name AS product_name, pr.kind
             FROM equipment e
             LEFT JOIN products pr ON pr.id = e.product_id
             WHERE e.outlet_id = $1 AND e.kind = 'nozzle' AND e.id = ANY($2::uuid[])`,
            [outlet.id, nozzleIds],
          )
        : { rows: [] };
      const nozzleById = new Map(equipment.rows.map((row) => [row.id, row]));

      for (const row of pumps) {
        const id = uuidOrNull(row.equipmentId);
        const nozzle = id ? nozzleById.get(id) : null;
        if (!nozzle) continue;
        const opening = money(row.opening);
        if (row.previous != null && row.previous !== "") {
          const value = money(row.previous);
          const stamped = await client.query(
            `SELECT qty FROM dip_readings
             WHERE equipment_id = $1 AND kind = 'closing' AND remarks = 'previous closing'
             ORDER BY at DESC
             LIMIT 1`,
            [nozzle.id],
          );
          const applied = stamped.rows[0] ? Number(stamped.rows[0].qty) : null;
          if (applied == null || Math.round(applied * 1000) !== Math.round(value * 1000)) {
            await client.query(
              `INSERT INTO dip_readings (equipment_id, user_id, kind, qty, remarks)
               VALUES ($1, $2, 'closing', $3, 'previous closing')`,
              [nozzle.id, req.user.id, value],
            );
          }
        }
        const sold = Math.max(0, round2(opening - money(row.previous)));
        const test = Math.min(sold, Math.max(0, money(row.test)));
        const rate = Math.max(0, money(row.rate));
        const netQty = Math.max(0, sold - test);
        const amount = round2(netQty * rate);
        const closing = opening;
        await client.query(
          `INSERT INTO dip_readings (shift_id, equipment_id, user_id, kind, qty)
           VALUES ($1, $2, $3, 'opening'::reading_kind, $4), ($1, $2, $3, 'closing'::reading_kind, $5)`,
          [shift.id, nozzle.id, req.user.id, opening, closing],
        );
        await client.query(`UPDATE equipment SET meter = $2 WHERE id = $1`, [nozzle.id, closing]);
        if (!(sold > 0) && !(amount > 0)) continue;
        const inserted = await client.query(
          `INSERT INTO sales (
             outlet_id, user_id, shift_id, status, doc_date, amount, net, category, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'shift_fuel', $2)
           RETURNING id`,
          [outlet.id, req.user.id, shift.id, saleStatus, docDate, amount],
        );
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, equipment_id, description, qty, rate, amount, test_qty)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [inserted.rows[0].id, nozzle.product_id, nozzle.id, nozzle.product_name, netQty, rate, amount, test],
        );
        if (nozzle.kind === "fuel") await moveStock(client, outlet.id, nozzle.product_id, "fuel", -netQty);
      }

      for (const row of lubes) {
        const qty = Math.max(0, money(row.qty));
        const rate = Math.max(0, money(row.rate));
        const amount = round2(qty * rate);
        if (!(qty > 0) && !(amount > 0)) continue;
        const product = uuidOrNull(row.productId)
          ? await client.query(
              `SELECT id, name, kind FROM products WHERE id = $1 AND settings_id = $2`,
              [row.productId, outlet.settings_id],
            )
          : { rows: [] };
        const item = product.rows[0];
        if (!item || item.kind === "fuel") continue;
        const mode = payMode(row.mode);
        const status = submit && mode === "credit" ? "open" : saleStatus;
        const inserted = await client.query(
          `INSERT INTO sales (
             outlet_id, user_id, shift_id, status, doc_no, doc_date, amount, net, mode, category, vehicle, note, created_by, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'shift_lube',$9,$10,$2,$11)
           RETURNING id`,
          [
            outlet.id, req.user.id, shift.id, status, clip(row.docNo, 40) || null, docDate, amount, mode,
            clip(row.vehicle, 80) || null, clip(row.note, 200) || null, atOnShift(shift.starts_at, row.time),
          ],
        );
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, description, qty, rate, amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [inserted.rows[0].id, item.id, item.name, qty, rate, amount],
        );
        await moveStock(client, outlet.id, item.id, item.kind, -qty);
      }

      for (const row of payments) {
        const amount = round2(money(row.amount));
        if (!(amount > 0)) continue;
        const other = String(row.mode ?? "").toLowerCase() === "other";
        const mode = other ? null : payMode(row.mode);
        const customer = clip(row.customer, 120);
        await client.query(
          `INSERT INTO documents (
             outlet_id, user_id, shift_id, kind, status, doc_date, amount, net, mode, category, reference, vehicle, created_by, created_at
           ) VALUES ($1, NULL, $2, 'payment', $3, $4, $5, $5, $6, $7, $8, $9, $10, $11)`,
          [
            outlet.id, shift.id, docStatus, docDate, amount, mode,
            other ? "shift_other" : "shift_payment",
            clip(row.reference, 80) || null,
            customer || null,
            req.user.id,
            Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toISOString() : new Date().toISOString(),
          ],
        );
      }

      let cashExpenses = 0;
      for (const row of expenses) {
        const amount = round2(money(row.amount));
        const category = clip(row.category, 80);
        if (!(amount > 0) || !category) continue;
        const mode = payMode(row.mode) || "cash";
        if (mode === "cash") cashExpenses = round2(cashExpenses + amount);
        await client.query(
          `INSERT INTO expenses (
             outlet_id, user_id, shift_id, kind, status, doc_date, amount, net, mode, category, note, created_by
           ) VALUES ($1,$2,$3,'expense',$4,$5,$6,$6,$7,$8,$9,$2)`,
          [outlet.id, req.user.id, shift.id, expenseStatus, docDate, amount, mode, category, clip(row.note, 200) || null],
        );
      }

      let cashAdjust = 0;
      const adjustAmount = round2(money(adjustment?.amount));
      const adjustType = adjustment?.type === "in" ? "in" : adjustment?.type === "out" ? "out" : "";
      if (adjustType && adjustAmount > 0) {
        cashAdjust = adjustType === "in" ? adjustAmount : -adjustAmount;
        await client.query(
          `INSERT INTO documents (
             outlet_id, shift_id, kind, status, doc_date, amount, net, mode, category, note, created_by
           ) VALUES ($1,$2,'adjustment',$3,$4,$5,$5,'cash',$6,$7,$8)`,
          [
            outlet.id, shift.id, docStatus, docDate, adjustAmount,
            adjustType === "in" ? "shift_cash_in" : "shift_cash_out",
            clip(adjustment.note, 200) || null, req.user.id,
          ],
        );
      }

      const expected = round2((entry.totals.cash || 0) - cashExpenses + cashAdjust);
      if (submit) {
        await client.query(
          `UPDATE shifts
           SET entry = $2::jsonb, status = 'closed', expected_cash = $3, declared_cash = $3, closed_by = $4
           WHERE id = $1`,
          [shift.id, JSON.stringify(entry), expected, req.user.id],
        );
      } else {
        await client.query(`UPDATE shifts SET entry = $2::jsonb WHERE id = $1`, [shift.id, JSON.stringify(entry)]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await log(req.user, outlet.id, "shift", submit ? "Shift submitted" : "Shift entry saved", "shifts", shift.id);
    const fresh = await pool.query(`SELECT * FROM shifts WHERE id = $1`, [shift.id]);
    res.json(await bundle(fresh.rows[0], outlet.settings_id));
  }));
}
