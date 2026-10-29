const TYPES = ["fuel", "product", "service", "combo"];
const DISCOUNTS = ["litre", "fixed", "percent"];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function validateOffer(body, bad) {
  if (!body || !TYPES.includes(body.type)) throw bad("Choose a valid offer type.");
  if (!DISCOUNTS.includes(body.discount)) throw bad("Choose a valid discount type.");
  const data = { type: body.type, discount: body.discount };
  for (const [field, limit] of [["name", 120], ["description", 5000], ["applicable", 1000], ["benefit", 1000], ["audience", 1000]]) {
    if (typeof body[field] !== "string") throw bad(`${field} must be text.`);
    data[field] = body[field].trim();
    if (data[field].length > limit) throw bad(`${field} is too long.`);
  }
  if (!data.name || !data.applicable || !data.audience) throw bad("Offer name, applicable products and customers are required.");
  for (const field of ["value", "minimum", "maximum"]) {
    if (typeof body[field] !== "number" || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > 999999999999.99) {
      throw bad(`${field} must be a valid non-negative amount.`);
    }
    data[field] = body[field];
  }
  for (const field of ["start", "end"]) {
    const value = body[field];
    if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw bad("Enter valid offer dates.");
    }
    data[field] = value;
  }
  if (data.end < data.start) throw bad("End date must be on or after start date.");
  if (typeof body.enabled !== "boolean") throw bad("Offer enabled must be true or false.");
  data.enabled = body.enabled;
  if (["fuel", "product"].includes(data.type)) {
    if (data.value < 0.01 || (data.discount === "percent" && data.value > 100)) throw bad("Enter a valid discount value.");
    if (data.type === "product" && data.discount === "litre") throw bad("Product discounts must be fixed or percentage.");
  } else if (!data.benefit) throw bad("Enter the offer benefit.");
  return data;
}

function dto(row) {
  return {
    id: row.id, outletId: row.outlet_id, name: row.name, description: row.description,
    type: row.type, applicable: row.applicable, discount: row.discount, value: Number(row.value),
    minimum: Number(row.minimum), maximum: Number(row.maximum), benefit: row.benefit,
    start: row.start, end: row.end, audience: row.audience, enabled: row.enabled,
    usage: row.usage, given: Number(row.given),
  };
}

const returning = "*, start_date::text AS start, end_date::text AS end";

export function registerOffers(app, { pool, wrap, bad, assertOutlet }) {
  async function scope(req, outletId) {
    if (!["owner", "super_admin"].includes(req.user.role)) throw bad("Only owners can manage offers.", 403);
    if (typeof outletId !== "string" || !UUID.test(outletId)) throw bad("A valid outletId is required.");
    return assertOutlet(pool, req.user, outletId);
  }
  app.get("/api/offers", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.query.outletId);
    const { rows } = await pool.query(`SELECT ${returning} FROM offers WHERE outlet_id=$1 ORDER BY created_at, id`, [outlet.id]);
    res.json(rows.map(dto));
  }));
  app.post("/api/offers", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.body?.outletId);
    const data = validateOffer(req.body, bad);
    const { rows } = await pool.query(
      `INSERT INTO offers (outlet_id, name, description, type, applicable, discount, value, minimum, maximum, benefit, start_date, end_date, audience, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${returning}`,
      [outlet.id, data.name, data.description, data.type, data.applicable, data.discount, data.value, data.minimum, data.maximum, data.benefit, data.start, data.end, data.audience, data.enabled],
    );
    res.status(201).json(dto(rows[0]));
  }));
  app.patch("/api/offers/:id", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.body?.outletId);
    if (!UUID.test(req.params.id)) throw bad("Invalid offer ID.");
    const data = validateOffer(req.body, bad);
    const { rows } = await pool.query(
      `UPDATE offers SET name=$3, description=$4, type=$5, applicable=$6, discount=$7, value=$8,
       minimum=$9, maximum=$10, benefit=$11, start_date=$12, end_date=$13, audience=$14, enabled=$15, updated_at=now()
       WHERE id=$1 AND outlet_id=$2 RETURNING ${returning}`,
      [req.params.id, outlet.id, data.name, data.description, data.type, data.applicable, data.discount, data.value, data.minimum, data.maximum, data.benefit, data.start, data.end, data.audience, data.enabled],
    );
    if (!rows.length) throw bad("Offer not found.", 404);
    res.json(dto(rows[0]));
  }));
  app.delete("/api/offers/:id", wrap(async (req, res) => {
    const outlet = await scope(req, req.query.outletId);
    if (!UUID.test(req.params.id)) throw bad("Invalid offer ID.");
    const { rows } = await pool.query("DELETE FROM offers WHERE id=$1 AND outlet_id=$2 RETURNING id", [req.params.id, outlet.id]);
    if (!rows.length) throw bad("Offer not found.", 404);
    res.json({ ok: true });
  }));
}
