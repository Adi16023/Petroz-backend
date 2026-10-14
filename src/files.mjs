import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "pettroz";

function storage() {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: process.env.AWS_REGION || "us-east-2",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export async function signedUrl(key) {
  const client = storage();
  if (!client || !key) return null;
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 * 60 * 24 * 7 });
}

export function registerFiles(app, { pool, wrap, bad, assertOutlet }) {
  app.post("/api/files", wrap(async (req, res) => {
    const client = storage();
    if (!client) throw bad("File storage is not configured.", 503);
    const outlet = await assertOutlet(pool, req.user, req.body?.outletId);
    const name = String(req.body?.name ?? "file").replace(/[^\w.\- ]+/g, "").slice(0, 120) || "file";
    const kind = String(req.body?.kind ?? "file").replace(/[^\w-]+/g, "").slice(0, 40) || "file";
    const contentType = String(req.body?.contentType ?? "application/octet-stream").slice(0, 120);
    const raw = String(req.body?.data ?? "");
    const payload = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    const body = Buffer.from(payload, "base64");
    if (!body.length) throw bad("Choose a file.");
    if (body.length > 8 * 1024 * 1024) throw bad("File must be 8 MB or smaller.");
    const key = `${outlet.id}/${kind}/${randomUUID()}-${name}`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    const { rows } = await pool.query(
      `INSERT INTO files (outlet_id, settings_id, kind, name, content_type, object_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [outlet.id, outlet.settings_id, kind, name, contentType, key, req.user.id],
    );
    res.status(201).json({ id: rows[0].id, key, url: await signedUrl(key) });
  }));

  app.get("/api/files/:id", wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM files WHERE id = $1`, [req.params.id]);
    const row = rows[0];
    if (!row) throw bad("File not found.", 404);
    if (row.outlet_id) await assertOutlet(pool, req.user, row.outlet_id);
    const url = await signedUrl(row.object_key);
    if (!url) throw bad("File storage is not configured.", 503);
    res.json({ id: row.id, name: row.name, url });
  }));
}
