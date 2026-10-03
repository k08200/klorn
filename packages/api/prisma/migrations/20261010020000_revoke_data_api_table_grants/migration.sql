-- Take the Data API roles' table privileges away (2026-10-03). First of two
-- migrations: 20261010030000_enable_rls_remaining_tables is the second.
--
-- Found on production (Supabase), read-only, 2026-10-03: 19 tables in `public`
-- had no Row-Level Security, and the roles `anon` and `authenticated` held
-- SELECT, INSERT and DELETE on them. Supabase serves `public` over its REST API
-- as those two roles, so anyone holding the project's anon key could read or
-- change the tables. Nothing in this repository uses that API, so the two roles
-- need no privilege on any table here, including the ones that already had RLS.
--
-- Why this is a migration of its own, and the first: it takes no lock on any
-- user table, so a long reader or writer cannot make it time out. The second
-- one needs an ACCESS EXCLUSIVE lock on 19 tables and can lose that race, and
-- scripts/start.sh records a failed migration as applied when Prisma sees no
-- schema difference, which it never does for RLS or grants. In one file, a
-- single lock timeout would roll this revoke back too and leave every table
-- open behind a green deploy. Apart, the REST door is closed before the second
-- migration starts.
--
-- It is also what the policies cannot do alone. They trust a setting the
-- connection supplies, which is sound for the app's own connection and is not
-- meant to hold against a role an outsider can reach. And RLS never covers
-- TRUNCATE.
--
-- The second statement in the loop stops Supabase's default privileges from
-- granting the two roles again on every table a later migration creates. It
-- covers tables created by the role that runs this migration, which is the
-- role that runs every migration.
--
-- Table by table, and only the tables the migrating role owns, instead of
-- `REVOKE ... ON ALL TABLES IN SCHEMA public`: that statement is an error, not
-- a warning, when the schema holds one relation the role has no privilege on.
--
-- Skipped where the roles do not exist (CI, local Postgres). `service_role`,
-- `postgres` and `klorn_app` are not touched. Functions keep EXECUTE for both
-- roles: the only ones in `public` are pg_trgm's. Every statement can run twice.
-- Slotted after 20261010010000_attention_override_undo (main).
-- Fail fast instead of queueing behind a long lock (same guard as 20261007010000).
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  data_api_role text;
  owned_table regclass;
BEGIN
  FOREACH data_api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = data_api_role) THEN
      FOR owned_table IN
        SELECT c.oid::regclass
        FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND pg_get_userbyid(c.relowner) = current_user
      LOOP
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', owned_table, data_api_role);
      END LOOP;
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', data_api_role);
    END IF;
  END LOOP;
END $$;
