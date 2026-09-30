import crypto from "node:crypto";
import bcrypt from "bcryptjs";

function at(hour, minute = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function chart(capacityKl) {
  return [0, 400, 800, 1200, 1400, 1480, 1600, 1720, 1800, 2000].map((mm) => ({
    mm,
    litres: Math.round(capacityKl * 1000 * (mm / 2000)),
  }));
}

export async function ensureDemo(pool) {
  const existing = await pool.query(`SELECT 1 FROM shifts LIMIT 1`);
  if (existing.rows.length) return { seeded: false };

  const outlets = await pool.query(`SELECT id, code, settings_id FROM outlets`);
  const wfd = outlets.rows.find((row) => row.code === "WFD");
  const tng = outlets.rows.find((row) => row.code === "TNG");
  if (!wfd || !tng) return { seeded: false };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const settingsId = wfd.settings_id;
    const ids = {};

    async function person(key, fields, outletIds) {
      const hash = await bcrypt.hash(fields.password, 10);
      const outletId = outletIds.length === 1 ? outletIds[0] : null;
      const row = await client.query(
        `INSERT INTO users (
           settings_id, outlet_id, role, staff_type, name, phone, alt_phone, email, password_hash,
           designation, permission_grants, permission_revokes, manager_can_assign,
           address, gstin, customer_type, vehicle, credit_limit, credit_period_days,
           credit_status, dnd, bank_name, account_no
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
         ) RETURNING id`,
        [
          settingsId,
          outletId,
          fields.role,
          fields.staffType ?? null,
          fields.name,
          fields.phone,
          fields.altPhone ?? null,
          fields.email ?? null,
          hash,
          fields.designation ?? null,
          fields.grants ?? [],
          fields.revokes ?? [],
          fields.managerCanAssign ?? false,
          fields.address ?? null,
          fields.gstin ?? null,
          fields.customerType ?? null,
          fields.vehicle ?? null,
          fields.creditLimit ?? null,
          fields.creditPeriodDays ?? null,
          fields.creditStatus ?? null,
          fields.dnd ?? false,
          fields.bankName ?? null,
          fields.accountNo ?? null,
        ],
      );
      ids[key] = row.rows[0].id;
    }

    await person("meera", { role: "manager", name: "Lakshmi Venkatesan", phone: "9819228104", password: "8104", email: "lakshmi.venkatesan@murugan.petroz.in", designation: "Site manager", managerCanAssign: true }, [wfd.id]);
    await person("ravi", { role: "staff", staffType: "cashier", name: "Aravind Selvam", phone: "9870011288", password: "1288", email: "aravind.selvam@murugan.petroz.in", designation: "Cashier" }, [wfd.id]);
    await person("arun", { role: "staff", staffType: "pump_boy", name: "Dinesh Kumar", phone: "9870011291", password: "1291", email: "dinesh.kumar@murugan.petroz.in", designation: "Pump operator" }, [wfd.id]);
    await person("kiran", { role: "staff", staffType: "air_boy", name: "Senthil Pandian", phone: "9870011294", password: "1294", email: "senthil.pandian@murugan.petroz.in", designation: "Air boy" }, [wfd.id]);
    await person("sita", { role: "staff", staffType: "supervisor", name: "Kavitha Rajan", phone: "9870011297", password: "1297", email: "kavitha.rajan@murugan.petroz.in", designation: "Shift supervisor" }, [wfd.id]);
    await person("dev", { role: "staff", staffType: "dsm", name: "Prabhu Velan", phone: "9870011302", password: "1302", email: "prabhu.velan@murugan.petroz.in", designation: "Dealer salesman" }, [wfd.id]);
    await person("priya", { role: "staff", staffType: "cashier", name: "Divya Kannan", phone: "9870013301", password: "3301", email: "divya.kannan@murugan.petroz.in", designation: "Cashier" }, [tng.id]);
    await person("gopal", { role: "credit_customer", name: "Gopal Logistics", phone: "08041208811", password: "8811", email: "accounts@gopallogistics.in", altPhone: "08041208812", designation: "Fleet account", address: "12 Hoskote Road, Whitefield", gstin: "29AABCG1234M1Z5", customerType: "Fleet", vehicle: "KA01 AB 4421", creditLimit: 250000, creditPeriodDays: 15, creditStatus: "clear", dnd: true }, [wfd.id]);
    await person("nayak", { role: "credit_customer", name: "KPN Travels", phone: "9821099001", password: "9001", email: "ops@kpntravels.in", altPhone: "9821099002", designation: "Travels", address: "ITPL Main Road, Whitefield", gstin: "29AABCK9001P1Z2", customerType: "Travels", vehicle: "KA03 CD 1188", creditLimit: 80000, creditPeriodDays: 7, creditStatus: "clear" }, [wfd.id]);
    await person("bus", { role: "credit_customer", name: "T. Nagar Staff Bus", phone: "04425881212", password: "1212", email: "cabin@tnagar.petroz.in", altPhone: "04425881213", designation: "Staff bus", address: "South Usman Road, T. Nagar", customerType: "Staff bus", vehicle: "TN09 EF 2201", creditLimit: 60000, creditPeriodDays: 30, creditStatus: "clear" }, [tng.id]);
    await person("auditor", { role: "auditor", name: "Insp. Saravanan", phone: "9876002210", password: "2210", email: "saravanan.moorthy@murugan.petroz.in", designation: "SO auditor" }, [wfd.id, tng.id]);
    await person("accounts", { role: "accounts_auditor", name: "CA Anitha Krishnan", phone: "9819887766", password: "7766", email: "anitha.krishnan@murugan.petroz.in", designation: "Accounts auditor" }, [wfd.id, tng.id]);
    await person("iocl", { role: "supplier", name: "IOCL supply desk", phone: "08040001111", password: "1111", designation: "Fuel purchase" }, [wfd.id, tng.id]);
    await person("servo", { role: "supplier", name: "Servo Depot", phone: "08040002222", password: "2222", designation: "Lube" }, [wfd.id, tng.id]);
    await person("hdfc", { role: "bank", name: "HDFC Current · 4421", phone: "18002026161", password: "4421", bankName: "HDFC", accountNo: "4421", designation: "Current" }, [wfd.id]);
    await person("sbi", { role: "bank", name: "SBI Current · 1188", phone: "1800112211", password: "1188", bankName: "SBI", accountNo: "1188", designation: "Current" }, [tng.id]);
    await person("posw", { role: "provider", name: "HDFC POS", phone: "18002663333", password: "3333", designation: "POS" }, [wfd.id]);
    await person("post", { role: "provider", name: "HDFC POS", phone: "18002663334", password: "3334", designation: "POS" }, [tng.id]);
    await person("upiw", { role: "provider", name: "PhonePe / GPay", phone: "18002664444", password: "4444", designation: "Wallet" }, [wfd.id]);
    await person("upit", { role: "provider", name: "PhonePe / GPay", phone: "18002664445", password: "4445", designation: "Wallet" }, [tng.id]);

    const owner = await client.query(
      `SELECT id FROM users WHERE settings_id = $1 AND role = 'owner' LIMIT 1`,
      [settingsId],
    );
    ids.owner = owner.rows[0].id;

    async function product(code, fields) {
      const row = await client.query(
        `INSERT INTO products (settings_id, kind, name, brand, code, hsn, unit, gst, purchase_price, selling_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [settingsId, fields.kind, fields.name, fields.brand ?? null, code, fields.hsn ?? null, fields.unit ?? null, fields.gst ?? null, fields.buy ?? null, fields.sell ?? null],
      );
      ids[code] = row.rows[0].id;
    }
    await product("MS", { kind: "fuel", name: "Petrol", brand: "IOCL", unit: "L", gst: 0, buy: 92, sell: 103.2 });
    await product("HSD", { kind: "fuel", name: "Diesel", brand: "IOCL", unit: "L", gst: 0, buy: 92, sell: 94 });
    await product("POWER", { kind: "fuel", name: "Power", brand: "IOCL", unit: "L", gst: 0, buy: 98, sell: 110 });
    await product("SV-4T-20W40", { kind: "lube", name: "SERVO 4T 20W-40", brand: "SERVO", hsn: "271019", unit: "bottle", gst: 18, buy: 310, sell: 380 });
    await product("CT-GTX-20W50", { kind: "lube", name: "Castrol GTX 20W-50", brand: "Castrol", hsn: "271019", unit: "bottle", gst: 18, buy: 420, sell: 510 });
    await product("KN-1L", { kind: "fmcg", name: "Kinley 1L", brand: "Kinley", hsn: "220210", unit: "bottle", gst: 12, buy: 16, sell: 20 });

    async function tank(key, outletId, productCode, label, capacity, live) {
      const row = await client.query(
        `INSERT INTO equipment (outlet_id, product_id, kind, label, capacity, live_qty, tolerance, dip_chart)
         VALUES ($1,$2,'tank',$3,$4,$5,0.3,$6::jsonb) RETURNING id`,
        [outletId, ids[productCode], label, capacity, live, JSON.stringify(chart(capacity))],
      );
      ids[key] = row.rows[0].id;
    }
    async function nozzle(key, outletId, tankKey, productCode, label, meter) {
      const row = await client.query(
        `INSERT INTO equipment (outlet_id, parent_id, product_id, kind, label, meter)
         VALUES ($1,$2,$3,'nozzle',$4,$5) RETURNING id`,
        [outletId, ids[tankKey], ids[productCode], label, meter],
      );
      ids[key] = row.rows[0].id;
    }

    await tank("tk-ms-w", wfd.id, "MS", "MS", 24, 16.4);
    await tank("tk-hsd-w", wfd.id, "HSD", "HSD", 40, 28.1);
    await tank("tk-pwr-w", wfd.id, "POWER", "POWER", 12, 5.8);
    await tank("tk-ms-t", tng.id, "MS", "MS", 20, 9.2);
    await tank("tk-hsd-t", tng.id, "HSD", "HSD", 36, 22.7);
    await tank("tk-pwr-t", tng.id, "POWER", "POWER", 12, 4.4);
    await nozzle("n1", wfd.id, "tk-ms-w", "MS", "N1", 184220.3);
    await nozzle("n2", wfd.id, "tk-ms-w", "MS", "N2", 176104.8);
    await nozzle("n3", wfd.id, "tk-hsd-w", "HSD", "N3", 221908.1);
    await nozzle("n4", wfd.id, "tk-hsd-w", "HSD", "N4", 198441.6);
    await nozzle("n5", wfd.id, "tk-pwr-w", "POWER", "N5", 88210.4);
    await nozzle("n6", wfd.id, "tk-hsd-w", "HSD", "N6", 140332.9);
    await nozzle("t1", tng.id, "tk-ms-t", "MS", "N1", 99012.2);
    await nozzle("t2", tng.id, "tk-hsd-t", "HSD", "N2", 120441);
    await nozzle("t3", tng.id, "tk-pwr-t", "POWER", "N3", 44110);

    async function balance(outletId, code, onHand, minQty) {
      await client.query(
        `INSERT INTO balances (outlet_id, product_id, on_hand, min_qty) VALUES ($1,$2,$3,$4)`,
        [outletId, ids[code], onHand, minQty],
      );
    }
    await balance(wfd.id, "SV-4T-20W40", 8, 12);
    await balance(wfd.id, "CT-GTX-20W50", 29, 10);
    await balance(wfd.id, "KN-1L", 100, 24);
    await balance(tng.id, "SV-4T-20W40", 16, 8);
    await balance(tng.id, "CT-GTX-20W50", 14, 8);
    await balance(tng.id, "KN-1L", 64, 24);

    async function shift(key, outletId, label, start, end, status, expected, declared, closedBy, approvedBy) {
      const row = await client.query(
        `INSERT INTO shifts (outlet_id, label, starts_at, ends_at, status, expected_cash, declared_cash, closed_by, approved_by, investigation, investigation_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [outletId, label, start, end, status, expected, declared, closedBy ? ids[closedBy] : null, approvedBy ? ids[approvedBy] : null, status === "approved" && declared != null && expected - declared > 0 ? "open" : null, status === "approved" ? "Drawer short. Proof requested from cashier." : null],
      );
      ids[key] = row.rows[0].id;
    }
    await shift("sh-w-y", wfd.id, "Evening", at(14, 0, -1), at(22, 0, -1), "approved", 186400, 185900, "ravi", "meera");
    await shift("sh-w", wfd.id, "Morning", at(6, 0), at(14, 0), "open", 94250, null, null, null);
    await shift("sh-w-n", wfd.id, "Evening", at(14, 0), at(22, 0), "upcoming", 0, null, null, null);
    await shift("sh-t-y", tng.id, "Evening", at(14, 0, -1), at(22, 0, -1), "approved", 76400, 76000, "priya", "owner");
    await shift("sh-t", tng.id, "Morning", at(6, 0), at(14, 0), "open", 41200, null, null, null);
    await shift("sh-t-n", tng.id, "Evening", at(14, 0), at(22, 0), "upcoming", 0, null, null, null);

    async function duty(shiftKey, personKey, nozzleKey, start, end, checkedOut) {
      await client.query(
        `UPDATE shifts SET duties = duties || $2::jsonb WHERE id = $1`,
        [ids[shiftKey], JSON.stringify([{
          id: crypto.randomUUID(),
          userId: ids[personKey],
          nozzleId: nozzleKey ? ids[nozzleKey] : null,
          windowStart: start,
          windowEnd: end,
          checkedOutAt: checkedOut,
        }])],
      );
    }
    await duty("sh-w", "ravi", "n1", at(6, 0), at(14, 0), null);
    await duty("sh-w", "ravi", "n2", at(6, 0), at(14, 0), null);
    await duty("sh-w", "kiran", null, at(6, 0), at(14, 0), null);
    await duty("sh-w", "sita", null, at(6, 0), at(14, 0), null);
    await duty("sh-w", "dev", null, at(6, 0), at(14, 0), null);
    await duty("sh-w-y", "ravi", "n1", at(14, 0, -1), at(22, 0, -1), at(22, 4, -1));
    await duty("sh-t", "priya", "t1", at(6, 0), at(14, 0), null);
    await duty("sh-t", "priya", "t2", at(6, 0), at(14, 0), null);
    await duty("sh-t-y", "priya", "t1", at(14, 0, -1), at(22, 0, -1), at(22, 2, -1));

    async function reading(shiftKey, nozzleKey, personKey, kind, value, when) {
      await client.query(
        `INSERT INTO dip_readings (shift_id, equipment_id, user_id, kind, at, qty)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ids[shiftKey], ids[nozzleKey], ids[personKey], kind, when, value],
      );
    }
    async function dip(outletTank, personKey, shiftKey, mm, physical, book, status, remarks) {
      await client.query(
        `INSERT INTO dip_readings (shift_id, equipment_id, user_id, kind, at, mm, qty, book_qty, status, remarks)
         VALUES ($1,$2,$3,'dip',$4,$5,$6,$7,$8,$9)`,
        [ids[shiftKey], ids[outletTank], personKey ? ids[personKey] : null, at(9, 10), mm, physical, book, status, remarks],
      );
    }
    await reading("sh-w", "n1", "ravi", "opening", 184102.1, at(6, 4));
    await reading("sh-w", "n2", "ravi", "opening", 175988.4, at(6, 5));
    await reading("sh-t", "t1", "priya", "opening", 98990.2, at(6, 6));
    await reading("sh-t", "t2", "priya", "opening", 120360, at(6, 7));
    await dip("tk-ms-w", "arun", "sh-w", 1480, 16.35, 16.4, "normal", "");
    await dip("tk-hsd-w", "arun", "sh-w", 1720, 27.6, 28.1, "difference", "0.5 KL short vs book");
    await dip("tk-pwr-w", null, "sh-w", 0, 0, 5.8, "pending", "");
    await dip("tk-ms-t", "priya", "sh-t", 1100, 9.1, 9.2, "normal", "");
    await dip("tk-hsd-t", "priya", "sh-t", 1500, 22.2, 22.7, "difference", "0.5 KL short vs book");
    await dip("tk-pwr-t", null, "sh-t", 0, 0, 4.4, "pending", "");

    async function doc(fields, lines = []) {
      if (fields.kind === "sale") {
        const row = await client.query(
          `INSERT INTO sales (
             outlet_id, user_id, shift_id, status, doc_no, doc_date, due_date,
             amount, tax, charges, net, mode, category, reference, vehicle, note, created_by, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
           ) RETURNING id`,
          [
            fields.outletId,
            fields.partyId ?? null,
            fields.shiftId ?? null,
            fields.status ?? "open",
            fields.docNo ?? null,
            fields.docDate ?? new Date().toISOString().slice(0, 10),
            fields.dueDate ?? null,
            fields.amount ?? 0,
            fields.tax ?? 0,
            fields.charges ?? 0,
            fields.net ?? fields.amount ?? 0,
            fields.mode ?? null,
            fields.category ?? null,
            fields.reference ?? null,
            fields.vehicle ?? null,
            fields.note ?? null,
            fields.createdBy ?? null,
            fields.at ?? new Date().toISOString(),
          ],
        );
        for (const line of lines) {
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, equipment_id, description, qty, rate, amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [row.rows[0].id, line.productId ?? null, line.equipmentId ?? null, line.description ?? null, line.qty ?? 0, line.rate ?? 0, line.amount ?? 0],
          );
        }
        return row.rows[0].id;
      }
      if (fields.kind === "purchase" || fields.kind === "purchase_order") {
        const row = await client.query(
          `INSERT INTO purchases (
             outlet_id, user_id, shift_id, kind, status, doc_no, doc_date, due_date,
             amount, tax, charges, net, mode, category, reference, note, created_by, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
           ) RETURNING id`,
          [
            fields.outletId, fields.partyId ?? null, fields.shiftId ?? null, fields.kind, fields.status ?? "open",
            fields.docNo ?? null, fields.docDate ?? new Date().toISOString().slice(0, 10), fields.dueDate ?? null,
            fields.amount ?? 0, fields.tax ?? 0, fields.charges ?? 0, fields.net ?? fields.amount ?? 0,
            fields.mode ?? null, fields.category ?? null, fields.reference ?? null, fields.note ?? null,
            fields.createdBy ?? null, fields.at ?? new Date().toISOString(),
          ],
        );
        for (const line of lines) {
          await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, equipment_id, description, qty, rate, amount, qty_received)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [row.rows[0].id, line.productId ?? null, line.equipmentId ?? null, line.description ?? null, line.qty ?? 0, line.rate ?? 0, line.amount ?? 0, line.qtyReceived ?? null],
          );
        }
        return row.rows[0].id;
      }
      if (fields.kind === "transfer" || fields.kind === "settlement" || (fields.kind === "receipt" && fields.category === "cash_deposit")) {
        const row = await client.query(
          `INSERT INTO banking (
             outlet_id, user_id, counterparty_id, shift_id, kind, status, doc_no, doc_date,
             amount, tax, charges, net, mode, category, reference, note, created_by, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
           ) RETURNING id`,
          [
            fields.outletId, fields.partyId ?? null, fields.counterpartyId ?? null, fields.shiftId ?? null,
            fields.kind === "receipt" ? "deposit" : fields.kind, fields.status ?? "open", fields.docNo ?? null,
            fields.docDate ?? new Date().toISOString().slice(0, 10), fields.amount ?? 0, fields.tax ?? 0,
            fields.charges ?? 0, fields.net ?? fields.amount ?? 0, fields.mode ?? null,
            fields.kind === "receipt" ? "cash_deposit" : fields.category ?? null, fields.reference ?? null,
            fields.note ?? null, fields.createdBy ?? null, fields.at ?? new Date().toISOString(),
          ],
        );
        return row.rows[0].id;
      }
      if (fields.kind === "expense" || fields.kind === "expense_schedule") {
        const row = await client.query(
          `INSERT INTO expenses (
             outlet_id, user_id, shift_id, kind, status, doc_no, doc_date, due_date,
             amount, tax, charges, net, mode, category, note, frequency, next_due,
             reimbursable, created_by, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17::date,$18,$19,$20
           ) RETURNING id`,
          [
            fields.outletId, fields.partyId ?? null, fields.shiftId ?? null, fields.kind, fields.status ?? "open",
            fields.docNo ?? null, fields.docDate ?? new Date().toISOString().slice(0, 10), fields.dueDate ?? null,
            fields.amount ?? 0, fields.tax ?? 0, fields.charges ?? 0, fields.net ?? fields.amount ?? 0,
            fields.mode ?? null, fields.category ?? null, fields.note ?? null, fields.frequency ?? null,
            fields.nextDue ?? null, fields.reimbursable ?? false, fields.createdBy ?? null,
            fields.at ?? new Date().toISOString(),
          ],
        );
        return row.rows[0].id;
      }
      const row = await client.query(
        `INSERT INTO documents (
           outlet_id, user_id, counterparty_id, shift_id, kind, status, doc_no, doc_date, due_date,
           amount, tax, charges, net, mode, category, reference, vehicle, note, frequency, next_due,
           reimbursable, created_by, created_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::date,$21,$22,$23
         ) RETURNING id`,
        [
          fields.outletId,
          fields.partyId ?? null,
          fields.counterpartyId ?? null,
          fields.shiftId ?? null,
          fields.kind,
          fields.status ?? "open",
          fields.docNo ?? null,
          fields.docDate ?? new Date().toISOString().slice(0, 10),
          fields.dueDate ?? null,
          fields.amount ?? 0,
          fields.tax ?? 0,
          fields.charges ?? 0,
          fields.net ?? fields.amount ?? 0,
          fields.mode ?? null,
          fields.category ?? null,
          fields.reference ?? null,
          fields.vehicle ?? null,
          fields.note ?? null,
          fields.frequency ?? null,
          fields.nextDue ?? null,
          fields.reimbursable ?? false,
          fields.createdBy ?? null,
          fields.at ?? new Date().toISOString(),
        ],
      );
      for (const line of lines) {
        await client.query(
          `INSERT INTO document_items (document_id, product_id, equipment_id, description, qty, rate, amount, qty_received)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.rows[0].id, line.productId ?? null, line.equipmentId ?? null, line.description ?? null, line.qty ?? 0, line.rate ?? 0, line.amount ?? 0, line.qtyReceived ?? null],
        );
      }
      return row.rows[0].id;
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    async function sale(outletId, shiftKey, staffKey, productCode, nozzleKey, litres, amount, mode, docNo, customerKey, whenDate, status = "open", whenAt = null) {
      await doc({
        outletId,
        partyId: customerKey ? ids[customerKey] : ids[staffKey],
        shiftId: ids[shiftKey],
        kind: "sale",
        status,
        docNo,
        docDate: whenDate,
        at: whenAt ?? at(8, 30),
        amount,
        net: amount,
        mode,
        category: productCode.startsWith("SV") || productCode.startsWith("CT") || productCode.startsWith("KN") ? null : null,
        createdBy: ids[staffKey],
      }, [{
        productId: ids[productCode],
        equipmentId: nozzleKey ? ids[nozzleKey] : null,
        qty: litres,
        rate: litres ? amount / litres : amount,
        amount,
      }]);
    }

    await sale(wfd.id, "sh-w", "ravi", "MS", "n1", 18.4, 1899, "upi", "WFD/0826", null, today);
    await sale(wfd.id, "sh-w", "ravi", "MS", "n2", 42, 4331, "credit", "WFD/0827", "gopal", today);
    await sale(wfd.id, "sh-w", "ravi", "HSD", "n3", 120, 11280, "cash", "WFD/0828", null, today);
    await sale(wfd.id, "sh-w", "ravi", "SV-4T-20W40", null, 4, 1860, "cash", "WFD/0829", null, today, "cancelled");
    await sale(wfd.id, "sh-w", "ravi", "KN-1L", null, 1, 85, "cash", "WFD/0840", null, today);
    await sale(wfd.id, "sh-w", "dev", "SV-4T-20W40", null, 5, 2480, "upi", "WFD/0841", null, today);
    for (let i = 0; i < 10; i += 1) {
      const productCode = i % 3 === 0 ? "MS" : i % 3 === 1 ? "HSD" : "POWER";
      const nozzleKey = productCode === "MS" ? "n1" : productCode === "HSD" ? "n3" : "n5";
      await sale(wfd.id, "sh-w", "ravi", productCode, nozzleKey, 12 + i * 3.5, 1240 + i * 410, i % 2 === 0 ? "cash" : "upi", `WFD/${830 + i}`, null, today);
    }
    await sale(wfd.id, "sh-w", "ravi", "SV-4T-20W40", null, 2, 760, "cash", "LB/0142", null, today);
    await sale(wfd.id, "sh-w", "ravi", "KN-1L", null, 4, 80, "cash", "LB/0143", null, today);
    await doc({ outletId: wfd.id, shiftId: ids["sh-w"], kind: "sale", docNo: "OI/WFD/1", docDate: today, amount: 240, net: 240, mode: "cash", category: "other_income", note: "Air fill bay", createdBy: ids.kiran });
    await doc({ outletId: wfd.id, shiftId: ids["sh-w"], kind: "sale", docNo: "OI/WFD/2", docDate: today, amount: 150, net: 150, mode: "cash", category: "other_income", note: "Puncture patch", createdBy: ids.kiran });

    await sale(tng.id, "sh-t", "priya", "MS", "t1", 22, 2270, "upi", "TNG/0412", null, today);
    await sale(tng.id, "sh-t", "priya", "HSD", "t2", 80, 7520, "credit", "TNG/0413", "bus", today);
    await sale(tng.id, "sh-t", "priya", "POWER", "t3", 15, 1650, "cash", "TNG/0414", null, today);
    await sale(tng.id, "sh-t", "priya", "SV-4T-20W40", null, 2, 760, "cash", "LB/TNG/0142", null, today);
    await sale(tng.id, "sh-t", "priya", "KN-1L", null, 4, 80, "upi", "LB/TNG/0143", null, today);
    for (let i = 0; i < 6; i += 1) {
      const productCode = i % 2 === 0 ? "MS" : "HSD";
      await sale(tng.id, "sh-t", "priya", productCode, productCode === "MS" ? "t1" : "t2", 10 + i * 4, 980 + i * 360, i % 2 === 0 ? "cash" : "upi", `TNG/${420 + i}`, null, today);
    }
    await doc({ outletId: tng.id, shiftId: ids["sh-t"], kind: "sale", docNo: "OI/TNG/1", docDate: today, amount: 180, net: 180, mode: "cash", category: "other_income", note: "Air fill bay", createdBy: ids.priya });
    await doc({ outletId: tng.id, shiftId: ids["sh-t"], kind: "sale", docNo: "OI/TNG/2", docDate: today, amount: 120, net: 120, mode: "cash", category: "other_income", note: "Puncture patch", createdBy: ids.priya });

    await doc({ outletId: wfd.id, partyId: ids.gopal, kind: "sale", status: "open", docNo: "WFD/0791", docDate: yesterday, dueDate: ago(22), amount: 18940, net: 18940, mode: "credit", note: "HSD 200 L", createdBy: ids.ravi }, [{ productId: ids.HSD, qty: 200, rate: 94.7, amount: 18940 }]);
    await doc({ outletId: wfd.id, partyId: ids.gopal, kind: "sale", status: "open", docNo: "WFD/OPEN", docDate: ago(30), dueDate: ago(22), amount: 90549, net: 90549, mode: "credit", note: "Opening outstanding", createdBy: ids.meera });
    await doc({ outletId: wfd.id, partyId: ids.gopal, kind: "receipt", status: "paid", docNo: "RCPT/WFD/1", docDate: ago(2), amount: 25000, net: 25000, mode: "neft", note: "NEFT from HDFC", reference: "HDFC0N25000", createdBy: ids.meera });
    await doc({ outletId: wfd.id, partyId: ids.gopal, kind: "adjustment", status: "open", docNo: "WFD/CN-014", docDate: yesterday, amount: 2400, net: 2400, category: "credit_note", note: "CN against overbilled HSD · WFD/0791", createdBy: ids.meera });
    await doc({ outletId: wfd.id, partyId: ids.nayak, kind: "sale", status: "open", docNo: "WFD/0831", docDate: today, amount: 6120, net: 6120, mode: "credit", note: "HSD 65 L · N3", createdBy: ids.ravi }, [{ productId: ids.HSD, qty: 65, rate: 94.15, amount: 6120 }]);
    await doc({ outletId: wfd.id, partyId: ids.nayak, kind: "sale", status: "open", docNo: "WFD/NOPEN", docDate: ago(10), dueDate: ago(3), amount: 6150, net: 6150, mode: "credit", note: "Opening outstanding", createdBy: ids.meera });
    await doc({ outletId: wfd.id, partyId: ids.nayak, kind: "adjustment", status: "open", docNo: "WFD/DN-003", docDate: yesterday, amount: 180, net: 180, category: "debit_note", note: "DN round-off on WFD/0831", createdBy: ids.meera });
    await doc({ outletId: wfd.id, partyId: ids.gopal, kind: "quote", status: "open", docNo: "QT/WFD/012", docDate: today, dueDate: ago(-7), amount: 42000, net: 42000, note: "Quotation" });
    await doc({ outletId: wfd.id, partyId: ids.nayak, kind: "order", status: "open", docNo: "CPO/WFD/004", docDate: today, amount: 80000, net: 80000, note: "HSD monthly lift" });
    await doc({ outletId: wfd.id, partyId: ids.gopal, kind: "sale", status: "open", docNo: "INV/WFD/088", docDate: today, dueDate: ago(-5), amount: 18940, net: 18940, mode: "credit", note: "Invoice" });
    await doc({ outletId: wfd.id, partyId: ids.nayak, kind: "sale", status: "paid", docNo: "INV/WFD/079", docDate: yesterday, amount: 6120, net: 6120, mode: "credit", note: "Invoice" });

    await doc({ outletId: tng.id, partyId: ids.bus, kind: "sale", status: "open", docNo: "TNG/OPEN", docDate: ago(20), dueDate: ago(5), amount: 16380, net: 16380, mode: "credit", note: "Opening outstanding", createdBy: ids.priya });
    await doc({ outletId: tng.id, partyId: ids.bus, kind: "receipt", status: "paid", docNo: "RCPT/TNG/1", docDate: ago(3), amount: 15000, net: 15000, mode: "cash", note: "Cash at T. Nagar cabin", createdBy: ids.priya });
    await doc({ outletId: tng.id, partyId: ids.bus, kind: "quote", status: "open", docNo: "QT/TNG/004", docDate: today, amount: 28000, net: 28000, note: "Monthly diesel" });
    await doc({ outletId: tng.id, partyId: ids.bus, kind: "order", status: "open", docNo: "CPO/TNG/002", docDate: today, amount: 60000, net: 60000, note: "Staff bus HSD" });

    async function books(outlet, prefix, staffKey, bankKey, posKey, upiKey) {
      await doc({ outletId: outlet.id, partyId: ids.iocl, kind: "purchase_order", status: "sent", docNo: `PO/${prefix}/1`, docDate: today, amount: 1104000, net: 1104000, note: "MS", createdBy: ids.owner }, [{ productId: ids.MS, qty: 12, qtyReceived: 0, rate: 92000, amount: 1104000 }]);
      await doc({ outletId: outlet.id, partyId: ids.servo, kind: "purchase_order", status: "partial", docNo: `PO/${prefix}/2`, docDate: today, amount: 14880, net: 14880, note: "SERVO 4T 20W-40", createdBy: ids.owner }, [{ productId: ids["SV-4T-20W40"], qty: 48, qtyReceived: 24, rate: 310, amount: 14880 }]);
      await doc({ outletId: outlet.id, partyId: ids.iocl, kind: "purchase_order", status: "received", docNo: `PO/${prefix}/3`, docDate: yesterday, amount: 736000, net: 736000, note: "HSD", createdBy: ids.owner }, [{ productId: ids.HSD, qty: 8, qtyReceived: 8, rate: 92000, amount: 736000 }]);
      await doc({ outletId: outlet.id, partyId: ids.servo, kind: "purchase_order", status: "cancelled", docNo: `PO/${prefix}/4`, docDate: yesterday, amount: 6120, net: 6120, note: "Castrol GTX", createdBy: ids.owner }, [{ productId: ids["CT-GTX-20W50"], qty: 12, qtyReceived: 0, rate: 510, amount: 6120 }]);
      await doc({ outletId: outlet.id, partyId: ids.iocl, shiftId: null, kind: "purchase", status: "paid", docNo: `IOCL/${prefix}/441`, docDate: yesterday, amount: 1128000, net: 1128000, mode: "neft", createdBy: ids.meera ?? ids.owner }, [{ productId: ids.HSD, equipmentId: ids[outlet.code === "WFD" ? "tk-hsd-w" : "tk-hsd-t"], qty: 12, qtyReceived: 12, rate: 94000, amount: 1128000 }]);
      await doc({ outletId: outlet.id, partyId: ids.iocl, kind: "purchase", status: "paid", docNo: `IOCL/${prefix}/442`, docDate: yesterday, amount: 736000, net: 736000, mode: "neft", createdBy: ids.owner }, [{ productId: ids.MS, equipmentId: ids[outlet.code === "WFD" ? "tk-ms-w" : "tk-ms-t"], qty: 8, qtyReceived: 8, rate: 92000, amount: 736000 }]);
      await doc({ outletId: outlet.id, partyId: ids.servo, kind: "purchase", status: "paid", docNo: `SD/${prefix}/8821`, docDate: today, amount: 7440, net: 7440, mode: "imps", createdBy: ids.owner }, [{ productId: ids["SV-4T-20W40"], qty: 24, qtyReceived: 24, rate: 310, amount: 7440 }]);
      await doc({ outletId: outlet.id, partyId: ids[bankKey], kind: "receipt", status: "paid", docNo: `DEP/${prefix}/1`, docDate: yesterday, amount: outlet.code === "WFD" ? 186250 : 76000, net: outlet.code === "WFD" ? 186250 : 76000, mode: "cash", category: "cash_deposit", note: "Last evening drawer", createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids.iocl, counterpartyId: ids[bankKey], kind: "transfer", status: "completed", docNo: `NEFT/${prefix}/1`, docDate: yesterday, amount: 736000, net: 736000, mode: "neft", reference: "HDFC0N882190", note: `Fuel invoice IOCL/${prefix}/441`, createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids.servo, counterpartyId: ids[bankKey], kind: "transfer", status: "pending", docNo: `IMPS/${prefix}/1`, docDate: today, amount: 7440, net: 7440, mode: "imps", reference: "IMPS0N4412", note: `Lube invoice SD/${prefix}/8821`, createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[posKey], counterpartyId: ids[bankKey], kind: "settlement", status: "settled", docNo: `POS/${prefix}/0912`, docDate: yesterday, amount: 18640, charges: 430, net: 18210, category: "pos", reference: `POS/${prefix}/0912`, createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[posKey], counterpartyId: ids[bankKey], kind: "settlement", status: "pending", docNo: `POS/${prefix}/open`, docDate: today, amount: 9420, charges: 0, net: 0, category: "pos", createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[posKey], counterpartyId: ids[bankKey], kind: "settlement", status: "difference", docNo: `POS/${prefix}/0918`, docDate: yesterday, amount: 5100, charges: 120, net: 4800, category: "pos", reference: `POS/${prefix}/0918`, createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[upiKey], counterpartyId: ids[bankKey], kind: "settlement", status: "settled", docNo: `UPI/${prefix}/4401`, docDate: yesterday, amount: 22150, charges: 170, net: 21980, category: "wallet", reference: `UPI/${prefix}/4401`, createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[upiKey], counterpartyId: ids[bankKey], kind: "settlement", status: "pending", docNo: `UPI/${prefix}/open`, docDate: today, amount: 8640, charges: 0, net: 0, category: "wallet", createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[upiKey], counterpartyId: ids[bankKey], kind: "settlement", status: "difference", docNo: `UPI/${prefix}/4410`, docDate: yesterday, amount: 2200, charges: 40, net: 2000, category: "wallet", reference: `UPI/${prefix}/4410`, createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[staffKey], kind: "expense", status: "pending", docNo: `EXP/${prefix}/1`, docDate: today, amount: 180, net: 180, mode: "cash", note: "Tea + broom from shop opposite", createdBy: ids[staffKey] });
      await doc({ outletId: outlet.id, partyId: ids[staffKey], kind: "expense", status: "pending", docNo: `EXP/${prefix}/2`, docDate: today, amount: 2400, net: 2400, mode: "cash", note: "Hose clamp emergency from local garage", createdBy: ids[staffKey] });
      await doc({ outletId: outlet.id, partyId: ids[staffKey], kind: "expense", status: "paid", docNo: `EXP/${prefix}/3`, docDate: yesterday, amount: 90, net: 90, mode: "upi", note: "Air-machine oil top-up", reimbursable: true, createdBy: ids[staffKey] });
      await doc({ outletId: outlet.id, kind: "expense_schedule", status: "open", docNo: `REC/${prefix}/1`, docDate: today, amount: 18400, net: 18400, mode: "bank", category: "Electricity", note: "BESCOM bill", frequency: "Monthly", nextDue: ago(-12), createdBy: ids.owner });
      await doc({ outletId: outlet.id, kind: "expense_schedule", status: "open", docNo: `REC/${prefix}/2`, docDate: today, amount: 1299, net: 1299, mode: "upi", category: "Office / Stationery", note: "Cabin internet", frequency: "Monthly", nextDue: ago(-5), createdBy: ids.owner });
      await doc({ outletId: outlet.id, partyId: ids[staffKey], kind: "payment", status: "pending", docNo: `ADV/${prefix}/1`, docDate: today, amount: 2000, net: 2000, mode: "cash", category: "advance", note: "School fees this week", createdBy: ids[staffKey] });
      await doc({ outletId: outlet.id, partyId: ids[staffKey], kind: "salary", status: outlet.code === "WFD" ? "paid" : "pending", docNo: `SAL/${prefix}/AUG`, docDate: ago(20), amount: 24100, net: 24100, note: "August", createdBy: ids.owner }, [
        { description: "basic", amount: 22000, qty: 26 },
        { description: "ot", amount: 800, qty: 0 },
        { description: "allowances", amount: 1500, qty: 0 },
        { description: "deductions", amount: 200, qty: 0 },
      ]);
      await doc({ outletId: outlet.id, kind: "adjustment", status: "open", docNo: `ADJ/${prefix}/1`, docDate: today, amount: 0, net: 0, note: "Castrol count", createdBy: ids.owner }, [{ productId: ids["CT-GTX-20W50"], qty: -1, amount: 0 }]);
    }

    await books(wfd, "WFD", "ravi", "hdfc", "posw", "upiw");
    await books(tng, "TNG", "priya", "sbi", "post", "upit");

    async function punch(personKey, outletId, inn, out) {
      await client.query(
        `INSERT INTO attendance (user_id, outlet_id, check_in, check_out, gps_ok, geofence_ok, selfie, spoof, device)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ids[personKey], outletId, inn, out, personKey !== "arun", personKey !== "arun", personKey !== "arun", personKey === "arun", personKey === "arun" ? "Unknown device" : "This browser"],
      );
    }
    await punch("ravi", wfd.id, at(5, 58), null);
    await punch("ravi", wfd.id, at(14, 2, -1), at(22, 4, -1));
    await punch("arun", wfd.id, at(14, 5, -1), null);
    await punch("sita", wfd.id, at(5, 50), null);
    await punch("kiran", wfd.id, at(6, 10), null);
    await punch("dev", wfd.id, at(9, 55), null);
    await punch("priya", tng.id, at(6, 8), null);

    async function act(outletId, actorKey, action, detail, when, status, targetKey) {
      await client.query(
        `INSERT INTO activity (at, outlet_id, actor_id, action, detail, target_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [when, outletId, ids[actorKey], action, detail, targetKey ? ids[targetKey] : null, status],
      );
    }
    await act(wfd.id, "meera", "Opened shift", "Morning shift opened at Whitefield", at(5, 55), null, null);
    await act(wfd.id, "meera", "Approved shift", "Evening shift approved · variance −₹150", at(22, 12, -1), null, "ravi");
    await act(wfd.id, "ravi", "Opening reading", "N1 petrol opening 184102.1", at(6, 4), null, null);
    await act(wfd.id, "ravi", "Credit sale", "WFD/0827 · Gopal Logistics · petrol 42 L", at(8, 3), null, null);
    await act(wfd.id, "meera", "Bank deposit", "HDFC Whitefield · last evening drawer", at(9, 10, -1), null, null);
    await act(tng.id, "owner", "Opened shift", "Morning shift opened at T. Nagar", at(5, 50), null, null);
    await act(tng.id, "priya", "Credit sale", "TNG/0413 · Staff bus · diesel 80 L", at(8, 15), null, null);
    await act(wfd.id, "owner", "export", JSON.stringify({ category: "sales", report: "Fuel sales", format: "Excel", range: "1–7 Sep 2026" }), at(21, 40, -1), "Ready", null);
    await act(wfd.id, "meera", "export", JSON.stringify({ category: "banking", report: "Bank deposits", format: "PDF", range: "7 Sep 2026" }), at(18, 5, -1), "Ready", null);
    await act(tng.id, "priya", "export", JSON.stringify({ category: "sales", report: "Payment collection", format: "PDF", range: "1–7 Sep 2026" }), at(20, 15, -1), "Ready", null);
    await act(wfd.id, "owner", "permission", JSON.stringify({ permission: "Cash handling", change: "Granted", reason: "Morning cashier cover" }), at(9, 40, -2), null, "ravi");
    await act(wfd.id, "meera", "permission", JSON.stringify({ permission: "Exports", change: "Revoked", reason: "Desk-only during training" }), at(18, 5, -20), null, "ravi");
    await act(wfd.id, "owner", "finding", "Nozzle 4 totaliser sticker faded. Replace before next calibration visit.", at(12, 10, -12), null, null);

    await client.query("COMMIT");
    return { seeded: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
