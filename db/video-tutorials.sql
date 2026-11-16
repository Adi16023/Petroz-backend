CREATE TABLE IF NOT EXISTS video_tutorials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  url text NOT NULL CHECK (length(trim(url)) BETWEEN 8 AND 500),
  provider text NOT NULL DEFAULT 'youtube' CHECK (provider IN ('youtube', 'vimeo', 'other')),
  provider_id text NOT NULL DEFAULT '',
  thumbnail_url text NOT NULL DEFAULT '',
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  author_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_tutorials_slug_uidx UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS video_tutorials_updated_idx
  ON video_tutorials (updated_at DESC);

CREATE INDEX IF NOT EXISTS video_tutorials_created_idx
  ON video_tutorials (created_at DESC);
