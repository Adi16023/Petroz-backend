import bcrypt from "bcryptjs";

export async function ensureSeed(pool) {
  const existing = await pool.query(`SELECT id FROM dealers LIMIT 1`);
  if (existing.rows.length) return { seeded: false };

  const phone = process.env.SEED_OWNER_PHONE || "9820011420";
  const password = process.env.SEED_OWNER_PASSWORD || "1142";
  const name = process.env.SEED_OWNER_NAME || "Karthik Murugan";
  const passwordHash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dealer = await client.query(
      `INSERT INTO dealers (auto_approve_below, variance_alert, auditor_can_file_findings, schedules)
       VALUES (500, 200, true, $1::jsonb)
       RETURNING id`,
      [JSON.stringify([{ name: "Daily sales register", cadence: "Every day 22:00 IST" }])],
    );
    const dealerId = dealer.rows[0].id;
    const whitefield = await client.query(
      `INSERT INTO outlets (dealer_id, name, code) VALUES ($1, 'Whitefield', 'WFD') RETURNING id`,
      [dealerId],
    );
    const tnagar = await client.query(
      `INSERT INTO outlets (dealer_id, name, code) VALUES ($1, 'T. Nagar', 'TNG') RETURNING id`,
      [dealerId],
    );
    const owner = await client.query(
      `INSERT INTO parties (
         dealer_id, role, name, phone, email, password_hash, designation, active
       ) VALUES ($1, 'owner', $2, $3, $4, $5, 'Dealer', true)
       RETURNING id`,
      [dealerId, name, phone, "karthik.murugan@murugan.petroz.in", passwordHash],
    );
    await client.query(
      `INSERT INTO party_outlets (party_id, outlet_id) VALUES ($1, $2), ($1, $3)`,
      [owner.rows[0].id, whitefield.rows[0].id, tnagar.rows[0].id],
    );
    await client.query("COMMIT");
    return { seeded: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
