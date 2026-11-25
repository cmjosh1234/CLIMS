-- Removes the demo activity added by scripts/demo_activity.py (every row whose id starts with
-- de300000-), together with anything done since on those demo records (for example a demo order
-- reviewed or a demo stockout acknowledged through the app), then recomputes each touched store
-- balance from the ledger that remains. Run with `make db-demo-remove`.
--
-- Stock taken from a demo batch by a real transaction cannot be handed back to a real batch; any
-- balance whose batches no longer add up is listed at the end, to be corrected with a stock count.
BEGIN;

CREATE TEMP TABLE demo_orders ON COMMIT DROP AS
	SELECT id FROM orders WHERE id::text LIKE 'de300000-%';
CREATE TEMP TABLE demo_reports ON COMMIT DROP AS
	SELECT id FROM stockout_reports WHERE id::text LIKE 'de300000-%';
CREATE TEMP TABLE demo_deliveries ON COMMIT DROP AS
	SELECT id FROM hotspot_deliveries
	WHERE id::text LIKE 'de300000-%' OR stockout_report_id IN (SELECT id FROM demo_reports);
CREATE TEMP TABLE demo_lines ON COMMIT DROP AS
	SELECT id FROM hotspot_delivery_lines
	WHERE id::text LIKE 'de300000-%' OR delivery_id IN (SELECT id FROM demo_deliveries);
CREATE TEMP TABLE demo_batches ON COMMIT DROP AS
	SELECT id FROM stock_batches WHERE id::text LIKE 'de300000-%';
CREATE TEMP TABLE demo_movements ON COMMIT DROP AS
	SELECT id, store_id, condom_id, unit_of_measure_id FROM inventory_movements
	WHERE id::text LIKE 'de300000-%' OR order_id IN (SELECT id FROM demo_orders)
		OR hotspot_delivery_id IN (SELECT id FROM demo_deliveries)
		OR stock_batch_id IN (SELECT id FROM demo_batches);
CREATE TEMP TABLE touched ON COMMIT DROP AS
	SELECT DISTINCT store_id, condom_id, unit_of_measure_id FROM demo_movements
	UNION SELECT store_id, condom_id, unit_of_measure_id FROM stock_batches
		WHERE id IN (SELECT id FROM demo_batches)
	UNION SELECT store_id, condom_id, unit_of_measure_id FROM order_store_stock
		WHERE id::text LIKE 'de300000-%';

DELETE FROM expiry_exceptions WHERE id::text LIKE 'de300000-%'
	OR order_id IN (SELECT id FROM demo_orders) OR hotspot_delivery_id IN (SELECT id FROM demo_deliveries)
	OR stock_batch_id IN (SELECT id FROM demo_batches);
DELETE FROM shipment_batches WHERE id::text LIKE 'de300000-%'
	OR order_id IN (SELECT id FROM demo_orders) OR hotspot_delivery_line_id IN (SELECT id FROM demo_lines);
DELETE FROM inventory_movements WHERE id IN (SELECT id FROM demo_movements);
DELETE FROM hotspot_delivery_lines WHERE id IN (SELECT id FROM demo_lines);
DELETE FROM hotspot_deliveries WHERE id IN (SELECT id FROM demo_deliveries);
DELETE FROM stockout_report_events WHERE id::text LIKE 'de300000-%'
	OR report_id IN (SELECT id FROM demo_reports);
DELETE FROM stockout_reports WHERE id IN (SELECT id FROM demo_reports);
DELETE FROM order_events WHERE id::text LIKE 'de300000-%' OR order_id IN (SELECT id FROM demo_orders);
UPDATE orders SET parent_order_id = NULL WHERE parent_order_id IN (SELECT id FROM demo_orders);
DELETE FROM orders WHERE id IN (SELECT id FROM demo_orders);
DELETE FROM stock_batches WHERE id IN (SELECT id FROM demo_batches);
DELETE FROM mobile_sync_log WHERE id::text LIKE 'de300000-%';

-- Balances: what the remaining ledger holds, and what the remaining confirmed orders reserve.
UPDATE order_store_stock b SET
	on_hand = (SELECT coalesce(sum(m.quantity), 0) FROM inventory_movements m WHERE m.store_id = b.store_id
		AND m.condom_id = b.condom_id AND m.unit_of_measure_id = b.unit_of_measure_id),
	reserved = (SELECT coalesce(sum(coalesce(o.quantity_approved, o.quantity_needed)), 0) FROM orders o
		WHERE o.order_status = 'confirmed' AND o.ordered_from_store_id = b.store_id
			AND o.condom_id = b.condom_id AND o.unit_of_measure_id = b.unit_of_measure_id),
	updated_at = CURRENT_TIMESTAMP
WHERE (store_id, condom_id, unit_of_measure_id) IN (SELECT * FROM touched);

-- Rows the demo created and nothing else uses any more.
DELETE FROM order_store_stock b WHERE b.id::text LIKE 'de300000-%'
	AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.store_id = b.store_id
		AND m.condom_id = b.condom_id AND m.unit_of_measure_id = b.unit_of_measure_id)
	AND NOT EXISTS (SELECT 1 FROM stock_batches sb WHERE sb.store_id = b.store_id
		AND sb.condom_id = b.condom_id AND sb.unit_of_measure_id = b.unit_of_measure_id)
	AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.order_status = 'confirmed'
		AND o.ordered_from_store_id = b.store_id AND o.condom_id = b.condom_id
		AND o.unit_of_measure_id = b.unit_of_measure_id);

-- Each remaining movement's balance after it.
UPDATE inventory_movements m SET on_hand_after = x.running
FROM (SELECT id, sum(quantity) OVER (PARTITION BY store_id, condom_id, unit_of_measure_id
		ORDER BY created_at, id) AS running
	FROM inventory_movements
	WHERE (store_id, condom_id, unit_of_measure_id) IN (SELECT * FROM touched)) x
WHERE x.id = m.id AND m.on_hand_after <> x.running;

DO $$ DECLARE bad text; BEGIN
	SELECT string_agg(s.name, ', ') INTO bad
	FROM order_store_stock b JOIN stores s ON s.id = b.store_id
	WHERE (b.store_id, b.condom_id, b.unit_of_measure_id) IN (SELECT * FROM touched)
		AND b.on_hand <> (SELECT coalesce(sum(on_hand), 0) FROM stock_batches sb
			WHERE sb.store_id = b.store_id AND sb.condom_id = b.condom_id
				AND sb.unit_of_measure_id = b.unit_of_measure_id);
	IF bad IS NOT NULL THEN
		RAISE NOTICE 'batches no longer add up to the balance at: % (correct with a stock count)', bad;
	END IF;
END $$;
COMMIT;
