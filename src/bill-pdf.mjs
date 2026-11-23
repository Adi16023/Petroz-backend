import { deleteObject, putObjectBytes, signedUrl, storageConfigured } from "./files.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

export function billPdfObjectKey(outletId, billId) {
  return `${outletId}/bill-pdf/${billId}.pdf`;
}

/** Drop the cached A4 PDF for a bill (S3 object + DB pointer). Safe if storage is unset. */
export async function clearBillPdfCache(pool, row) {
  if (!row) return;
  const key = row.pdf_object_key || null;
  if (key) await deleteObject(key);
  if (row.id && (key || row.pdf_object_key != null)) {
    await pool.query(`UPDATE billing SET pdf_object_key = NULL WHERE id = $1`, [row.id]);
  }
}

function pdfBufferFromBody(raw) {
  const text = String(raw ?? "");
  const payload = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  return Buffer.from(payload, "base64");
}

/**
 * Authenticated bill PDF cache:
 * - GET  /api/billing/:id/pdf?outletId=…  → { ready, url, billNo }
 * - PUT  /api/billing/:id/pdf             → store PDF bytes (worker / future Chromium), { ready, url }
 *
 * Public:
 * - GET /api/public/bills/:token/pdf      → { ready, url, billNo } (404 if cancelled / unknown)
 */
export function registerBillPdf(app, { pool, wrap, bad, assertOutlet }) {
  app.get("/api/billing/:id/pdf", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.query.outletId);
    if (!UUID_RE.test(req.params.id)) throw bad("Invalid bill ID.");
    const { rows } = await pool.query(
      `SELECT id, outlet_id, bill_no, cancelled_at, pdf_object_key
       FROM billing WHERE id = $1 AND outlet_id = $2`,
      [req.params.id, outlet.id],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found.", 404);
    if (row.cancelled_at) throw bad("Bill not found or no longer available.", 404);
    if (!row.pdf_object_key) {
      res.json({ ready: false, url: null, billNo: row.bill_no });
      return;
    }
    if (!storageConfigured()) throw bad("File storage is not configured.", 503);
    const url = await signedUrl(row.pdf_object_key);
    if (!url) throw bad("File storage is not configured.", 503);
    res.json({ ready: true, url, billNo: row.bill_no });
  }));

  app.put("/api/billing/:id/pdf", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    if (!UUID_RE.test(req.params.id)) throw bad("Invalid bill ID.");
    if (!storageConfigured()) throw bad("File storage is not configured.", 503);

    const { rows } = await pool.query(
      `SELECT id, outlet_id, bill_no, cancelled_at, pdf_object_key
       FROM billing WHERE id = $1 AND outlet_id = $2`,
      [req.params.id, outlet.id],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found.", 404);
    if (row.cancelled_at) throw bad("Cancelled bills cannot store a PDF.", 409);

    const body = pdfBufferFromBody(req.body?.data);
    if (!body.length) throw bad("PDF data is required.");
    if (body.length > MAX_PDF_BYTES) throw bad("PDF must be 12 MB or smaller.");
    // %PDF magic
    if (body[0] !== 0x25 || body[1] !== 0x50 || body[2] !== 0x44 || body[3] !== 0x46) {
      throw bad("Upload a PDF file.");
    }

    const key = billPdfObjectKey(outlet.id, row.id);
    if (row.pdf_object_key && row.pdf_object_key !== key) await deleteObject(row.pdf_object_key);
    await putObjectBytes(key, body, "application/pdf");
    await pool.query(`UPDATE billing SET pdf_object_key = $2 WHERE id = $1`, [row.id, key]);
    const url = await signedUrl(key);
    res.json({ ready: true, url, billNo: row.bill_no });
  }));
}

export function registerPublicBillPdf(app, { pool, wrap, bad }) {
  app.get("/api/public/bills/:token/pdf", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.set("Referrer-Policy", "no-referrer");
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) throw bad("Bill not found or no longer available.", 404);
    const { rows } = await pool.query(
      `SELECT id, bill_no, cancelled_at, pdf_object_key
       FROM billing WHERE public_token = $1 AND cancelled_at IS NULL`,
      [req.params.token],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found or no longer available.", 404);
    if (!row.pdf_object_key) {
      res.json({ ready: false, url: null, billNo: row.bill_no });
      return;
    }
    if (!storageConfigured()) throw bad("File storage is not configured.", 503);
    const url = await signedUrl(row.pdf_object_key);
    if (!url) throw bad("File storage is not configured.", 503);
    res.json({ ready: true, url, billNo: row.bill_no });
  }));
}
