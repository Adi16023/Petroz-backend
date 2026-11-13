CREATE TABLE IF NOT EXISTS blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  subtitle text NOT NULL DEFAULT '' CHECK (length(subtitle) <= 300),
  excerpt text NOT NULL DEFAULT '' CHECK (length(excerpt) <= 500),
  category text NOT NULL DEFAULT '' CHECK (length(category) <= 80),
  cover_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
  body_html text NOT NULL DEFAULT '',
  body_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  author_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blog_posts_slug_uidx UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS blog_posts_status_published_idx
  ON blog_posts (status, published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS blog_posts_updated_idx
  ON blog_posts (updated_at DESC);
