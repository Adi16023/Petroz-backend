import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const LOGIN_ROLES = [
  "owner",
  "manager",
  "staff",
  "credit_customer",
  "auditor",
  "accounts_auditor",
];

export function signToken(party) {
  return jwt.sign(
    { sub: party.id, dealerId: party.dealer_id, role: party.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
}

export function requireAuth(pool) {
  return async (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Sign in required." });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await pool.query(
        `SELECT * FROM parties WHERE id = $1 AND active = true`,
        [payload.sub],
      );
      const party = rows[0];
      if (!party || !LOGIN_ROLES.includes(party.role)) {
        return res.status(401).json({ error: "Sign in required." });
      }
      req.user = party;
      next();
    } catch {
      return res.status(401).json({ error: "Sign in required." });
    }
  };
}

export async function login(pool, phone, password) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits || !password) {
    const error = new Error("Phone and password are required.");
    error.status = 400;
    throw error;
  }
  const { rows } = await pool.query(
    `SELECT * FROM parties
     WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
       AND role = ANY($2::party_role[])
       AND active = true`,
    [digits, LOGIN_ROLES],
  );
  const party = rows[0];
  if (!party?.password_hash) {
    const error = new Error("Phone or password is wrong.");
    error.status = 401;
    throw error;
  }
  const ok = await bcrypt.compare(String(password), party.password_hash);
  if (!ok) {
    const error = new Error("Phone or password is wrong.");
    error.status = 401;
    throw error;
  }
  return party;
}

export async function outletIdsFor(pool, party) {
  if (party.role === "owner" || party.role === "auditor" || party.role === "accounts_auditor") {
    const { rows } = await pool.query(
      `SELECT id FROM outlets WHERE dealer_id = $1 ORDER BY name`,
      [party.dealer_id],
    );
    return rows.map((row) => row.id);
  }
  const { rows } = await pool.query(
    `SELECT outlet_id FROM party_outlets WHERE party_id = $1`,
    [party.id],
  );
  return rows.map((row) => row.outlet_id);
}

export async function assertOutlet(pool, party, outletId) {
  if (!outletId) {
    const error = new Error("outletId is required.");
    error.status = 400;
    throw error;
  }
  const { rows } = await pool.query(
    `SELECT id, dealer_id, name, code FROM outlets WHERE id = $1`,
    [outletId],
  );
  const outlet = rows[0];
  if (!outlet || outlet.dealer_id !== party.dealer_id) {
    const error = new Error("Outlet not found.");
    error.status = 404;
    throw error;
  }
  const allowed = await outletIdsFor(pool, party);
  if (!allowed.includes(outlet.id)) {
    const error = new Error("This pump is not on your desk.");
    error.status = 403;
    throw error;
  }
  return outlet;
}
