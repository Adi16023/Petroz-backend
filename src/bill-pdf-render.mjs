import { billPdfObjectKey } from "./bill-pdf.mjs";
import { deleteObject, putObjectBytes, signedUrl, storageConfigured } from "./files.mjs";

/** In-flight generates so parallel clicks share one Chromium run per bill. */
const inflight = new Map();

function frontendOrigin() {
  // Production desk is fixed; override only for local/staging.
  const raw =
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.APP_ORIGIN ||
    "https://app.petrozz.com";
  return raw.replace(/\/$/, "");
}

function fail(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

async function launchBrowser() {
  const commonArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--font-render-hinting=none",
    "--single-process",
  ];

  // 1) Full puppeteer (local / hosts that downloaded Chrome)
  try {
    const puppeteer = await import("puppeteer");
    return await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: commonArgs,
    });
  } catch (first) {
    // 2) Serverless-friendly chromium (Render / slim images)
    try {
      const chromiumMod = await import("@sparticuz/chromium");
      const puppeteer = await import("puppeteer-core");
      const chromium = chromiumMod.default;
      return await puppeteer.default.launch({
        args: [...chromium.args, ...commonArgs],
        defaultViewport: chromium.defaultViewport,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath()),
        headless: chromium.headless,
      });
    } catch (second) {
      throw fail(
        `PDF engine unavailable (${first?.message || first}). Fallback: ${second?.message || second}`,
        503,
      );
    }
  }
}

/**
 * Print the live public bill page with Chromium (same CSS engine as Print → Save as PDF).
 * Opens the public bill page (default https://app.petrozz.com). Override with FRONTEND_URL for local/staging.
 * Requires S3 file storage to cache the result.
 */
export async function renderBillPdfBytes(publicToken) {
  const origin = frontendOrigin();
  if (!/^[a-f0-9]{64}$/.test(publicToken)) throw fail("Invalid bill token.", 400);

  const url = `${origin}/bill/${publicToken}`;
  let browser;
  try {
    try {
      browser = await launchBrowser();
    } catch (error) {
      if (error?.status) throw error;
      throw fail(`Could not start Chromium: ${error?.message || error}`, 503);
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
    } catch (error) {
      throw fail(`Could not open bill page (${url}): ${error?.message || error}`, 503);
    }
    try {
      await page.waitForSelector(".public-bill", { timeout: 30_000 });
    } catch {
      throw fail(`Bill page loaded but invoice layout was missing (${url}).`, 503);
    }

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
  if (!row?.id || !row.public_token) throw fail("Bill not found.", 404);
  if (!storageConfigured()) throw fail("File storage is not configured.", 503);

  if (row.pdf_object_key) {
    const url = await signedUrl(row.pdf_object_key);
    if (url) return { ready: true, url, billNo: row.bill_no, cached: true };
  }

  const existing = inflight.get(row.id);
  if (existing) return existing;

  const job = (async () => {
    let pdf;
    try {
      pdf = await renderBillPdfBytes(row.public_token);
    } catch (error) {
      if (error?.status) throw error;
      throw fail(`PDF render failed: ${error?.message || error}`, 503);
    }
    if (!pdf?.length) throw fail("Chromium returned an empty PDF.", 503);
    if (pdf.length > 12 * 1024 * 1024) throw fail("Generated PDF is too large.", 500);

    const key = billPdfObjectKey(row.outlet_id, row.id);
    if (row.pdf_object_key && row.pdf_object_key !== key) await deleteObject(row.pdf_object_key);
    try {
      await putObjectBytes(key, pdf, "application/pdf");
    } catch (error) {
      throw fail(`Could not store PDF: ${error?.message || error}`, 503);
    }
    await pool.query(`UPDATE billing SET pdf_object_key = $2 WHERE id = $1`, [row.id, key]);
    const url = await signedUrl(key);
    if (!url) throw fail("File storage is not configured.", 503);
    return { ready: true, url, billNo: row.bill_no, cached: false };
  })().finally(() => {
    inflight.delete(row.id);
  });

  inflight.set(row.id, job);
  return job;
}
