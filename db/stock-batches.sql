ALTER TABLE balances ADD COLUMN IF NOT EXISTS purchase_price numeric(14,2);
ALTER TABLE balances ADD COLUMN IF NOT EXISTS selling_price numeric(14,2);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS stock_cost numeric(18,4);

CREATE TABLE IF NOT EXISTS stock_batches (
  id bigserial PRIMARY KEY,
  outlet_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity >= 0),
  remaining numeric(14,3) NOT NULL CHECK (remaining >= 0),
  purchase_price numeric(14,2) NOT NULL,
  selling_price numeric(14,2) NOT NULL,
  purchase_item_id uuid REFERENCES purchase_items(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (outlet_id, product_id) REFERENCES balances(outlet_id, product_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS stock_batches_queue_idx ON stock_batches(outlet_id, product_id, id) WHERE remaining > 0;
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_purchase_item_idx ON stock_batches(purchase_item_id) WHERE purchase_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_allocations (
  sale_item_id uuid NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  batch_id bigint NOT NULL REFERENCES stock_batches(id),
  quantity numeric(14,3) NOT NULL,
  PRIMARY KEY (sale_item_id, batch_id)
);

CREATE TABLE IF NOT EXISTS outlet_product_daily_prices (
  outlet_id uuid NOT NULL,
  product_id uuid NOT NULL,
  day date NOT NULL,
  purchase_price numeric(14,2) NOT NULL,
  selling_price numeric(14,2) NOT NULL,
  PRIMARY KEY(outlet_id, product_id, day),
  FOREIGN KEY(outlet_id, product_id) REFERENCES balances(outlet_id, product_id) ON DELETE CASCADE
);

-- Existing remaining stock has no recoverable batch breakdown.
INSERT INTO stock_batches(outlet_id, product_id, quantity, remaining, purchase_price, selling_price)
SELECT b.outlet_id, b.product_id, GREATEST(0,b.on_hand), GREATEST(0,b.on_hand),
       COALESCE(p.purchase_price,0), COALESCE(p.selling_price,0)
FROM balances b JOIN products p ON p.id=b.product_id
WHERE p.kind IN ('lube','fmcg') AND b.purchase_price IS NULL;

UPDATE balances b SET purchase_price=COALESCE(p.purchase_price,0), selling_price=COALESCE(p.selling_price,0)
FROM products p WHERE p.id=b.product_id AND p.kind IN ('lube','fmcg') AND b.purchase_price IS NULL;

CREATE OR REPLACE FUNCTION initialize_stock_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p products%ROWTYPE;
BEGIN
  SELECT * INTO p FROM products WHERE id=NEW.product_id;
  IF p.kind IN ('lube','fmcg') THEN
    UPDATE balances SET purchase_price=COALESCE(p.purchase_price,0), selling_price=COALESCE(p.selling_price,0)
    WHERE outlet_id=NEW.outlet_id AND product_id=NEW.product_id;
    INSERT INTO stock_batches(outlet_id,product_id,quantity,remaining,purchase_price,selling_price)
    VALUES(NEW.outlet_id,NEW.product_id,GREATEST(0,NEW.on_hand),GREATEST(0,NEW.on_hand),
           COALESCE(p.purchase_price,0),COALESCE(p.selling_price,0));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS initialize_stock_batch ON balances;
CREATE TRIGGER initialize_stock_batch AFTER INSERT ON balances
FOR EACH ROW EXECUTE FUNCTION initialize_stock_batch();

CREATE OR REPLACE FUNCTION promote_stock_batch(p_outlet uuid,p_product uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE batch stock_batches%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM stock_batches
  WHERE outlet_id=p_outlet AND product_id=p_product AND remaining>0 ORDER BY id LIMIT 1;
  IF FOUND THEN
    UPDATE balances SET purchase_price=batch.purchase_price,selling_price=batch.selling_price
    WHERE outlet_id=p_outlet AND product_id=p_product;
  END IF;
  INSERT INTO outlet_product_daily_prices(outlet_id,product_id,day,purchase_price,selling_price)
  SELECT outlet_id,product_id,(statement_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,purchase_price,selling_price
  FROM balances WHERE outlet_id=p_outlet AND product_id=p_product
  ON CONFLICT(outlet_id,product_id,day) DO UPDATE
  SET purchase_price=EXCLUDED.purchase_price,selling_price=EXCLUDED.selling_price;
END;
$$;

CREATE OR REPLACE FUNCTION move_shop_stock(
  p_outlet uuid,p_product uuid,p_delta numeric,p_purchase_price numeric DEFAULT NULL,
  p_selling_price numeric DEFAULT NULL,p_purchase_item uuid DEFAULT NULL,p_sale_item uuid DEFAULT NULL,
  p_restore boolean DEFAULT false
) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
  b balances%ROWTYPE;
  batch stock_batches%ROWTYPE;
  allocation record;
  needed numeric;
  taken numeric;
  cost numeric:=0;
  restored numeric:=0;
BEGIN
  INSERT INTO balances(outlet_id,product_id,on_hand,min_qty) VALUES(p_outlet,p_product,0,0)
  ON CONFLICT(outlet_id,product_id) DO NOTHING;
  SELECT * INTO b FROM balances WHERE outlet_id=p_outlet AND product_id=p_product FOR UPDATE;
  IF b.purchase_price IS NULL THEN RAISE EXCEPTION 'Batch stock is only supported for lube/FMCG products.'; END IF;
  IF p_sale_item IS NOT NULL AND NOT p_restore AND p_delta>0 THEN RAISE EXCEPTION 'Sale quantity cannot be negative.'; END IF;
  IF p_restore AND p_sale_item IS NOT NULL THEN
    FOR allocation IN SELECT a.* FROM stock_allocations a JOIN stock_batches s ON s.id=a.batch_id
      WHERE a.sale_item_id=p_sale_item AND s.outlet_id=p_outlet AND s.product_id=p_product ORDER BY s.id
    LOOP
      UPDATE stock_batches SET remaining=remaining+allocation.quantity WHERE id=allocation.batch_id;
      restored:=restored+allocation.quantity;
    END LOOP;
    DELETE FROM stock_allocations WHERE sale_item_id=p_sale_item;
    IF restored>0 THEN
      IF restored<>p_delta THEN RAISE EXCEPTION 'Sale stock allocation does not match the return quantity.'; END IF;
    ELSE
      -- Pre-migration sales have no allocations; restore at their last known active price.
      INSERT INTO stock_batches(outlet_id,product_id,quantity,remaining,purchase_price,selling_price)
      VALUES(p_outlet,p_product,p_delta,p_delta,b.purchase_price,b.selling_price);
    END IF;
  ELSIF p_delta>0 THEN
    INSERT INTO stock_batches(outlet_id,product_id,quantity,remaining,purchase_price,selling_price,purchase_item_id)
    VALUES(p_outlet,p_product,p_delta,GREATEST(0,p_delta+LEAST(0,b.on_hand)),COALESCE(p_purchase_price,b.purchase_price),
           COALESCE(p_selling_price,b.selling_price),p_purchase_item);
  ELSIF p_delta<0 THEN
    needed:=-p_delta;
    FOR batch IN SELECT * FROM stock_batches
      WHERE outlet_id=p_outlet AND product_id=p_product AND remaining>0 ORDER BY id FOR UPDATE
    LOOP
      taken:=LEAST(needed,batch.remaining);
      UPDATE stock_batches SET remaining=remaining-taken WHERE id=batch.id;
      cost:=cost+taken*batch.purchase_price;
      IF p_sale_item IS NOT NULL THEN
        INSERT INTO stock_allocations(sale_item_id,batch_id,quantity) VALUES(p_sale_item,batch.id,taken);
      END IF;
      needed:=needed-taken;
      EXIT WHEN needed=0;
    END LOOP;
    IF needed>0 THEN RAISE EXCEPTION 'Insufficient stock. Only % units are available.',GREATEST(0,b.on_hand); END IF;
    IF p_sale_item IS NOT NULL THEN UPDATE sale_items SET stock_cost=cost WHERE id=p_sale_item; END IF;
  END IF;
  UPDATE balances SET on_hand=on_hand+p_delta WHERE outlet_id=p_outlet AND product_id=p_product;
  PERFORM promote_stock_batch(p_outlet,p_product);
  RETURN cost;
END;
$$;

CREATE OR REPLACE FUNCTION set_active_stock_prices(p_product uuid,p_cp numeric,p_sp numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  FOR b IN SELECT * FROM balances WHERE product_id=p_product ORDER BY outlet_id FOR UPDATE LOOP
    UPDATE stock_batches SET purchase_price=COALESCE(p_cp,purchase_price),selling_price=COALESCE(p_sp,selling_price)
    WHERE id=(SELECT id FROM stock_batches WHERE outlet_id=b.outlet_id AND product_id=p_product AND remaining>0 ORDER BY id LIMIT 1);
    UPDATE balances SET purchase_price=COALESCE(p_cp,purchase_price),selling_price=COALESCE(p_sp,selling_price)
    WHERE outlet_id=b.outlet_id AND product_id=p_product;
    PERFORM promote_stock_batch(b.outlet_id,p_product);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION edit_active_stock_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('lube','fmcg') AND
    (NEW.purchase_price IS DISTINCT FROM OLD.purchase_price OR NEW.selling_price IS DISTINCT FROM OLD.selling_price) THEN
    PERFORM set_active_stock_prices(NEW.id,
      CASE WHEN NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN COALESCE(NEW.purchase_price,0) END,
      CASE WHEN NEW.selling_price IS DISTINCT FROM OLD.selling_price THEN COALESCE(NEW.selling_price,0) END);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS edit_active_stock_price ON products;
CREATE TRIGGER edit_active_stock_price AFTER UPDATE OF purchase_price,selling_price ON products
FOR EACH ROW EXECUTE FUNCTION edit_active_stock_price();

CREATE OR REPLACE FUNCTION restore_deleted_sale_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM stock_allocations WHERE sale_item_id=OLD.id) THEN
    SELECT outlet_id INTO o FROM sales WHERE id=OLD.sale_id;
    PERFORM move_shop_stock(o,OLD.product_id,OLD.qty,NULL,NULL,NULL,OLD.id,true);
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS restore_deleted_sale_stock ON sale_items;
CREATE TRIGGER restore_deleted_sale_stock BEFORE DELETE ON sale_items
FOR EACH ROW EXECUTE FUNCTION restore_deleted_sale_stock();

CREATE OR REPLACE FUNCTION update_purchase_stock_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch stock_batches%ROWTYPE; received numeric;
BEGIN
  SELECT * INTO batch FROM stock_batches WHERE purchase_item_id=OLD.id;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM 1 FROM balances WHERE outlet_id=batch.outlet_id AND product_id=batch.product_id FOR UPDATE;
  SELECT * INTO batch FROM stock_batches WHERE id=batch.id FOR UPDATE;
  IF TG_OP='UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id AND
     NEW.qty IS NOT DISTINCT FROM OLD.qty AND NEW.qty_received IS NOT DISTINCT FROM OLD.qty_received AND
     NEW.rate IS NOT DISTINCT FROM OLD.rate THEN RETURN NEW; END IF;
  IF batch.remaining<>batch.quantity OR EXISTS(SELECT 1 FROM stock_allocations WHERE batch_id=batch.id) THEN
    RAISE EXCEPTION 'This purchase stock has already been sold. Its quantity, product and CP cannot be changed or deleted.';
  END IF;
  IF TG_OP='DELETE' THEN
    DELETE FROM stock_batches WHERE id=batch.id;
    UPDATE balances SET on_hand=on_hand-batch.remaining WHERE outlet_id=batch.outlet_id AND product_id=batch.product_id;
    PERFORM promote_stock_batch(batch.outlet_id,batch.product_id);
    RETURN OLD;
  END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'The product on a stock batch cannot be changed. Delete the unused purchase and create a new one.';
  END IF;
  received:=COALESCE(NEW.qty_received,NEW.qty);
  IF received<0 THEN RAISE EXCEPTION 'Purchase quantity cannot be negative.'; END IF;
  UPDATE stock_batches SET quantity=received,remaining=received,purchase_price=NEW.rate WHERE id=batch.id;
  UPDATE balances SET on_hand=on_hand+received-batch.remaining WHERE outlet_id=batch.outlet_id AND product_id=batch.product_id;
  PERFORM promote_stock_batch(batch.outlet_id,batch.product_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS update_purchase_stock_batch ON purchase_items;
CREATE TRIGGER update_purchase_stock_batch BEFORE UPDATE OR DELETE ON purchase_items
FOR EACH ROW EXECUTE FUNCTION update_purchase_stock_batch();

CREATE OR REPLACE FUNCTION cancel_batch_sale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  IF (NEW.status='cancelled') IS DISTINCT FROM (OLD.status='cancelled') THEN
    FOR item IN SELECT l.* FROM sale_items l JOIN products p ON p.id=l.product_id
      WHERE l.sale_id=NEW.id AND p.kind IN ('lube','fmcg') AND l.stock_cost IS NOT NULL ORDER BY l.product_id,l.id
    LOOP
      PERFORM move_shop_stock(NEW.outlet_id,item.product_id,
        CASE WHEN NEW.status='cancelled' THEN item.qty ELSE -item.qty END,
        NULL,NULL,NULL,item.id,NEW.status='cancelled');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cancel_batch_sale ON sales;
CREATE TRIGGER cancel_batch_sale AFTER UPDATE OF status ON sales FOR EACH ROW EXECUTE FUNCTION cancel_batch_sale();
