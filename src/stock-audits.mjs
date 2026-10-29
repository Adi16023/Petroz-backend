const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const FUELS = [
  { id: "diesel", label: "HSD", family: "diesel" },
  { id: "petrol", label: "MS", family: "petrol" },
  { id: "premium", label: "XP", family: "petrol" },
  { id: "power", label: "Premium Diesel", family: "diesel" },
];
const text = (value, limit, field, bad) => {
  if (typeof value !== "string" || value.length > limit) throw bad(`Enter valid ${field}.`);
  return value.trim();
};
function date(value, bad) {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw bad("Choose valid audit dates.");
  return value;
}
function quantity(value, required, bad) {
  if (value === null && !required) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 999999999999) throw bad("Complete the audit with valid non-negative readings and quantities.");
  return value;
}
export function validateAudit(body, bad) {
  if (!body || !["draft", "submitted"].includes(body.status)) throw bad("Choose a valid audit status.");
  if (!Number.isInteger(body.version) || body.version < 0 || body.version > 2147483646) throw bad("Invalid audit version.");
  const raw = body.data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("Audit details are required.");
  const data = {};
  for (const [field, limit] of [["dealerName", 200], ["sapCode", 100], ["notes", 500], ["verifiedBy", 120], ["designation", 120]]) {
    data[field] = text(raw[field], limit, field, bad);
  }
  data.previousDate = date(raw.previousDate, bad);
  data.auditDate = date(raw.auditDate, bad);
  if (data.auditDate < data.previousDate) throw bad("Audit date cannot precede the previous visit.");
  if (raw.tankId !== "all" && (typeof raw.tankId !== "string" || !UUID.test(raw.tankId))) throw bad("Choose a valid tank.");
  data.tankId = raw.tankId;
  data.signature = text(raw.signature, 2800000, "signature image", bad);
  if (data.signature) {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.signature);
    if (!match) throw bad("Signature must be a PNG or JPEG image.");
    const bytes = Buffer.from(match[2], "base64");
    const valid = match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid || bytes.length > 2 * 1024 * 1024) throw bad("Signature must be a valid image under 2 MB.");
  }
  if (!Array.isArray(raw.fuels) || !raw.fuels.length || raw.fuels.length > 4) throw bad("Select fuel tanks for the audit.");
  const required = body.status === "submitted";
  if (required && !data.verifiedBy) throw bad("Verifier name is required to submit an audit.");
  const ids = new Set();
  const nozzleIds = new Set();
  data.fuels = raw.fuels.map((rawFuel) => {
    const kind = FUELS.find((fuel) => fuel.id === rawFuel?.id);
    if (!kind || ids.has(kind.id)) throw bad("Choose unique, valid audit fuels.");
    ids.add(kind.id);
    const fuel = { ...kind };
    for (const field of ["opening", "receipts", "actual"]) fuel[field] = quantity(rawFuel[field], required, bad);
    if (!Array.isArray(rawFuel.nozzles) || rawFuel.nozzles.length > 100) throw bad("Invalid nozzle list.");
    fuel.nozzles = rawFuel.nozzles.map((rawNozzle) => {
      if (!rawNozzle || !UUID.test(rawNozzle.id) || nozzleIds.has(rawNozzle.id)) throw bad("Invalid or repeated nozzle.");
      nozzleIds.add(rawNozzle.id);
      const nozzle = { id: rawNozzle.id, label: text(rawNozzle.label, 150, "nozzle label", bad) };
      for (const field of ["previous", "current", "testing"]) nozzle[field] = quantity(rawNozzle[field], required, bad);
      if (nozzle.current != null && nozzle.previous != null && nozzle.testing != null && nozzle.current < nozzle.previous + nozzle.testing) throw bad("Current nozzle reading must cover previous reading and testing.");
      return nozzle;
    });
    if (fuel.opening != null && fuel.receipts != null && fuel.actual != null && fuel.actual > fuel.opening + fuel.receipts) throw bad("Actual stock cannot exceed opening stock plus receipts.");
    return fuel;
  });
  return { data, status: body.status, version: body.version };
}
function fuelOf(name) {
  const key = String(name ?? "").toLowerCase();
  if (/power.*diesel|premium.*diesel|hi-speed diesel|xtragreen|turbojet/.test(key)) return "power";
  if (/diesel|hsd|xtramile/.test(key)) return "diesel";
  if (/premium|power|xp|speed|xtra/.test(key)) return "premium";
  if (/petrol|\bms\b/.test(key)) return "petrol";
  return null;
}
const litres = (value) => value == null ? null : Number(value) * (Math.abs(Number(value)) < 1000 ? 1000 : 1);
function endOfDay(day, cutoff) {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cutoff ?? "") ? cutoff : "00:00";
  const date = new Date(`${day}T${time}:00+05:30`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}
function dto(row) {
  return { id: row.id, version: row.version, status: row.status, data: row.data, updatedAt: row.updated_at, submittedAt: row.submitted_at };
}
export function registerStockAudits(app, { pool, wrap, bad, assertOutlet }) {
  async function scope(req, id) {
    const user = req.user;
    const staffDip = user.role === "staff" && user.permission_grants?.includes("tank_dip") && !user.permission_revokes?.includes("tank_dip");
    if (!["owner", "manager", "auditor", "super_admin"].includes(user.role) && !staffDip) throw bad("You cannot access stock audits.", 403);
    if (typeof id !== "string" || !UUID.test(id)) throw bad("A valid outletId is required.");
    return assertOutlet(pool, user, id);
  }
  app.get("/api/stock-audits/prefill", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.query.outletId);
    const previousDate = date(req.query.previousDate, bad);
    const auditDate = date(req.query.auditDate, bad);
    if (previousDate > auditDate) throw bad("Audit date cannot precede the previous visit.");
    const tankId = req.query.tankId ?? "all";
    if (tankId !== "all" && (typeof tankId !== "string" || !UUID.test(tankId))) throw bad("Choose a valid tank.");
    const config = await pool.query("SELECT desk FROM outlets WHERE id=$1", [outlet.id]);
    const start = endOfDay(previousDate, config.rows[0]?.desk?.businessDayEnd);
    const end = endOfDay(auditDate, config.rows[0]?.desk?.businessDayEnd);
    const equipment = await pool.query(
      `SELECT e.id,e.kind,e.parent_id,e.label,pr.name AS product_name
       FROM equipment e LEFT JOIN products pr ON pr.id=e.product_id
       WHERE e.outlet_id=$1 AND e.active=true ORDER BY e.label,e.id`, [outlet.id]);
    const allTanks = equipment.rows.filter((item) => item.kind === "tank" && fuelOf(item.product_name));
    const tanks = allTanks.filter((tank) => tankId === "all" || tank.id === tankId);
    if (!tanks.length) throw bad("No configured fuel tanks found for this selection.");
    const tankIds = tanks.map((tank) => tank.id);
    const nozzles = equipment.rows.filter((item) => item.kind === "nozzle" && tankIds.includes(item.parent_id));
    const readings = await pool.query(
      `SELECT r.*,s.entry AS shift_entry FROM dip_readings r JOIN equipment e ON e.id=r.equipment_id
       LEFT JOIN shifts s ON s.id=r.shift_id WHERE e.outlet_id=$1 AND r.at<$2
       AND (r.status IS NULL OR r.status::text NOT IN ('pending','rejected')) ORDER BY r.at DESC,r.id DESC`, [outlet.id, end]);
    const receipts = await pool.query(
      `SELECT l.*,p.note,pr.name AS product_name FROM purchase_items l
       JOIN purchases p ON p.id=l.purchase_id JOIN products pr ON pr.id=l.product_id
       WHERE p.outlet_id=$1 AND p.kind='purchase' AND pr.kind='fuel'
       AND p.status NOT IN ('draft','rejected','cancelled','reversed')
       AND p.doc_date>$2::date AND p.doc_date<=$3::date`, [outlet.id, previousDate, auditDate]);
    const testing = await pool.query(
      `SELECT l.equipment_id,SUM(l.test_qty) AS testing FROM sale_items l JOIN sales s ON s.id=l.sale_id
       WHERE s.outlet_id=$1 AND s.status NOT IN ('draft','rejected','cancelled','reversed')
       AND s.doc_date>$2::date AND s.doc_date<=$3::date GROUP BY l.equipment_id`, [outlet.id, previousDate, auditDate]);
    const warnings = [];
    const latest = (id, kind, before, after = null) => readings.rows.find((row) => row.equipment_id === id && row.kind === kind && new Date(row.at) < before && (!after || new Date(row.at) >= after));
    const fuelIds = tankId === "all" ? ["diesel", "petrol", "premium"] : [...new Set(tanks.map((tank) => fuelOf(tank.product_name)))];
    if (tanks.some((tank) => fuelOf(tank.product_name) === "power") && !fuelIds.includes("power")) fuelIds.push("power");
    const fuels = fuelIds.map((id) => {
      const mine = tanks.filter((tank) => fuelOf(tank.product_name) === id);
      const opening = mine.map((tank) => litres(latest(tank.id, "dip", start)?.qty));
      const actual = mine.map((tank) => litres(latest(tank.id, "dip", end, start)?.qty));
      const sum = (values) => values.some((value) => value == null) ? null : values.reduce((total, value) => total + value, 0);
      let received = 0;
      for (const receipt of receipts.rows.filter((item) => fuelOf(item.product_name) === id)) {
        const tankName = /^Tank:\s*(.+)$/im.exec(receipt.note ?? "")?.[1]?.trim();
        if (tankId !== "all") {
          if (receipt.equipment_id && receipt.equipment_id !== tankId) continue;
          if (!receipt.equipment_id && tankName && tankName !== tanks[0].label && tankName !== tankId) continue;
          if (!receipt.equipment_id && !tankName && allTanks.filter((tank) => fuelOf(tank.product_name) === id).length > 1) {
            received = null;
            warnings.push("Some receipts are not assigned to a tank. Enter this tank's receipts manually.");
            break;
          }
        }
        received += litres(receipt.qty_received ?? receipt.qty) ?? 0;
      }
      const fuelNozzles = nozzles.filter((nozzle) => mine.some((tank) => tank.id === nozzle.parent_id)).map((nozzle) => {
        const previous = latest(nozzle.id, "closing", start);
        const current = latest(nozzle.id, "closing", end, start);
        return {
          id: nozzle.id, label: nozzle.label, previous: previous ? Number(previous.qty) : null,
          current: current ? Number(current.qty) : null,
          testing: Number(testing.rows.find((item) => item.equipment_id === nozzle.id)?.testing ?? 0),
        };
      });
      return { ...FUELS.find((fuel) => fuel.id === id), opening: sum(opening), actual: sum(actual), receipts: received, nozzles: fuelNozzles };
    });
    if (fuels.some((fuel) => [fuel.opening, fuel.actual, ...fuel.nozzles.flatMap((nozzle) => [nozzle.previous, nozzle.current])].includes(null))) {
      warnings.push("Some historical readings are missing. Complete the blank audit values before submitting.");
    }
    res.json({
      data: { dealerName: outlet.name, sapCode: outlet.code ?? "", previousDate, auditDate, tankId, fuels, notes: "", verifiedBy: req.user.name ?? "", designation: req.user.designation ?? "", signature: "" },
      warnings: [...new Set(warnings)],
    });
  }));
  app.get("/api/stock-audits", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.query.outletId);
    const { rows } = await pool.query(
      `SELECT id,version,status,previous_date::text AS "previousDate",audit_date::text AS "auditDate",
       data->>'tankId' AS "tankId",data->>'verifiedBy' AS "verifiedBy",updated_at AS "updatedAt",submitted_at AS "submittedAt"
       FROM stock_audits WHERE outlet_id=$1 ORDER BY audit_date DESC,updated_at DESC`, [outlet.id]);
    res.json(rows);
  }));
  app.get("/api/stock-audits/:id", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.query.outletId);
    if (!UUID.test(req.params.id)) throw bad("Invalid audit ID.");
    const { rows } = await pool.query("SELECT * FROM stock_audits WHERE id=$1 AND outlet_id=$2", [req.params.id, outlet.id]);
    if (!rows.length) throw bad("Audit not found.", 404);
    res.json(dto(rows[0]));
  }));
  app.put("/api/stock-audits/:id", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const outlet = await scope(req, req.body?.outletId);
    if (!UUID.test(req.params.id)) throw bad("Invalid audit ID.");
    const audit = validateAudit(req.body, bad);
    let result;
    if (audit.version === 0) {
      result = await pool.query(
        `INSERT INTO stock_audits(id,outlet_id,previous_date,audit_date,status,data,created_by,updated_by,submitted_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7,CASE WHEN $5='submitted' THEN now() END)
         ON CONFLICT(id) DO NOTHING RETURNING *`,
        [req.params.id, outlet.id, audit.data.previousDate, audit.data.auditDate, audit.status, JSON.stringify(audit.data), req.user.id]);
    } else {
      result = await pool.query(
        `UPDATE stock_audits SET previous_date=$3,audit_date=$4,status=$5,data=$6::jsonb,updated_by=$7,
         version=version+1,updated_at=now(),submitted_at=CASE WHEN $5='submitted' THEN now() END
         WHERE id=$1 AND outlet_id=$2 AND version=$8 AND status='draft' RETURNING *`,
        [req.params.id, outlet.id, audit.data.previousDate, audit.data.auditDate, audit.status, JSON.stringify(audit.data), req.user.id, audit.version]);
    }
    if (!result.rows.length) throw bad("Audit changed or was already submitted. Reopen the saved audit before continuing.", 409);
    res.json(dto(result.rows[0]));
  }));
}
