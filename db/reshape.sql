-- Move an existing desk database onto the renamed tables.
-- Safe to run again: each step checks what is already there.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'dealers')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'settings') THEN
    ALTER TABLE dealers RENAME TO settings;
  END IF;
END $$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['outlets', 'parties', 'users', 'products']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'dealer_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN dealer_id TO settings_id', tbl);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'parties')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') THEN
    ALTER TABLE parties RENAME TO users;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'party_role')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    ALTER TYPE party_role RENAME TO user_role;
  END IF;
END $$;

ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS outlet_id uuid REFERENCES outlets (id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'party_outlets') THEN
    UPDATE users u
    SET outlet_id = only_one.outlet_id
    FROM (
      SELECT party_id, (array_agg(outlet_id))[1] AS outlet_id
      FROM party_outlets
      GROUP BY party_id
      HAVING count(*) = 1
    ) AS only_one
    WHERE u.id = only_one.party_id
      AND u.outlet_id IS NULL;
    DROP TABLE party_outlets;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'shifts')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'shifts' AND column_name = 'duties'
     ) THEN
    ALTER TABLE shifts ADD COLUMN duties jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'shift_duties') THEN
    UPDATE shifts s
    SET duties = COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id,
        'userId', d.party_id,
        'nozzleId', d.nozzle_id,
        'windowStart', d.window_start,
        'windowEnd', d.window_end,
        'checkedOutAt', d.checked_out_at
      ) ORDER BY d.window_start)
      FROM shift_duties d
      WHERE d.shift_id = s.id
    ), '[]'::jsonb);
    DROP TABLE shift_duties;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'readings')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'dip_readings') THEN
    ALTER TABLE readings RENAME TO dip_readings;
  END IF;
END $$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['dip_readings', 'readings', 'documents', 'attendance']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'party_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN party_id TO user_id', tbl);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sales') THEN
    CREATE TABLE sales (
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
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sale_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id uuid NOT NULL REFERENCES sales (id),
      product_id uuid REFERENCES products (id),
      equipment_id uuid REFERENCES equipment (id),
      description text,
      qty numeric(14, 3) NOT NULL DEFAULT 0,
      rate numeric(14, 4) NOT NULL DEFAULT 0,
      amount numeric(14, 2) NOT NULL DEFAULT 0
    );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'document_kind' AND e.enumlabel = 'sale'
  ) THEN
    INSERT INTO sales (
      id, outlet_id, user_id, shift_id, status, doc_no, doc_date, due_date,
      amount, tax, charges, net, mode, category, reference, vehicle, note, created_by, created_at
    )
    SELECT
      id, outlet_id, user_id, shift_id, status, doc_no, doc_date, due_date,
      amount, tax, charges, net, mode, category, reference, vehicle, note, created_by, created_at
    FROM documents
    WHERE kind = 'sale'
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO sale_lines (id, sale_id, product_id, equipment_id, description, qty, rate, amount)
    SELECT l.id, l.document_id, l.product_id, l.equipment_id, l.description, l.qty, l.rate, l.amount
    FROM document_lines l
    JOIN documents d ON d.id = l.document_id
    WHERE d.kind = 'sale'
    ON CONFLICT (id) DO NOTHING;

    UPDATE documents
    SET parent_id = NULL
    WHERE parent_id IN (SELECT id FROM documents WHERE kind = 'sale');

    DELETE FROM document_lines
    WHERE document_id IN (SELECT id FROM documents WHERE kind = 'sale');

    DELETE FROM documents WHERE kind = 'sale';

    ALTER TYPE document_kind RENAME TO document_kind_old;
    CREATE TYPE document_kind AS ENUM (
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
    ALTER TABLE documents
      ALTER COLUMN kind TYPE document_kind
      USING kind::text::document_kind;
    DROP TYPE document_kind_old;
  END IF;
END $$;
