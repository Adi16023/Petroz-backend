import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const TABS = ["customers", "business", "logins"];
const FIELDS = ["name", "company", "category", "phone", "email", "website", "username", "password", "notes"];

function key() {
  const value = process.env.CONTACTS_ENCRYPTION_KEY ?? "";
  if (!/^[a-f\d]{64}$/i.test(value)) {
    const error = new Error("Website credential storage is not configured. Set CONTACTS_ENCRYPTION_KEY to a 64-character hex key.");
    error.status = 503;
    throw error;
  }
  return Buffer.from(value, "hex");
}

export function encryptPassword(password) {
  if (!password) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

export function decryptPassword(value) {
  if (!value) return "";
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8");
}

export function validateContact(body, bad) {
  if (!body || !TABS.includes(body.tab)) throw bad("Choose a valid contact tab.");
  const data = { tab: body.tab };
  for (const field of FIELDS) {
    if (body[field] != null && typeof body[field] !== "string") throw bad(`${field} must be text.`);
    data[field] = field === "password" ? body[field] ?? "" : (body[field] ?? "").trim();
    if (data[field].length > (field === "notes" ? 5000 : 1000)) throw bad(`${field} is too long.`);
  }
  if (!data.name || !data.category) throw bad("Name and category are required.");
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw bad("Enter a valid email address.");
  if (data.tab === "logins") {
    if (!data.company || !data.username || !data.password.trim()) throw bad("Provider, username and password are required.");
    let url;
    try { url = new URL(data.website); } catch { throw bad("Enter a valid website URL."); }
    if (!["http:", "https:"].includes(url.protocol)) throw bad("Enter an http:// or https:// website URL.");
    data.phone = "";
    data.email = "";
  } else {
    if (!/^\+?[\d\s()-]{7,20}$/.test(data.phone) || data.phone.replace(/\D/g, "").length < 7) throw bad("Enter a valid phone number.");
    data.website = "";
    data.username = "";
    data.password = "";
  }
  return data;
}

function dto(row) {
  return {
    id: row.id, outletId: row.outlet_id, tab: row.tab, name: row.name, company: row.company,
    category: row.category, phone: row.phone, email: row.email, website: row.website,
    username: row.username, password: decryptPassword(row.password_encrypted), notes: row.notes,
  };
}

export function registerContacts(app, { pool, wrap, bad, assertOutlet }) {
  async function scope(req, outletId) {
    if (!["owner", "manager"].includes(req.user.role)) throw bad("Only owners and managers can manage contacts.", 403);
    return assertOutlet(pool, req.user, outletId);
  }
  app.get("/api/contacts", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.query.outletId);
    const { rows } = await pool.query("SELECT * FROM contacts WHERE outlet_id = $1 ORDER BY created_at, id", [outlet.id]);
    res.json(rows.map(dto));
  }));
  app.post("/api/contacts", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.body?.outletId);
    const data = validateContact(req.body, bad);
    const { rows } = await pool.query(
      `INSERT INTO contacts (outlet_id, tab, name, company, category, phone, email, website, username, password_encrypted, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [outlet.id, data.tab, data.name, data.company, data.category, data.phone, data.email, data.website, data.username, encryptPassword(data.password), data.notes],
    );
    res.status(201).json(dto(rows[0]));
  }));
  app.patch("/api/contacts/:id", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.body?.outletId);
    if (!/^[a-f\d-]{36}$/i.test(req.params.id)) throw bad("Invalid contact ID.");
    const data = validateContact(req.body, bad);
    const { rows } = await pool.query(
      `UPDATE contacts SET name=$3, company=$4, category=$5, phone=$6, email=$7, website=$8,
       username=$9, password_encrypted=$10, notes=$11, updated_at=now()
       WHERE id=$1 AND outlet_id=$2 AND tab=$12 RETURNING *`,
      [req.params.id, outlet.id, data.name, data.company, data.category, data.phone, data.email, data.website, data.username, encryptPassword(data.password), data.notes, data.tab],
    );
    if (!rows.length) throw bad("Contact not found.", 404);
    res.json(dto(rows[0]));
  }));
  app.delete("/api/contacts/:id", wrap(async (req, res) => {
    const outlet = await scope(req, req.query.outletId);
    if (!/^[a-f\d-]{36}$/i.test(req.params.id)) throw bad("Invalid contact ID.");
    const { rows } = await pool.query("DELETE FROM contacts WHERE id=$1 AND outlet_id=$2 RETURNING id", [req.params.id, outlet.id]);
    if (!rows.length) throw bad("Contact not found.", 404);
    res.json({ ok: true });
  }));
}
