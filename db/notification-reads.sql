-- Per-user dismissals for computed desk alerts. History keeps the snapshot that was read.
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES outlets (id) ON DELETE CASCADE,
  notification_id text NOT NULL,
  tone text NOT NULL CHECK (tone IN ('bad', 'warn', 'info')),
  text text NOT NULL,
  href text NOT NULL DEFAULT '/',
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, outlet_id, notification_id)
);

CREATE INDEX IF NOT EXISTS notification_reads_history_idx
  ON notification_reads (user_id, outlet_id, read_at DESC);
