/**
 * Database operations for user ↔ role bindings + per-user direct
 * permission overrides.
 *
 * The gate helper evaluates RBAC in this order (see requirePermission
 * in @archon/server, PR 5):
 *   1. Any of the user's ROLES grants the permission? → ALLOW
 *   2. user_direct_permissions has a row with granted=true? → ALLOW
 *   3. user_direct_permissions has a row with granted=false? → DENY
 *   4. No override → fall through to route's default-deny/allow policy
 *
 * The "direct" overrides are the rare case: most permissions are
 * granted by roles, not by per-user grants. We only assign/revoke
 * direct overrides when the operator explicitly wants to break the
 * "all-or-nothing" semantics of a role for one user.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';
import type { UserDirectPermission, UserRoleBinding } from '../schemas';
import * as rolesDb from './roles';
import * as permsDb from './permissions';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.user-roles');
  return cachedLog;
}

function toUserRoleBinding(row: Record<string, unknown>): UserRoleBinding {
  return {
    user_id: strField(row.user_id),
    role_id: strField(row.role_id),
    granted_by_user_id: nullableStr(row.granted_by_user_id),
    granted_at: toIso(row.granted_at),
    expires_at: toIsoOrNull(row.expires_at),
  };
}

function toUserDirectPermission(row: Record<string, unknown>): UserDirectPermission {
  return {
    user_id: strField(row.user_id),
    permission_id: strField(row.permission_id),
    granted: Boolean(row.granted),
    granted_by_user_id: nullableStr(row.granted_by_user_id),
    granted_at: toIso(row.granted_at),
    expires_at: toIsoOrNull(row.expires_at),
  };
}

/** Coerce a known-non-null string-ish column. */
function strField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return '';
  // Last resort: numbers/booleans stringify cleanly. Anything else
  // is a programming error (a Date instance is handled above; an
  // object would round-trip as "[object Object]").
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  return '';
}

/** Coerce a nullable UUID/text column. */
function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  return null;
}

/**
 * Normalize a DB timestamp to an ISO string. Postgres returns
 * TIMESTAMPTZ as Date; SQLite returns text (already ISO). The
 * RBAC schema is `z.string()` for granted_at / expires_at —
 * we never want `[object Object]` slipping into the API payload.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Null-safe ISO coercion (null stays null). */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

// ---------------------------------------------------------------------------
// User ↔ Role
// ---------------------------------------------------------------------------

/** Every active (non-expired) role binding for a user. */
export async function listUserRoles(userId: string): Promise<readonly UserRoleBinding[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_user_roles
     WHERE user_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY granted_at ASC`,
    [userId]
  );
  return result.rows.map(toUserRoleBinding);
}

/** Every user that currently holds a given role (active only). */
export async function listRoleUsers(roleId: string): Promise<readonly string[]> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM remote_agent_user_roles
     WHERE role_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [roleId]
  );
  return result.rows.map(r => r.user_id);
}

/**
 * Assign a role to a user by slug. Idempotent. Resolves role + user
 * (caller is expected to validate user exists; role not found
 * returns null).
 */
export async function assignRoleToUser(
  userId: string,
  roleSlug: string,
  grantedByUserId?: string | null,
  expiresAt?: Date | null
): Promise<UserRoleBinding | null> {
  const role = await rolesDb.getRoleBySlug(roleSlug);
  if (role === null) return null;
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_user_roles (user_id, role_id, granted_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, role_id) DO UPDATE SET
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [userId, role.id, grantedByUserId ?? null, expiresAt ?? null]
  );
  getLog().info({ userId, roleSlug, grantedByUserId, expiresAt }, 'user_role_assigned');
  return toUserRoleBinding(result.rows[0]);
}

/** Remove a role from a user. */
export async function removeRoleFromUser(userId: string, roleSlug: string): Promise<boolean> {
  const role = await rolesDb.getRoleBySlug(roleSlug);
  if (role === null) return false;
  const result = await pool.query(
    'DELETE FROM remote_agent_user_roles WHERE user_id = $1 AND role_id = $2',
    [userId, role.id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Direct permission override
// ---------------------------------------------------------------------------

export async function listUserDirectPermissions(
  userId: string
): Promise<readonly UserDirectPermission[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_user_direct_permissions
     WHERE user_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY granted_at ASC`,
    [userId]
  );
  return result.rows.map(toUserDirectPermission);
}

/** Set the per-user direct permission override (granted=true|false). */
export async function setUserDirectPermission(
  userId: string,
  permissionSlug: string,
  granted: boolean,
  grantedByUserId?: string | null,
  expiresAt?: Date | null
): Promise<UserDirectPermission | null> {
  const perm = await permsDb.getPermissionBySlug(permissionSlug);
  if (perm === null) return null;
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_user_direct_permissions
       (user_id, permission_id, granted, granted_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, permission_id) DO UPDATE SET
       granted = EXCLUDED.granted,
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       expires_at = EXCLUDED.expires_at,
       granted_at = NOW()
     RETURNING *`,
    [userId, perm.id, granted, grantedByUserId ?? null, expiresAt ?? null]
  );
  getLog().info({ userId, permissionSlug, granted, grantedByUserId }, 'user_direct_permission_set');
  return toUserDirectPermission(result.rows[0]);
}

/** Remove a direct permission override. Returns true if a row was deleted. */
export async function clearUserDirectPermission(
  userId: string,
  permissionSlug: string
): Promise<boolean> {
  const perm = await permsDb.getPermissionBySlug(permissionSlug);
  if (perm === null) return false;
  const result = await pool.query(
    'DELETE FROM remote_agent_user_direct_permissions WHERE user_id = $1 AND permission_id = $2',
    [userId, perm.id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Aggregated views (used by the admin UI)
// ---------------------------------------------------------------------------

/**
 * List the slugs of every role currently held by a user. Expired
 * bindings are filtered.
 */
export async function listUserRoleSlugs(userId: string): Promise<readonly string[]> {
  const result = await pool.query<{ slug: string }>(
    `SELECT r.slug FROM remote_agent_user_roles ur
     JOIN remote_agent_roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
     ORDER BY r.slug ASC`,
    [userId]
  );
  return result.rows.map(r => r.slug);
}

/**
 * List the slugs of every permission a user currently holds — direct
 * (via role inheritance) or override. Excludes expired rows.
 */
export async function listUserPermissionSlugs(userId: string): Promise<readonly string[]> {
  const result = await pool.query<{ slug: string }>(
    `SELECT DISTINCT p.slug
     FROM remote_agent_permissions p
     WHERE p.id IN (
       -- Permissions from active roles
       SELECT rp.permission_id
       FROM remote_agent_role_permissions rp
       JOIN remote_agent_user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
       UNION
       -- Permissions from direct grants (granted=true only)
       SELECT permission_id
       FROM remote_agent_user_direct_permissions
       WHERE user_id = $1
         AND granted = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
     )
     ORDER BY p.slug ASC`,
    [userId]
  );
  return result.rows.map(r => r.slug);
}
