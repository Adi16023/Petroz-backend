ALTER TABLE products ADD COLUMN IF NOT EXISTS discount numeric(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount numeric(5, 2);

UPDATE products SET discount = 0 WHERE discount IS NULL;
