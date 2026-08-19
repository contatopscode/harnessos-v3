-- Migration 028: RBAC user bindings (user_roles, user_direct_permissions)
--
-- Why: a user has many roles; a role has many users. Plus a flat
-- per-user override for the rare case where the operator wants to
-- grant ONE specific permission to a single user without spinning up
-- a new role (e.g., a contractor needs git:revert but nothing else).
--
-- Two tables:
--   remote_agent_user_roles                — many-to-many: user ↔ role
--   remote_agent_user_direct_permissions   — per-user grant/revoke override
--
-- `user_roles.expires_at` supports temporary grants (e.g., a 30-day
-- admin boost for a teammate onboarding). NULL = permanent. The gate
-- helper filters expired rows at read time.
--
-- `user_direct_permissions.granted` is a real boolean (not just
-- presence) so the operator can REVOKE a single permission that
-- would otherwise be granted by one of the user's roles — without
-- removing the role. Rare, but the data model supports it.
--
-- Cascades: removing a user drops their bindings; removing a role
-- drops the user_roles row referencing it; removing a permission
-- drops the direct grant referencing it.

CREATE TABLE IF NOT EXISTS remote_agent_user_roles (
  user_id UUID NOT NULL
    REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL
    REFERENCES remote_agent_roles(id) ON DELETE CASCADE,
  granted_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user
  ON remote_agent_user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role
  ON remote_agent_user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_expires
  ON remote_agent_user_roles(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS remote_agent_user_direct_permissions (
  user_id UUID NOT NULL
    REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL
    REFERENCES remote_agent_permissions(id) ON DELETE CASCADE,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (user_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_direct_perms_user
  ON remote_agent_user_direct_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_direct_perms_permission
  ON remote_agent_user_direct_permissions(permission_id);
