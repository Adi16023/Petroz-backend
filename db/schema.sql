-- Petroz dealer desk. Tables match the screens that are on:
-- Dashboard, DSR, Shifts, Sales, Dip, Stock, Lube / Products,
-- Credit customers, Staff, Attendance, Purchases, Expenses,
-- Banking, Exports, Activity log, Settings.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE party_role AS ENUM (
    'owner',
    'manager',
    'staff',
    'credit_customer',
    'auditor',
    'accounts_auditor',
    'supplier',
    'bank',
    'provider'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_type AS ENUM (
    'cashier',
    'pump_boy',
    'supervisor',
    'air_boy',
    'dsm',
    'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE credit_status AS ENUM (
    'clear',
    'restricted',
    'frozen',
    'blacklisted'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE product_kind AS ENUM ('fuel', 'lube', 'fmcg');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE equipment_kind AS ENUM ('tank', 'nozzle');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE shift_status AS ENUM (
    'upcoming',
    'open',
    'closed',
    'approved',
    'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE investigation_status AS ENUM (
    'open',
    'proof_requested',
    'resolved'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE reading_kind AS ENUM ('opening', 'closing', 'dip');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dip_status AS ENUM ('normal', 'difference', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE document_kind AS ENUM (
    'sale',
    'quote',
    'order',
    'purchase_order',
    'purchase',
    'payment',
    'receipt',
    'transfer',
    'settlement',
    'expense',
    'expense_schedule',
    'salary',
    'adjustment',
    'dsr'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE pay_mode AS ENUM (
    'cash',
    'upi',
    'card',
    'credit',
    'neft',
    'rtgs',
    'imps',
    'cheque',
    'bank'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS dealers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auto_approve_below numeric(14, 2) NOT NULL DEFAULT 500,
  variance_alert numeric(14, 2) NOT NULL DEFAULT 200,
  auditor_can_file_findings boolean NOT NULL DEFAULT false,
  schedules jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id uuid NOT NULL REFERENCES dealers (id),
  name text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, code)
);

CREATE TABLE IF NOT EXISTS parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id uuid NOT NULL REFERENCES dealers (id),
  role party_role NOT NULL,
  staff_type staff_type,
  name text NOT NULL,
  phone text,
  alt_phone text,
  email text,
  password_hash text,
  desk_code text,
  designation text,
  permission_grants text[] NOT NULL DEFAULT '{}',
  permission_revokes text[] NOT NULL DEFAULT '{}',
  manager_can_assign boolean NOT NULL DEFAULT false,
  address text,
  gstin text,
  customer_type text,
  vehicle text,
  credit_limit numeric(14, 2),
  credit_period_days integer,
  credit_status credit_status,
  dnd boolean NOT NULL DEFAULT false,
  bank_name text,
  account_no text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS parties_dealer_phone_uidx
  ON parties (dealer_id, phone)
  WHERE phone IS NOT NULL AND phone <> '';

CREATE TABLE IF NOT EXISTS party_outlets (
  party_id uuid NOT NULL REFERENCES parties (id),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  PRIMARY KEY (party_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id uuid NOT NULL REFERENCES dealers (id),
  kind product_kind NOT NULL,
  name text NOT NULL,
  brand text,
  code text,
  hsn text,
  unit text,
  gst numeric(5, 2),
  purchase_price numeric(14, 2),
  selling_price numeric(14, 2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  parent_id uuid REFERENCES equipment (id),
  product_id uuid REFERENCES products (id),
  kind equipment_kind NOT NULL,
  label text NOT NULL,
  capacity numeric(14, 3),
  live_qty numeric(14, 3) NOT NULL DEFAULT 0,
  meter numeric(14, 3) NOT NULL DEFAULT 0,
  tolerance numeric(14, 3),
  dip_chart jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'tank' AND parent_id IS NULL)
    OR (kind = 'nozzle' AND parent_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS balances (
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  product_id uuid NOT NULL REFERENCES products (id),
  on_hand numeric(14, 3) NOT NULL DEFAULT 0,
  min_qty numeric(14, 3) NOT NULL DEFAULT 0,
  PRIMARY KEY (outlet_id, product_id)
);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  label text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status shift_status NOT NULL DEFAULT 'upcoming',
  expected_cash numeric(14, 2) NOT NULL DEFAULT 0,
  declared_cash numeric(14, 2),
  closed_by uuid REFERENCES parties (id),
  approved_by uuid REFERENCES parties (id),
  unlock_reason text,
  investigation investigation_status,
  investigation_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_duties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES shifts (id),
  party_id uuid NOT NULL REFERENCES parties (id),
  nozzle_id uuid NOT NULL REFERENCES equipment (id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  checked_out_at timestamptz
);

CREATE TABLE IF NOT EXISTS readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid REFERENCES shifts (id),
  equipment_id uuid NOT NULL REFERENCES equipment (id),
  party_id uuid REFERENCES parties (id),
  kind reading_kind NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  mm numeric(14, 3),
  qty numeric(14, 3),
  book_qty numeric(14, 3),
  status dip_status,
  remarks text
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  party_id uuid REFERENCES parties (id),
  counterparty_id uuid REFERENCES parties (id),
  shift_id uuid REFERENCES shifts (id),
  parent_id uuid REFERENCES documents (id),
  kind document_kind NOT NULL,
  status text NOT NULL DEFAULT 'open',
  doc_no text,
  doc_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  tax numeric(14, 2) NOT NULL DEFAULT 0,
  charges numeric(14, 2) NOT NULL DEFAULT 0,
  net numeric(14, 2) NOT NULL DEFAULT 0,
  mode pay_mode,
  category text,
  reference text,
  vehicle text,
  note text,
  frequency text,
  next_due date,
  reimbursable boolean NOT NULL DEFAULT false,
  deduct_from_shift_cash boolean NOT NULL DEFAULT false,
  attachment text,
  created_by uuid REFERENCES parties (id),
  decided_by uuid REFERENCES parties (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    status IN (
      'draft',
      'open',
      'partial',
      'approved',
      'rejected',
      'paid',
      'pending',
      'settled',
      'difference',
      'failed',
      'reversed',
      'cancelled',
      'locked',
      'sent',
      'received',
      'completed'
    )
  )
);

CREATE TABLE IF NOT EXISTS document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id),
  product_id uuid REFERENCES products (id),
  equipment_id uuid REFERENCES equipment (id),
  description text,
  qty numeric(14, 3) NOT NULL DEFAULT 0,
  rate numeric(14, 4) NOT NULL DEFAULT 0,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  qty_received numeric(14, 3)
);

CREATE TABLE IF NOT EXISTS attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES parties (id),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  check_in timestamptz NOT NULL,
  check_out timestamptz,
  gps_ok boolean NOT NULL DEFAULT false,
  geofence_ok boolean NOT NULL DEFAULT false,
  selfie boolean NOT NULL DEFAULT false,
  spoof boolean NOT NULL DEFAULT false,
  device text,
  manual_by uuid REFERENCES parties (id)
);

CREATE TABLE IF NOT EXISTS activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  outlet_id uuid REFERENCES outlets (id),
  actor_id uuid REFERENCES parties (id),
  action text NOT NULL,
  detail text,
  target_table text,
  target_id uuid,
  status text
);

CREATE INDEX IF NOT EXISTS outlets_dealer_idx ON outlets (dealer_id);
CREATE INDEX IF NOT EXISTS parties_dealer_idx ON parties (dealer_id);
CREATE INDEX IF NOT EXISTS parties_role_idx ON parties (role);
CREATE INDEX IF NOT EXISTS party_outlets_outlet_idx ON party_outlets (outlet_id);
CREATE INDEX IF NOT EXISTS products_dealer_idx ON products (dealer_id);
CREATE INDEX IF NOT EXISTS equipment_outlet_idx ON equipment (outlet_id);
CREATE INDEX IF NOT EXISTS equipment_parent_idx ON equipment (parent_id);
CREATE INDEX IF NOT EXISTS balances_product_idx ON balances (product_id);
CREATE INDEX IF NOT EXISTS shifts_outlet_idx ON shifts (outlet_id, starts_at);
CREATE INDEX IF NOT EXISTS shift_duties_shift_idx ON shift_duties (shift_id);
CREATE INDEX IF NOT EXISTS shift_duties_party_idx ON shift_duties (party_id);
CREATE INDEX IF NOT EXISTS readings_shift_idx ON readings (shift_id);
CREATE INDEX IF NOT EXISTS readings_equipment_idx ON readings (equipment_id);
CREATE INDEX IF NOT EXISTS documents_outlet_idx ON documents (outlet_id, kind, doc_date);
CREATE INDEX IF NOT EXISTS documents_party_idx ON documents (party_id);
CREATE INDEX IF NOT EXISTS documents_parent_idx ON documents (parent_id);
CREATE INDEX IF NOT EXISTS documents_shift_idx ON documents (shift_id);
CREATE INDEX IF NOT EXISTS document_lines_document_idx ON document_lines (document_id);
CREATE INDEX IF NOT EXISTS attendance_party_idx ON attendance (party_id, check_in);
CREATE INDEX IF NOT EXISTS activity_outlet_idx ON activity (outlet_id, at);
