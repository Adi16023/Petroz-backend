import { randomUUID } from "node:crypto";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "video";
}

async function uniqueSlug(pool, base, exceptId = null) {
  let slug = slugify(base);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const { rows } = await pool.query(
      `SELECT id FROM video_tutorials WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
      [candidate, exceptId],
    );
    if (!rows.length) return candidate;
  }
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

export function parseVideoUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return null;

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");

  if (host === "youtu.be") {
    const id = path.slice(1).split("/")[0];
    if (id) {
      return {
        provider: "youtube",
        providerId: id,
        thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
        embedUrl: `https://www.youtube.com/embed/${id}?rel=0`,
        watchUrl: `https://www.youtube.com/watch?v=${id}`,
      };
    }
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    let id = parsed.searchParams.get("v");
    if (!id && path.startsWith("/embed/")) id = path.slice("/embed/".length).split("/")[0];
    if (!id && path.startsWith("/shorts/")) id = path.slice("/shorts/".length).split("/")[0];
    if (!id && path.startsWith("/live/")) id = path.slice("/live/".length).split("/")[0];
    if (id) {
      return {
        provider: "youtube",
        providerId: id,
        thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
        embedUrl: `https://www.youtube.com/embed/${id}?rel=0`,
        watchUrl: `https://www.youtube.com/watch?v=${id}`,
      };
    }
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const parts = path.split("/").filter(Boolean);
    const id = host === "player.vimeo.com" && parts[0] === "video" ? parts[1] : parts[0];
    if (id && /^\d+$/.test(id)) {
      return {
        provider: "vimeo",
        providerId: id,
        thumbnailUrl: "",
        embedUrl: `https://player.vimeo.com/video/${id}`,
        watchUrl: `https://vimeo.com/${id}`,
      };
    }
  }

  return null;
}

async function enrichVideoMeta(parsed) {
  if (!parsed) return { durationSeconds: null, thumbnailUrl: "" };
  if (parsed.provider === "youtube") {
    return { durationSeconds: null, thumbnailUrl: parsed.thumbnailUrl };
  }
  if (parsed.provider === "vimeo") {
    try {
      const response = await fetch(
        `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(parsed.watchUrl)}`,
      );
      if (response.ok) {
        const data = await response.json();
        return {
          durationSeconds: Number.isFinite(data.duration) ? Math.round(data.duration) : null,
          thumbnailUrl: typeof data.thumbnail_url === "string" ? data.thumbnail_url : "",
        };
      }
    } catch {
      // ignore enrichment failures
    }
  }
  return { durationSeconds: null, thumbnailUrl: parsed.thumbnailUrl || "" };
}

function dto(row) {
  const parsed = parseVideoUrl(row.url);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    url: row.url,
    provider: row.provider || parsed?.provider || "other",
    providerId: row.provider_id || parsed?.providerId || "",
    thumbnailUrl: row.thumbnail_url || parsed?.thumbnailUrl || "",
    embedUrl: parsed?.embedUrl || null,
    durationSeconds: row.duration_seconds ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateVideo(body, bad, { partial = false } = {}) {
  const data = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) throw bad("Enter a title.");
    data.title = body.title.trim().slice(0, 200);
  }
  if (!partial || body.url !== undefined) {
    if (typeof body.url !== "string" || !body.url.trim()) throw bad("Enter a video URL.");
    const parsed = parseVideoUrl(body.url.trim());
    if (!parsed) throw bad("Use a YouTube or Vimeo video URL.");
    data.url = parsed.watchUrl;
    data.provider = parsed.provider;
    data.providerId = parsed.providerId;
    data.parsed = parsed;
  }
  return data;
}

export function registerPublicVideoTutorials(app, { pool, wrap, bad }) {
  app.get("/api/public/video-tutorials", wrap(async (_req, res) => {
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const { rows } = await pool.query(
      `SELECT * FROM video_tutorials ORDER BY created_at DESC, updated_at DESC`,
    );
    res.json(rows.map((row) => dto(row)));
  }));

  app.get("/api/public/video-tutorials/:slug", wrap(async (req, res) => {
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const slug = String(req.params.slug || "").trim();
    if (!slug) throw bad("Video not found.", 404);
    const { rows } = await pool.query(`SELECT * FROM video_tutorials WHERE slug = $1 LIMIT 1`, [slug]);
    if (!rows.length) throw bad("Video not found.", 404);
    res.json(dto(rows[0]));
  }));
}

export function registerVideoTutorials(app, { pool, wrap, bad, requireSuper }) {
  app.get("/api/admin/video-tutorials", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    const { rows } = await pool.query(
      `SELECT * FROM video_tutorials ORDER BY updated_at DESC, created_at DESC`,
    );
    res.json(rows.map((row) => dto(row)));
  }));

  app.get("/api/admin/video-tutorials/:id", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    if (!UUID.test(req.params.id)) throw bad("Video not found.", 404);
    const { rows } = await pool.query(`SELECT * FROM video_tutorials WHERE id = $1`, [req.params.id]);
    if (!rows.length) throw bad("Video not found.", 404);
    res.json(dto(rows[0]));
  }));

  app.post("/api/admin/video-tutorials", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    const data = validateVideo(req.body ?? {}, bad);
    const meta = await enrichVideoMeta(data.parsed);
    const slug = await uniqueSlug(pool, data.title);
    const { rows } = await pool.query(
      `INSERT INTO video_tutorials
         (slug, title, url, provider, provider_id, thumbnail_url, duration_seconds, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        slug,
        data.title,
        data.url,
        data.provider,
        data.providerId,
        meta.thumbnailUrl || data.parsed.thumbnailUrl || "",
        meta.durationSeconds,
        req.user.id,
      ],
    );
    res.status(201).json(dto(rows[0]));
  }));

  app.patch("/api/admin/video-tutorials/:id", wrap(async (req, res) => {
    requireSuper(req.user);
    res.set("Cache-Control", "no-store");
    if (!UUID.test(req.params.id)) throw bad("Video not found.", 404);
    const existing = await pool.query(`SELECT * FROM video_tutorials WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) throw bad("Video not found.", 404);
    const current = existing.rows[0];
    const data = validateVideo(req.body ?? {}, bad, { partial: true });
    const title = data.title ?? current.title;
    const url = data.url ?? current.url;
    const provider = data.provider ?? current.provider;
    const providerId = data.providerId ?? current.provider_id;
    let thumbnailUrl = current.thumbnail_url;
    let durationSeconds = current.duration_seconds;
    if (data.parsed) {
      const meta = await enrichVideoMeta(data.parsed);
      thumbnailUrl = meta.thumbnailUrl || data.parsed.thumbnailUrl || "";
      durationSeconds = meta.durationSeconds;
    }
    const { rows } = await pool.query(
      `UPDATE video_tutorials SET
         title = $2,
         url = $3,
         provider = $4,
         provider_id = $5,
         thumbnail_url = $6,
         duration_seconds = $7,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [current.id, title, url, provider, providerId, thumbnailUrl, durationSeconds],
    );
    res.json(dto(rows[0]));
  }));

  app.delete("/api/admin/video-tutorials/:id", wrap(async (req, res) => {
    requireSuper(req.user);
    if (!UUID.test(req.params.id)) throw bad("Video not found.", 404);
    const { rows } = await pool.query(
      `DELETE FROM video_tutorials WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (!rows.length) throw bad("Video not found.", 404);
    res.json({ ok: true });
  }));
}
