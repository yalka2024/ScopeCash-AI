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
-- FAIL CLOSED: a connection that never set `app.org_id` sees ZERO rows on any
-- RLS-protected table. The only escape is the explicit, narrow
-- `app.bypass_rls = 'on'` flag, set only by lib/prisma.js's
-- runWithSystemAccess() path (seed scripts, and a short, audited allowlist of
-- admin cross-tenant reporting routes) — never as a default. A request, job,
-- or code path that simply forgets to set tenant context now fails safe
-- (empty result) instead of silently returning every tenant's rows, which is
-- what the previous `OR current_setting(...) IS NULL` escape did.
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
    -- When app.bypass_rls = 'on'  -> explicit system access, all rows visible.
    -- Else when app.org_id is set -> rows restricted to that org.
    -- Else (nothing set)          -> zero rows. Fail closed, not open.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (current_setting(''app.bypass_rls'', true) = ''on'' '
      || '       OR "orgId" = current_setting(''app.org_id'', true)) '
      || 'WITH CHECK (current_setting(''app.bypass_rls'', true) = ''on'' '
      || '       OR "orgId" = current_setting(''app.org_id'', true))',
      t
    );
    RAISE NOTICE 'RLS enabled on %', t;
  END LOOP;
END $$;

