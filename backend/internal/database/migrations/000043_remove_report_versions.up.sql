-- Reports are not approved (decided 2026-11-25): every report is a live calculation from the source
-- records, downloaded as it stands. The approved versions of migration 28 and the permission to
-- approve them go; any versions saved are dropped with them.
BEGIN;

DELETE FROM permissions WHERE name = 'reports:approve';
DROP TABLE report_versions;

COMMIT;
