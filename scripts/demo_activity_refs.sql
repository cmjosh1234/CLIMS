-- Reference data for scripts/demo_activity.py, as one JSON document: the products, the national
-- warehouses and their staff, and the district stores with their DCFPs, riders and the hotspots that
-- have an active manager account. Run with psql -At; see `make db-demo`.
WITH holders AS (
	SELECT DISTINCT u.id, u.store_id, u.hot_spot_id, p.name AS permission
	FROM users u
	JOIN role_user ru ON ru.user_id = u.id
	JOIN role_permission rp ON rp.role_id = ru.role_id
	JOIN permissions p ON p.id = rp.permission_id
	WHERE u.status = 'active'
		AND p.name IN ('orders:process', 'orders:replenish', 'orders:deliver', 'orders:stockout')),
-- A store already used by hand keeps its own history: the demo leaves district stores with real
-- orders or stock movements alone.
used AS (
	SELECT store_id FROM inventory_movements WHERE id::text NOT LIKE 'de300000-%'
	UNION SELECT ordered_for_store_id FROM orders WHERE id::text NOT LIKE 'de300000-%'
	UNION SELECT district_store_id FROM stockout_reports WHERE id::text NOT LIKE 'de300000-%')
SELECT json_build_object(
	'products', (SELECT coalesce(json_agg(json_build_object(
			'id', c.id, 'category', c.category, 'unit_id', c.unit_id, 'per_unit', c.pieces_per_unit,
			'label', concat_ws(' ', b.name, t.name), 'commercial', coalesce(t.name ILIKE 'commercial%', false))
			ORDER BY c.category, b.name), '[]')
		FROM condoms c
		LEFT JOIN brands b ON b.id = c.brand_id
		LEFT JOIN product_types t ON t.id = c.type_id
		WHERE c.active AND c.category IN ('male', 'female') AND c.unit_id IS NOT NULL
			AND c.pieces_per_unit IS NOT NULL),
	'warehouses', (SELECT coalesce(json_agg(json_build_object(
			'id', s.id, 'code', lower(s.code), 'name', s.name,
			'staff', (SELECT coalesce(json_agg(h.id ORDER BY h.id), '[]') FROM holders h
				WHERE h.store_id = s.id AND h.permission = 'orders:process')) ORDER BY s.code), '[]')
		FROM stores s WHERE s.store_type = 'national'),
	'districts', (SELECT coalesce(json_agg(json_build_object(
			'id', s.id, 'name', s.name, 'district_id', s.district_id,
			'active_hotspots', (SELECT count(*) FROM hot_spots h WHERE h.district_id = s.district_id
				AND h.status = 'active'),
			'dcfps', (SELECT json_agg(h.id ORDER BY h.id) FROM holders h
				WHERE h.store_id = s.id AND h.permission = 'orders:replenish'),
			'riders', (SELECT coalesce(json_agg(h.id ORDER BY h.id), '[]') FROM holders h
				WHERE h.store_id = s.id AND h.permission = 'orders:deliver'),
			'hotspots', (SELECT coalesce(json_agg(json_build_object('id', x.id, 'manager', x.manager)
					ORDER BY x.sort), '[]')
				FROM (SELECT DISTINCT ON (hs.id) hs.id, m.id AS manager, md5(hs.id::text) AS sort
					FROM hot_spots hs
					JOIN holders m ON m.hot_spot_id = hs.id AND m.permission = 'orders:stockout'
					WHERE hs.district_id = s.district_id AND hs.status = 'active'
						AND hs.review_status = 'active'
					ORDER BY hs.id, m.id) x)) ORDER BY s.name), '[]')
		FROM stores s
		WHERE s.store_type = 'district' AND s.id NOT IN (SELECT store_id FROM used WHERE store_id IS NOT NULL)
			AND EXISTS (SELECT 1 FROM holders h WHERE h.store_id = s.id AND h.permission = 'orders:replenish'))
);
