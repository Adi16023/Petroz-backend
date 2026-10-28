export async function isShiftDsrLocked(db, shift) {
  if (shift.status !== "closed") return false;
  const { rows } = await db.query(
    `SELECT id FROM documents
     WHERE outlet_id = $1 AND kind = 'dsr' AND status = 'locked'
       AND doc_date BETWEEN ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
                        AND ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
     LIMIT 1`,
    [shift.outlet_id, shift.starts_at, shift.ends_at],
  );
  return rows.length > 0;
}

export async function assertShiftDsrEditable(db, shift, bad) {
  if (await isShiftDsrLocked(db, shift)) {
    throw bad("This closed shift is read-only because its DSR is locked. Unlock the DSR to edit this shift.", 423);
  }
}

export async function assertLinkedShiftDsrEditable(db, shiftId, outletId, bad) {
  const { rows } = await db.query("SELECT * FROM shifts WHERE id = $1 AND outlet_id = $2", [shiftId, outletId]);
  if (!rows[0]) throw bad("Shift not found on this outlet.", 404);
  await assertShiftDsrEditable(db, rows[0], bad);
}
