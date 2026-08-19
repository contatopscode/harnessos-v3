-- Migration 029: RBAC backfill — migrate legacy `users.role` into the
-- new m:n table, then drop the legacy column.
--
-- Why: the legacy column held one of two flat values ('admin',
-- 'member'). Each existing user gets exactly one user_roles row
-- pointing at the matching seeded role. The two seed roles (admin,
-- member) are referenced by slug so the backfill does not need their
-- UUIDs — but only if they were already seeded. The seed runs on
-- startup in @archon/core/db/rbac-seed, so by the time a backfill
-- executes on an existing install, the admin/member roles exist.
--
-- Idempotent:
--   - INSERT ... ON CONFLICT DO NOTHING prevents double-insert
--   - The legacy column DROP is wrapped in a DO block that checks
--     the column exists; safe to re-run on a fresh install where
--     the column was never created.
--
-- Net effect: after this migration runs once, `users.role` no longer
-- exists, and every former 'admin' user has a user_roles row pointing
-- at the seeded 'admin' role (with all its permissions, seeded in
-- 027 via rbac-seed). Same for 'member'.

-- Backfill: convert each existing users.role value into a user_roles row
-- pointing at the matching seeded role. ON CONFLICT keeps the backfill
-- safe across re-runs (e.g., when the legacy column was already dropped
-- and a stale copy of this migration replays).
INSERT INTO remote_agent_user_roles (user_id, role_id, granted_at)
SELECT
  u.id,
  r.id,
  NOW()
FROM remote_agent_users u
JOIN remote_agent_roles r ON r.slug = u.role
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Drop the legacy column. Wrapped in DO so re-running this migration
-- on a fresh install (where the column never existed) is a no-op
-- rather than a hard error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'remote_agent_users'
      AND column_name = 'role'
  ) THEN
    ALTER TABLE remote_agent_users DROP COLUMN role;
  END IF;
END
$$;
