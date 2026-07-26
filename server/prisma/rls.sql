-- ============================================================================
-- Row-Level Security (RLS) for tenant isolation — ScopeCash AI
-- ----------------------------------------------------------------------------
-- Postgres only. Enables RLS on every table that has an "orgId" column and
-- restricts rows to the org set via `SET app.org_id` (done per request by
-- lib/prisma.js). This is a HARD database-level backstop under the app-level
-- `where: { orgId }` scoping — even a route that forgets to filter cannot leak
-- another tenant's rows.
--
-- Idempotent: safe to run repeatedly (DROP POLICY IF EXISTS + per-column check).
-- The "User" table is intentionally excluded — authentication happens before an
-- org context exists, so it stays app-level scoped.
--
-- Apply with:  npm run db:postgres:rls   (or psql "$DATABASE_URL" -f prisma/rls.sql)
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'orgId'
      AND tb.table_type = 'BASE TABLE'
      AND c.table_name <> 'User'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the table OWNER (the app role) is also subject to the policy;
    -- without it, an owner connection silently bypasses RLS.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- When app.org_id is set  -> rows are restricted to that org.
    -- When it is NOT set (NULL) -> no restriction, so system jobs / seeds / the
    -- migration itself keep working. Tenant requests always set it (lib/prisma.js).
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING ("orgId" = current_setting(''app.org_id'', true) '
      || '       OR current_setting(''app.org_id'', true) IS NULL) '
      || 'WITH CHECK ("orgId" = current_setting(''app.org_id'', true) '
      || '       OR current_setting(''app.org_id'', true) IS NULL)',
      t
    );
    RAISE NOTICE 'RLS enabled on %', t;
  END LOOP;
END $$;

