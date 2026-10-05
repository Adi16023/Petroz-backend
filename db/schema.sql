-- Petroz dealer desk. Tables match the screens that are on:
-- Dashboard, DSR, Shifts, Sales, Dip, Stock, Lube / Products,
-- Credit customers, Staff, Attendance, Purchases, Expenses,
-- Banking, Exports, Activity log, Settings.
--
-- users.outlet_id is the one pump that person belongs to.
-- NULL means every outlet under that settings row (owner, auditor, a shared supplier).
-- shifts.duties is the people on that shift. One shift has many of them.
-- sales is forecourt and shop billing. sale_items is each product on a bill.
-- purchases and purchase_items are fuel and shop buying, including purchase orders.
-- banking is deposits, supplier transfers, and card or wallet settlements.
-- expenses is day-to-day costs and recurring bills.
-- documents is what is left: quotes, orders, credit receipts, salary, adjustments, and a locked DSR.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'owner',
    'manager',
    'staff',
    'credit_customer',
    'auditor',
    'accounts_auditor',
    'supplier',
    'bank',
    'provider',
    'super_admin'
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
    'closed'
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
    'quote',
    'order',
    'payment',
    'receipt',
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

CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auto_approve_below numeric(14, 2) NOT NULL DEFAULT 500,
  variance_alert numeric(14, 2) NOT NULL DEFAULT 200,
  auditor_can_file_findings boolean NOT NULL DEFAULT false,
  schedules jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id uuid NOT NULL REFERENCES settings (id),
  name text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settings_id, code)
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id uuid REFERENCES settings (id),
  outlet_id uuid REFERENCES outlets (id),
  role user_role NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS users_settings_phone_uidx
  ON users (settings_id, phone)
  WHERE phone IS NOT NULL AND phone <> '';

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id uuid NOT NULL REFERENCES settings (id),
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
  closed_by uuid REFERENCES users (id),
  approved_by uuid REFERENCES users (id),
  unlock_reason text,
  investigation investigation_status,
  investigation_note text,
  duties jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dip_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid REFERENCES shifts (id),
  equipment_id uuid NOT NULL REFERENCES equipment (id),
  user_id uuid REFERENCES users (id),
  kind reading_kind NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  mm numeric(14, 3),
  qty numeric(14, 3),
  book_qty numeric(14, 3),
  status dip_status,
  remarks text
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  user_id uuid REFERENCES users (id),
  shift_id uuid REFERENCES shifts (id),
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
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    status IN (
      'draft', 'open', 'partial', 'approved', 'rejected', 'paid', 'pending',
      'settled', 'difference', 'failed', 'reversed', 'cancelled', 'locked',
      'sent', 'received', 'completed'
    )
  )
);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales (id),
  product_id uuid REFERENCES products (id),
  equipment_id uuid REFERENCES equipment (id),
  description text,
  qty numeric(14, 3) NOT NULL DEFAULT 0,
  rate numeric(14, 4) NOT NULL DEFAULT 0,
  amount numeric(14, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  user_id uuid REFERENCES users (id),
  shift_id uuid REFERENCES shifts (id),
  kind text NOT NULL,
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
  note text,
  created_by uuid REFERENCES users (id),
  decided_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('purchase', 'purchase_order')),
  CHECK (
    status IN (
      'draft', 'open', 'partial', 'approved', 'rejected', 'paid', 'pending',
      'settled', 'difference', 'failed', 'reversed', 'cancelled', 'locked',
      'sent', 'received', 'completed'
    )
  )
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES purchases (id),
  product_id uuid REFERENCES products (id),
  equipment_id uuid REFERENCES equipment (id),
  description text,
  qty numeric(14, 3) NOT NULL DEFAULT 0,
  rate numeric(14, 4) NOT NULL DEFAULT 0,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  qty_received numeric(14, 3)
);

CREATE TABLE IF NOT EXISTS banking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  user_id uuid REFERENCES users (id),
  counterparty_id uuid REFERENCES users (id),
  shift_id uuid REFERENCES shifts (id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  doc_no text,
  doc_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  tax numeric(14, 2) NOT NULL DEFAULT 0,
  charges numeric(14, 2) NOT NULL DEFAULT 0,
  net numeric(14, 2) NOT NULL DEFAULT 0,
  mode pay_mode,
  category text,
  reference text,
  note text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('deposit', 'transfer', 'settlement')),
  CHECK (
    status IN (
      'draft', 'open', 'partial', 'approved', 'rejected', 'paid', 'pending',
      'settled', 'difference', 'failed', 'reversed', 'cancelled', 'locked',
      'sent', 'received', 'completed'
    )
  )
);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  user_id uuid REFERENCES users (id),
  shift_id uuid REFERENCES shifts (id),
  kind text NOT NULL,
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
  note text,
  frequency text,
  next_due date,
  reimbursable boolean NOT NULL DEFAULT false,
  deduct_from_shift_cash boolean NOT NULL DEFAULT false,
  attachment text,
  created_by uuid REFERENCES users (id),
  decided_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('expense', 'expense_schedule')),
  CHECK (
    status IN (
      'draft', 'open', 'partial', 'approved', 'rejected', 'paid', 'pending',
      'settled', 'difference', 'failed', 'reversed', 'cancelled', 'locked',
      'sent', 'received', 'completed'
    )
  )
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  user_id uuid REFERENCES users (id),
  counterparty_id uuid REFERENCES users (id),
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
  created_by uuid REFERENCES users (id),
  decided_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    status IN (
      'draft', 'open', 'partial', 'approved', 'rejected', 'paid', 'pending',
      'settled', 'difference', 'failed', 'reversed', 'cancelled', 'locked',
      'sent', 'received', 'completed'
    )
  )
);

CREATE TABLE IF NOT EXISTS document_items (
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
  user_id uuid NOT NULL REFERENCES users (id),
  outlet_id uuid NOT NULL REFERENCES outlets (id),
  check_in timestamptz NOT NULL,
  check_out timestamptz,
  gps_ok boolean NOT NULL DEFAULT false,
  geofence_ok boolean NOT NULL DEFAULT false,
  selfie boolean NOT NULL DEFAULT false,
  spoof boolean NOT NULL DEFAULT false,
  device text,
  manual_by uuid REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  outlet_id uuid REFERENCES outlets (id),
  actor_id uuid REFERENCES users (id),
  action text NOT NULL,
  detail text,
  target_table text,
  target_id uuid,
  status text
);

CREATE INDEX IF NOT EXISTS outlets_settings_idx ON outlets (settings_id);
CREATE INDEX IF NOT EXISTS users_settings_idx ON users (settings_id);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
CREATE INDEX IF NOT EXISTS users_outlet_idx ON users (outlet_id);
CREATE INDEX IF NOT EXISTS products_settings_idx ON products (settings_id);
CREATE INDEX IF NOT EXISTS equipment_outlet_idx ON equipment (outlet_id);
CREATE INDEX IF NOT EXISTS equipment_parent_idx ON equipment (parent_id);
CREATE INDEX IF NOT EXISTS balances_product_idx ON balances (product_id);
CREATE INDEX IF NOT EXISTS shifts_outlet_idx ON shifts (outlet_id, starts_at);
CREATE INDEX IF NOT EXISTS dip_readings_shift_idx ON dip_readings (shift_id);
CREATE INDEX IF NOT EXISTS dip_readings_equipment_idx ON dip_readings (equipment_id);
CREATE INDEX IF NOT EXISTS sales_outlet_idx ON sales (outlet_id, doc_date);
CREATE INDEX IF NOT EXISTS sales_user_idx ON sales (user_id);
CREATE INDEX IF NOT EXISTS sales_shift_idx ON sales (shift_id);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS purchases_outlet_idx ON purchases (outlet_id, doc_date);
CREATE INDEX IF NOT EXISTS purchases_user_idx ON purchases (user_id);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS banking_outlet_idx ON banking (outlet_id, kind, doc_date);
CREATE INDEX IF NOT EXISTS expenses_outlet_idx ON expenses (outlet_id, kind, doc_date);
CREATE INDEX IF NOT EXISTS documents_outlet_idx ON documents (outlet_id, kind, doc_date);
CREATE INDEX IF NOT EXISTS documents_user_idx ON documents (user_id);
CREATE INDEX IF NOT EXISTS documents_parent_idx ON documents (parent_id);
CREATE INDEX IF NOT EXISTS documents_shift_idx ON documents (shift_id);
CREATE INDEX IF NOT EXISTS document_items_document_idx ON document_items (document_id);
CREATE INDEX IF NOT EXISTS attendance_user_idx ON attendance (user_id, check_in);
CREATE INDEX IF NOT EXISTS activity_outlet_idx ON activity (outlet_id, at);
