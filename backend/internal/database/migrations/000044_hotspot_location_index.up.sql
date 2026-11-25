-- The hotspot list's near filter narrows candidates to a latitude and longitude box before measuring
-- distances; this index serves the box. Hotspots without coordinates never match it.
CREATE INDEX IF NOT EXISTS hot_spots_location_idx ON hot_spots (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
