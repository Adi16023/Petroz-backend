CREATE TABLE IF NOT EXISTS product_daily_prices (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  day date NOT NULL,
  purchase_price numeric(14, 2) NOT NULL,
  selling_price numeric(14, 2) NOT NULL,
  PRIMARY KEY (product_id, day)
);

-- Existing prices are the only available baseline; older changes cannot be recovered.
INSERT INTO product_daily_prices (product_id, day, purchase_price, selling_price)
SELECT id, (created_at AT TIME ZONE 'Asia/Kolkata')::date,
       COALESCE(purchase_price, 0), COALESCE(selling_price, 0)
FROM products p
WHERE kind IN ('lube', 'fmcg')
  AND NOT EXISTS (SELECT 1 FROM product_daily_prices h WHERE h.product_id = p.id)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION record_product_daily_prices() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('lube', 'fmcg') THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO product_daily_prices (product_id, day, purchase_price, selling_price)
      VALUES (NEW.id, (NEW.created_at AT TIME ZONE 'Asia/Kolkata')::date,
              COALESCE(NEW.purchase_price, 0), COALESCE(NEW.selling_price, 0))
      ON CONFLICT (product_id, day) DO UPDATE
      SET purchase_price = EXCLUDED.purchase_price, selling_price = EXCLUDED.selling_price;
    ELSIF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price
       OR NEW.selling_price IS DISTINCT FROM OLD.selling_price
       OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      INSERT INTO product_daily_prices (product_id, day, purchase_price, selling_price)
      VALUES (NEW.id, (statement_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,
              COALESCE(NEW.purchase_price, 0), COALESCE(NEW.selling_price, 0))
      ON CONFLICT (product_id, day) DO UPDATE
      SET purchase_price = EXCLUDED.purchase_price, selling_price = EXCLUDED.selling_price;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_daily_prices_changed ON products;
CREATE TRIGGER product_daily_prices_changed
AFTER INSERT OR UPDATE OF purchase_price, selling_price, kind ON products
FOR EACH ROW EXECUTE FUNCTION record_product_daily_prices();
