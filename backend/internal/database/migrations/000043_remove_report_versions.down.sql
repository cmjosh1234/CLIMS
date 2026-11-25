-- Restores migration 28's table and permission, empty: versions dropped going up are not recovered.
BEGIN;

-- Approved report versions (RF15, RN04): the figures and rows exactly as approved, with the filters
-- that produced them. A correction is a new version that supersedes one, with its reason; the earlier
-- version is kept unchanged, so it stays reproducible.
CREATE TABLE report_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report varchar(32) NOT NULL,
    filters jsonb NOT NULL,
    store_id uuid REFERENCES stores(id),
    summary jsonb,
    export jsonb NOT NULL,
    data_updated_at timestamptz NOT NULL,
    approved_by_id uuid NOT NULL REFERENCES users(id),
    note text CHECK (length(note) <= 1000),
    supersedes_id uuid UNIQUE REFERENCES report_versions(id),
    correction_reason text CHECK (length(correction_reason) <= 1000),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL OR correction_reason = '') )
);

CREATE INDEX report_versions_list_idx ON report_versions (store_id, report, created_at DESC);

INSERT INTO permissions (name, description) VALUES
    ('reports:approve', 'Save approved report versions and their corrections for the assigned store; with orders:all_stores, nationally');

INSERT INTO role_permission (role_id, permission_id)
SELECT roles.id, permissions.id FROM roles CROSS JOIN permissions
WHERE roles.name = 'admin' AND permissions.name = 'reports:approve';

COMMIT;
