import { deleteObject, getObjectBytes, putObjectBytes, storageConfigured } from "./files.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
/** Bump when print CSS changes so old cached PDFs (e.g. blank page 2) are regenerated. */
const PDF_CACHE_VERSION = "v3";

export function billPdfObjectKey(outletId, billId) {
  return `${outletId}/bill-pdf/${PDF_CACHE_VERSION}/${billId}.pdf`;
}

function isCurrentPdfKey(key) {
  return Boolean(key && String(key).includes(`/bill-pdf/${PDF_CACHE_VERSION}/`));
}

function pdfFilename(billNo) {
  return `${String(billNo || "invoice").replace(/[^\w.-]+/g, "_")}.pdf`;
}

function wantGenerate(query) {
  const raw = String(query?.generate ?? "1").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
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

async function ensureCurrentPdf(pool, row) {
  const { ensureBillPdfCached } = await import("./bill-pdf-render.mjs");
  const effective = isCurrentPdfKey(row.pdf_object_key) ? row : { ...row, pdf_object_key: null };
  return ensureBillPdfCached(pool, effective);
}

async function streamBillPdf(res, pool, row) {
  if (!storageConfigured()) {
    const err = new Error("File storage is not configured.");
    err.status = 503;
    throw err;
  }
  await ensureCurrentPdf(pool, row);
  const { rows } = await pool.query(`SELECT pdf_object_key, bill_no FROM billing WHERE id = $1`, [row.id]);
  const key = rows[0]?.pdf_object_key;
  if (!key) {
    const err = new Error("PDF is not ready yet.");
    err.status = 503;
    throw err;
  }
  const file = await getObjectBytes(key);
  if (!file?.bytes?.length) {
    const err = new Error("PDF file is missing from storage.");
    err.status = 404;
    throw err;
  }
  const name = pdfFilename(rows[0].bill_no || row.bill_no);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Content-Length", String(file.bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(file.bytes);
}

/**
 * Authenticated:
 * - GET  /api/billing/:id/pdf?outletId=…           → { ready, url?, billNo, downloadPath }
 * - GET  /api/billing/:id/pdf/file?outletId=…      → PDF bytes (attachment) — preferred for desk download
 * - PUT  /api/billing/:id/pdf                      → store PDF bytes manually
 *
 * Public:
 * - GET /api/public/bills/:token/pdf               → JSON metadata
 * - GET /api/public/bills/:token/pdf/file          → PDF bytes (attachment)
 */
export function registerBillPdf(app, { pool, wrap, bad, assertOutlet }) {
  app.get("/api/billing/:id/pdf/file", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.query.outletId);
    if (!UUID_RE.test(req.params.id)) throw bad("Invalid bill ID.");
    const { rows } = await pool.query(
      `SELECT id, outlet_id, bill_no, public_token, cancelled_at, pdf_object_key
       FROM billing WHERE id = $1 AND outlet_id = $2`,
      [req.params.id, outlet.id],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found.", 404);
    if (row.cancelled_at) throw bad("Bill not found or no longer available.", 404);
    try {
      await streamBillPdf(res, pool, row);
    } catch (error) {
      const status = error?.status && error.status !== 500 ? error.status : 503;
      throw bad(error?.message || "Could not download PDF.", status);
    }
  }));

  app.get("/api/billing/:id/pdf", wrap(async (req, res) => {
    const outlet = await assertOutlet(pool, req.user, req.query.outletId);
    if (!UUID_RE.test(req.params.id)) throw bad("Invalid bill ID.");
    const { rows } = await pool.query(
      `SELECT id, outlet_id, bill_no, public_token, cancelled_at, pdf_object_key
       FROM billing WHERE id = $1 AND outlet_id = $2`,
      [req.params.id, outlet.id],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found.", 404);
    if (row.cancelled_at) throw bad("Bill not found or no longer available.", 404);

    const downloadPath = `/api/billing/${row.id}/pdf/file?outletId=${encodeURIComponent(outlet.id)}`;

    if (isCurrentPdfKey(row.pdf_object_key)) {
      if (!storageConfigured()) throw bad("File storage is not configured.", 503);
      res.json({
        ready: true,
        billNo: row.bill_no,
        cached: true,
        downloadPath,
        url: null,
      });
      return;
    }

    if (!wantGenerate(req.query)) {
      res.json({ ready: false, url: null, billNo: row.bill_no, downloadPath });
      return;
    }

    try {
      await ensureCurrentPdf(pool, row);
      res.json({
        ready: true,
        billNo: row.bill_no,
        cached: false,
        downloadPath,
        url: null,
      });
    } catch (error) {
      const status = error?.status && error.status !== 500 ? error.status : 503;
      throw bad(error?.message || "Could not generate PDF.", status);
    }
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
    if (body[0] !== 0x25 || body[1] !== 0x50 || body[2] !== 0x44 || body[3] !== 0x46) {
      throw bad("Upload a PDF file.");
    }

    const key = billPdfObjectKey(outlet.id, row.id);
    if (row.pdf_object_key && row.pdf_object_key !== key) await deleteObject(row.pdf_object_key);
    await putObjectBytes(key, body, "application/pdf");
    await pool.query(`UPDATE billing SET pdf_object_key = $2 WHERE id = $1`, [row.id, key]);
    res.json({
      ready: true,
      billNo: row.bill_no,
      cached: false,
      downloadPath: `/api/billing/${row.id}/pdf/file?outletId=${encodeURIComponent(outlet.id)}`,
      url: null,
    });
  }));
}

export function registerPublicBillPdf(app, { pool, wrap, bad }) {
  app.get("/api/public/bills/:token/pdf/file", wrap(async (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.set("Referrer-Policy", "no-referrer");
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) throw bad("Bill not found or no longer available.", 404);
    const { rows } = await pool.query(
      `SELECT id, outlet_id, bill_no, public_token, cancelled_at, pdf_object_key
       FROM billing WHERE public_token = $1 AND cancelled_at IS NULL`,
      [req.params.token],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found or no longer available.", 404);
    try {
      await streamBillPdf(res, pool, row);
    } catch (error) {
      const status = error?.status && error.status !== 500 ? error.status : 503;
      throw bad(error?.message || "Could not download PDF.", status);
    }
  }));

  app.get("/api/public/bills/:token/pdf", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.set("Referrer-Policy", "no-referrer");
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) throw bad("Bill not found or no longer available.", 404);
    const { rows } = await pool.query(
      `SELECT id, outlet_id, bill_no, public_token, cancelled_at, pdf_object_key
       FROM billing WHERE public_token = $1 AND cancelled_at IS NULL`,
      [req.params.token],
    );
    const row = rows[0];
    if (!row) throw bad("Bill not found or no longer available.", 404);

    const downloadPath = `/api/public/bills/${row.public_token}/pdf/file`;

    if (isCurrentPdfKey(row.pdf_object_key)) {
      if (!storageConfigured()) throw bad("File storage is not configured.", 503);
      res.json({ ready: true, billNo: row.bill_no, cached: true, downloadPath, url: null });
      return;
    }

    if (!wantGenerate(req.query)) {
      res.json({ ready: false, url: null, billNo: row.bill_no, downloadPath });
      return;
    }

    try {
      await ensureCurrentPdf(pool, row);
      res.json({ ready: true, billNo: row.bill_no, cached: false, downloadPath, url: null });
    } catch (error) {
      const status = error?.status && error.status !== 500 ? error.status : 503;
      throw bad(error?.message || "Could not generate PDF.", status);
    }
  }));
}
