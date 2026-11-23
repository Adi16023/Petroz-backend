import { billPdfObjectKey } from "./bill-pdf.mjs";
import { putObjectBytes, signedUrl, storageConfigured } from "./files.mjs";

/** In-flight generates so parallel clicks share one Chromium run per bill. */
const inflight = new Map();

function frontendOrigin() {
  const raw = process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || process.env.APP_ORIGIN || "";
  return raw.replace(/\/$/, "");
}

async function launchBrowser() {
  let puppeteer;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    const error = new Error("PDF generation requires the puppeteer package. Run npm install in petroz-backend.");
    error.status = 503;
    throw error;
  }
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  return puppeteer.default.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  });
}

/**
 * Print the live public bill page with Chromium (same CSS engine as Print → Save as PDF).
 * Requires FRONTEND_URL (e.g. https://app.petrozz.com) and S3 file storage.
 */
export async function renderBillPdfBytes(publicToken) {
  const origin = frontendOrigin();
  if (!origin) {
    const error = new Error("FRONTEND_URL is not configured for PDF generation.");
    error.status = 503;
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(publicToken)) {
    const error = new Error("Invalid bill token.");
    error.status = 400;
    throw error;
  }

  const url = `${origin}/bill/${publicToken}`;
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.waitForSelector(".public-bill", { timeout: 30_000 });
    // Match desk Print A4: hide on-screen chrome, zero margins.
    await page.addStyleTag({
      content: `
        .print\\:hidden, [class*="print:hidden"] { display: none !important; }
        html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
        .public-bill { margin: 0 auto !important; box-shadow: none !important; }
      `,
    });
    const bytes = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(bytes);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * Render (if needed), store in S3, set billing.pdf_object_key, return signed URL payload.
 * @param {object} row — billing row with id, outlet_id, bill_no, public_token, pdf_object_key
 */
export async function ensureBillPdfCached(pool, row) {
  if (!row?.id || !row.public_token) {
    const error = new Error("Bill not found.");
    error.status = 404;
    throw error;
  }
  if (!storageConfigured()) {
    const error = new Error("File storage is not configured.");
    error.status = 503;
    throw error;
  }
  if (row.pdf_object_key) {
    const url = await signedUrl(row.pdf_object_key);
    if (url) return { ready: true, url, billNo: row.bill_no, cached: true };
  }

  const existing = inflight.get(row.id);
  if (existing) return existing;

  const job = (async () => {
    const pdf = await renderBillPdfBytes(row.public_token);
    if (pdf.length > 12 * 1024 * 1024) {
      const error = new Error("Generated PDF is too large.");
      error.status = 500;
      throw error;
    }
    const key = billPdfObjectKey(row.outlet_id, row.id);
    if (row.pdf_object_key && row.pdf_object_key !== key) {
      const { deleteObject } = await import("./files.mjs");
      await deleteObject(row.pdf_object_key);
    }
    await putObjectBytes(key, pdf, "application/pdf");
    await pool.query(`UPDATE billing SET pdf_object_key = $2 WHERE id = $1`, [row.id, key]);
    const url = await signedUrl(key);
    return { ready: true, url, billNo: row.bill_no, cached: false };
  })().finally(() => {
    inflight.delete(row.id);
  });

  inflight.set(row.id, job);
  return job;
}
