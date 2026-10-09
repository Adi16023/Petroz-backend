import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const LOGIN_ROLES = [
  "super_admin",
  "owner",
  "manager",
  "staff",
  "credit_customer",
  "auditor",
  "accounts_auditor",
  "attendance",
];

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, dealerId: user.settings_id, role: user.role },
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
        `SELECT * FROM users WHERE id = $1 AND active = true`,
        [payload.sub],
      );
      const user = rows[0];
      if (!user || !LOGIN_ROLES.includes(user.role)) {
        return res.status(401).json({ error: "Sign in required." });
      }
      req.user = user;
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
    `SELECT * FROM users
     WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
       AND role = ANY($2::user_role[])
       AND active = true`,
    [digits, LOGIN_ROLES],
  );
  const user = rows[0];
  if (!user?.password_hash) {
    const error = new Error("Phone or password is wrong.");
    error.status = 401;
    throw error;
  }
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) {
    const error = new Error("Phone or password is wrong.");
    error.status = 401;
    throw error;
  }
  return user;
}

export async function outletIdsFor(pool, user) {
  if (user.role === "super_admin") {
    const { rows } = await pool.query(`SELECT id FROM outlets ORDER BY name`);
    return rows.map((row) => row.id);
  }
  if (user.role === "attendance") return [];
  if (!user.outlet_id || user.role === "owner" || user.role === "auditor" || user.role === "accounts_auditor") {
    const { rows } = await pool.query(
      `SELECT id FROM outlets WHERE settings_id = $1 ORDER BY name`,
      [user.settings_id],
    );
    return rows.map((row) => row.id);
  }
  return [user.outlet_id];
}

export async function assertOutlet(pool, user, outletId) {
  if (!outletId) {
    const error = new Error("outletId is required.");
    error.status = 400;
    throw error;
  }
  const { rows } = await pool.query(
    `SELECT id, settings_id, name, code, address, phone, gstin, owner_whatsapp, next_bill_no, bill FROM outlets WHERE id = $1`,
    [outletId],
  );
  const outlet = rows[0];
  if (!outlet) {
    const error = new Error("Outlet not found.");
    error.status = 404;
    throw error;
  }
  if (user.role === "super_admin") return outlet;
  if (outlet.settings_id !== user.settings_id) {
    const error = new Error("Outlet not found.");
    error.status = 404;
    throw error;
  }
  const allowed = await outletIdsFor(pool, user);
  if (!allowed.includes(outlet.id)) {
    const error = new Error("This pump is not on your desk.");
    error.status = 403;
    throw error;
  }
  return outlet;
}
