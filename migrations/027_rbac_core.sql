-- Migration 027: RBAC core (roles, permissions, role_permissions)
--
-- Why: the legacy `users.role` column was a flat enum ('admin' | 'member')
-- that could not capture the operator's intent: a user might need sandbox
-- access without admin powers, or read-only on codebases with no chat
-- privilege. RBAC makes that explicit and adjustable from the admin UI
-- without schema migrations.
--
-- Three tables:
--   remote_agent_roles              — named bundles of permissions
--   remote_agent_permissions        — the catalog of all privileges
--   remote_agent_role_permissions   — many-to-many bridge
--
-- `roles.slug` is the stable identifier (e.g., 'admin', 'member',
-- 'sandbox-user'). Slugs are unique. `is_system=true` flags roles that
-- the operator cannot delete (default roles seeded on startup). The
-- admin UI (PR 6) enforces this; the DB accepts any insert.
--
-- `permissions.slug` is the stable identifier (e.g., 'sandbox:create',
-- 'git:revert'). Codes are colon-namespaced so the gate helper
-- (requirePermission) can group them by category for the UI.
--
-- All FKs cascade on delete so removing a role or permission also
-- removes its bindings (and removing a user drops their user_roles
-- rows in migration 028). Idempotent CREATE IF NOT EXISTS so the
-- bundled-schema apply converges across restarts.

CREATE TABLE IF NOT EXISTS remote_agent_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_agent_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(96) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  category VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permissions_category
  ON remote_agent_permissions(category);

CREATE TABLE IF NOT EXISTS remote_agent_role_permissions (
  role_id UUID NOT NULL
    REFERENCES remote_agent_roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL
    REFERENCES remote_agent_permissions(id) ON DELETE CASCADE,
  granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role
  ON remote_agent_role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission
  ON remote_agent_role_permissions(permission_id);
