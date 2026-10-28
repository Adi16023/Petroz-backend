import { assertShiftDsrEditable } from "./shift-dsr-lock.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function assertCashierIds(db, value, outlet, bad) {
  if (!Array.isArray(value) || !value.length) {
    throw bad("Assign at least one cashier to this shift before saving or entering transactions.");
  }
  if (value.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw bad("Pick cashiers from this outlet.");
  }
  const ids = [...new Set(value)];
  const { rows } = await db.query(
    `SELECT id, name FROM users
     WHERE id = ANY($1::uuid[])
       AND settings_id = $2
       AND role IN ('staff', 'manager')
       AND staff_type = 'cashier'
       AND active = true
       AND (outlet_id IS NULL OR outlet_id = $3)`,
    [ids, outlet.settings_id, outlet.id],
  );
  if (rows.length !== ids.length) throw bad("Select active cashiers assigned to this outlet.");
  return ids;
}

export async function assertShiftCashiers(db, shiftId, outlet, bad, lock = false) {
  if (typeof shiftId !== "string" || !UUID.test(shiftId)) throw bad("Choose a valid shift.");
  const { rows } = await db.query(
    `SELECT * FROM shifts WHERE id = $1 AND outlet_id = $2${lock ? " FOR UPDATE" : ""}`,
    [shiftId, outlet.id],
  );
  const shift = rows[0];
  if (!shift) throw bad("Shift not found on this outlet.", 404);
  await assertShiftDsrEditable(db, shift, bad);
  await assertCashierIds(db, shift.entry?.cashierIds, outlet, bad);
  return shift;
}

export async function withDocumentCashiers(db, documents) {
  const shiftIds = [...new Set(documents.map((doc) => doc.shiftId).filter(Boolean))];
  if (!shiftIds.length) return documents;
  const { rows } = await db.query(
    `SELECT s.id, s.outlet_id, s.entry, u.id AS cashier_id, u.name AS cashier_name
     FROM shifts s
     LEFT JOIN users u ON u.id::text IN (
       SELECT jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(s.entry->'cashierIds') = 'array'
           THEN s.entry->'cashierIds' ELSE '[]'::jsonb END
       )
     ) AND u.settings_id = (SELECT settings_id FROM outlets WHERE id = s.outlet_id)
     WHERE s.id = ANY($1::uuid[])`,
    [shiftIds],
  );
  return documents.map((doc) => {
    if (!doc.shiftId) return doc;
    const assigned = rows.filter((row) => row.id === doc.shiftId && row.outlet_id === doc.outletId);
    const cashierIds = [...new Set(Array.isArray(assigned[0]?.entry?.cashierIds) ? assigned[0].entry.cashierIds : [])];
    const cashierNames = cashierIds.map((id) => assigned.find((row) => row.cashier_id === id)?.cashier_name || "Unknown cashier");
    return { ...doc, cashierIds, cashierNames, handledBy: cashierNames.join(", ") || "Unassigned cashier" };
  });
}
