CREATE TABLE IF NOT EXISTS stock_audits (
  id uuid PRIMARY KEY,
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  previous_date date NOT NULL,
  audit_date date NOT NULL CHECK (audit_date >= previous_date),
  status text NOT NULL CHECK (status IN ('draft', 'submitted')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_audits_outlet_date_idx ON stock_audits(outlet_id, audit_date DESC);
