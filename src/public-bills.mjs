export function billDto(row) {
  return {
    id: row.id,
    outletId: row.outlet_id,
    billNo: row.bill_no,
    billedAt: row.billed_at,
    customerName: row.customer_name,
    vehicleNo: row.vehicle_no,
    mobile: row.mobile,
    paymentMode: row.payment_mode,
    pumpNozzle: row.pump_nozzle,
    attendant: row.attendant,
    lines: row.lines ?? [],
    total: Number(row.total) || 0,
    publicToken: row.public_token,
    cancelledAt: row.cancelled_at,
    station: row.station_snapshot,
  };
}

export function registerPublicBills(app, { pool, wrap, bad }) {
  app.get("/api/public/bills/:token", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.set("Referrer-Policy", "no-referrer");
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) throw bad("Bill not found or no longer available.", 404);
    const { rows } = await pool.query(
      `SELECT bill_no, billed_at, customer_name, vehicle_no, mobile, payment_mode,
              pump_nozzle, attendant, lines, total, station_snapshot
       FROM billing WHERE public_token = $1 AND cancelled_at IS NULL`,
      [req.params.token],
    );
    if (!rows.length) throw bad("Bill not found or no longer available.", 404);
    const bill = billDto(rows[0]);
    // Public responses contain bill content only, never internal IDs or access tokens.
    const { id, outletId, publicToken, cancelledAt, ...content } = bill;
    res.json(content);
  }));
}
