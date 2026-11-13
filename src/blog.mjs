import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { signedUrl } from "./files.mjs";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const STATUSES = ["draft", "published"];
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

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "post";
}

async function uniqueSlug(pool, base, exceptId = null) {
  let slug = slugify(base);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const { rows } = await pool.query(
      `SELECT id FROM blog_posts WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
      [candidate, exceptId],
    );
    if (!rows.length) return candidate;
  }
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

function mediaPublicPath(fileId) {
  return `/api/public/blog/media/${fileId}`;
}

function dto(row, { publicView = false } = {}) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle || "",
    excerpt: row.excerpt || "",
    category: row.category || "",
    coverFileId: row.cover_file_id || null,
    coverUrl: row.cover_file_id ? mediaPublicPath(row.cover_file_id) : null,
    bodyHtml: row.body_html || "",
    bodyJson: row.body_json ?? {},
    status: row.status,
    publishedAt: row.published_at,
    authorId: publicView ? undefined : row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatePost(body, bad, { partial = false } = {}) {
  const data = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) throw bad("Enter a title.");
    data.title = body.title.trim().slice(0, 200);
  }
  if (!partial || body.subtitle !== undefined) {
    data.subtitle = String(body.subtitle ?? "").trim().slice(0, 300);
  }
  if (!partial || body.excerpt !== undefined) {
    data.excerpt = String(body.excerpt ?? "").trim().slice(0, 500);
  }
  if (!partial || body.category !== undefined) {
    data.category = String(body.category ?? "").trim().slice(0, 80);
  }
  if (!partial || body.slug !== undefined) {
    const raw = body.slug == null || body.slug === "" ? data.title : body.slug;
    if (typeof raw !== "string" || !raw.trim()) throw bad("Enter a slug.");
    data.slug = slugify(raw);
  }
  if (!partial || body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw bad("Status must be draft or published.");
    data.status = body.status;
  }
  if (!partial || body.bodyHtml !== undefined) {
    if (typeof body.bodyHtml !== "string") throw bad("Body must be HTML text.");
    data.bodyHtml = body.bodyHtml;
  }
  if (!partial || body.bodyJson !== undefined) {
    data.bodyJson = body.bodyJson && typeof body.bodyJson === "object" ? body.bodyJson : {};
  }
  if (!partial || body.coverFileId !== undefined) {
    if (body.coverFileId == null || body.coverFileId === "") data.coverFileId = null;
    else if (typeof body.coverFileId !== "string" || !UUID.test(body.coverFileId)) {
      throw bad("Invalid cover image.");
    } else data.coverFileId = body.coverFileId;
  }
  return data;
}

export function registerBlog(app, { pool, wrap, bad, requireSuper }) {
  app.get("/api/public/blog/media/:id", wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) throw bad("File not found.", 404);
    const { rows } = await pool.query(
      `SELECT id, object_key, kind FROM files WHERE id = $1 AND kind = 'blog' LIMIT 1`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row) throw bad("File not found.", 404);
    const url = await signedUrl(row.object_key);
    if (!url) throw bad("File storage is not configured.", 503);
    res.set("Cache-Control", "public, max-age=300");
    res.redirect(302, url);
  }));

  app.get("/api/public/blog", wrap(async (_req, res) => {
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const { rows } = await pool.query(
      `SELECT * FROM blog_posts
       WHERE status = 'published'
       ORDER BY published_at DESC NULLS LAST, updated_at DESC`,
    );
    res.json(rows.map((row) => dto(row, { publicView: true })));
  }));

  app.get("/api/public/blog/:slug", wrap(async (req, res) => {
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const slug = String(req.params.slug || "").trim();
    if (!slug || slug === "media") throw bad("Post not found.", 404);
    const { rows } = await pool.query(
      `SELECT * FROM blog_posts WHERE slug = $1 AND status = 'published' LIMIT 1`,
      [slug],
    );
    if (!rows.length) throw bad("Post not found.", 404);
    res.json(dto(rows[0], { publicView: true }));
  }));

  app.get("/api/admin/blog", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    const { rows } = await pool.query(`SELECT * FROM blog_posts ORDER BY updated_at DESC, created_at DESC`);
    res.json(rows.map((row) => dto(row)));
  }));

  app.get("/api/admin/blog/:id", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    if (!UUID.test(req.params.id)) throw bad("Post not found.", 404);
    const { rows } = await pool.query(`SELECT * FROM blog_posts WHERE id = $1`, [req.params.id]);
    if (!rows.length) throw bad("Post not found.", 404);
    res.json(dto(rows[0]));
  }));

  app.post("/api/admin/blog", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    const data = validatePost(req.body ?? {}, bad);
    data.status = data.status || "draft";
    data.bodyHtml = data.bodyHtml ?? "";
    data.bodyJson = data.bodyJson ?? {};
    data.subtitle = data.subtitle ?? "";
    data.excerpt = data.excerpt ?? "";
    data.category = data.category ?? "";
    data.coverFileId = data.coverFileId ?? null;
    data.slug = await uniqueSlug(pool, data.slug || data.title);
    const publishedAt = data.status === "published" ? new Date().toISOString() : null;
    const { rows } = await pool.query(
      `INSERT INTO blog_posts
         (slug, title, subtitle, excerpt, category, cover_file_id, body_html, body_json, status, published_at, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        data.slug,
        data.title,
        data.subtitle,
        data.excerpt,
        data.category,
        data.coverFileId,
        data.bodyHtml,
        JSON.stringify(data.bodyJson),
        data.status,
        publishedAt,
        req.user.id,
      ],
    );
    res.status(201).json(dto(rows[0]));
  }));

  app.patch("/api/admin/blog/:id", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    if (!UUID.test(req.params.id)) throw bad("Post not found.", 404);
    const existing = await pool.query(`SELECT * FROM blog_posts WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) throw bad("Post not found.", 404);
    const current = existing.rows[0];
    const data = validatePost(req.body ?? {}, bad, { partial: true });
    const title = data.title ?? current.title;
    const slug = data.slug ? await uniqueSlug(pool, data.slug, current.id) : current.slug;
    const status = data.status ?? current.status;
    let publishedAt = current.published_at;
    if (status === "published" && !publishedAt) publishedAt = new Date().toISOString();
    if (status === "draft") publishedAt = current.published_at;
    const { rows } = await pool.query(
      `UPDATE blog_posts SET
         slug = $2,
         title = $3,
         subtitle = COALESCE($4, subtitle),
         excerpt = COALESCE($5, excerpt),
         category = COALESCE($6, category),
         cover_file_id = CASE WHEN $7::boolean THEN $8::uuid ELSE cover_file_id END,
         body_html = COALESCE($9, body_html),
         body_json = COALESCE($10::jsonb, body_json),
         status = $11,
         published_at = $12,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        current.id,
        slug,
        title,
        data.subtitle ?? null,
        data.excerpt ?? null,
        data.category ?? null,
        data.coverFileId !== undefined,
        data.coverFileId ?? null,
        data.bodyHtml ?? null,
        data.bodyJson !== undefined ? JSON.stringify(data.bodyJson) : null,
        status,
        publishedAt,
      ],
    );
    res.json(dto(rows[0]));
  }));

  app.delete("/api/admin/blog/:id", wrap(async (req, res) => {
    requireSuper(req.user);
    if (!UUID.test(req.params.id)) throw bad("Post not found.", 404);
    const { rows } = await pool.query(`DELETE FROM blog_posts WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows.length) throw bad("Post not found.", 404);
    res.json({ ok: true });
  }));

  app.post("/api/admin/blog/media", wrap(async (req, res) => {
    requireSuper(req.user);
    const client = storage();
    if (!client) throw bad("File storage is not configured.", 503);
    const name = String(req.body?.name ?? "image").replace(/[^\w.\- ]+/g, "").slice(0, 120) || "image";
    const contentType = String(req.body?.contentType ?? "application/octet-stream").slice(0, 120);
    if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && contentType !== "application/pdf") {
      throw bad("Upload an image, video, or PDF.");
    }
    const raw = String(req.body?.data ?? "");
    const payload = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    const body = Buffer.from(payload, "base64");
    if (!body.length) throw bad("Choose a file.");
    if (body.length > 12 * 1024 * 1024) throw bad("File must be 12 MB or smaller.");
    const key = `platform/blog/${randomUUID()}-${name}`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    const { rows } = await pool.query(
      `INSERT INTO files (outlet_id, settings_id, kind, name, content_type, object_key, created_by)
       VALUES (NULL, NULL, 'blog', $1, $2, $3, $4)
       RETURNING id`,
      [name, contentType, key, req.user.id],
    );
    const id = rows[0].id;
    res.status(201).json({
      id,
      key,
      url: mediaPublicPath(id),
      signedUrl: await signedUrl(key),
    });
  }));
}
