/**
 * Database operations for the RBAC permissions catalog.
 *
 * The catalog is the closed list of privilege slugs the gate helper
 * (`requirePermission` in @archon/server) knows how to interpret.
 * New permissions are added to the seed (rbac-seed.ts); the admin
 * UI does not create new permissions — it just toggles which roles
 * hold each one.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';
import type { Permission } from '../schemas';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.permissions');
  return cachedLog;
}

function toPermission(row: Record<string, unknown>): Permission {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: nullableStr(row.description),
    category: nullableStr(row.category),
    created_at: toIso(row.created_at),
  };
}

/**
 * Coerce an unknown DB column to a string. The DB driver may return
 * strings, numbers, booleans, Dates, or null/undefined — anything
 * else is unexpected and falls back to ''. We never call String(value)
 * blindly because @typescript-eslint/no-base-to-string forbids
 * stringifying arbitrary objects (would yield "[object Object]").
 */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  return '';
}

function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

/**
 * Normalize a DB timestamp to an ISO string. Postgres returns
 * TIMESTAMPTZ as Date; SQLite stores text (already ISO).
 */
function toIso(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** List every permission, sorted by category then slug. */
export async function listPermissions(): Promise<readonly Permission[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_permissions ORDER BY category NULLS LAST, slug ASC'
  );
  return result.rows.map(toPermission);
}

/** List permissions grouped by category. Used by the admin UI's
 *  permission matrix (one column per category). */
export async function listPermissionsByCategory(): Promise<
  ReadonlyMap<string | null, readonly Permission[]>
> {
  const all = await listPermissions();
  const grouped = new Map<string | null, Permission[]>();
  for (const perm of all) {
    const key = perm.category;
    const list = grouped.get(key) ?? [];
    list.push(perm);
    grouped.set(key, list);
  }
  return grouped;
}

export async function getPermissionBySlug(slug: string): Promise<Permission | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_permissions WHERE slug = $1',
    [slug]
  );
  if (result.rows.length === 0) return null;
  return toPermission(result.rows[0]);
}

export async function getPermissionById(id: string): Promise<Permission | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_permissions WHERE id = $1',
    [id]
  );
  if (result.rows.length === 0) return null;
  return toPermission(result.rows[0]);
}

/**
 * Create a new permission. Slug must be unique; collision throws
 * (UNIQUE). Used by the seed only — the admin UI does not create
 * permissions.
 */
export async function createPermission(input: {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
}): Promise<Permission> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_permissions (slug, name, description, category)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.slug, input.name, input.description ?? null, input.category ?? null]
  );
  getLog().info({ permId: result.rows[0]?.id, slug: input.slug }, 'permission_created');
  return toPermission(result.rows[0]);
}

// ---------------------------------------------------------------------------
// Role ↔ Permission bridge
// ---------------------------------------------------------------------------

/**
 * List the slugs of every permission a role currently holds.
 * Used by the gate helper to short-circuit "is the user's role
 * set a superset of this permission?" without joining.
 */
export async function listRolePermissionSlugs(roleId: string): Promise<readonly string[]> {
  const result = await pool.query<{ slug: string }>(
    `SELECT p.slug FROM remote_agent_role_permissions rp
     JOIN remote_agent_permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1
     ORDER BY p.slug ASC`,
    [roleId]
  );
  return result.rows.map(r => r.slug);
}

/**
 * Assign a permission to a role. Idempotent — INSERT ... ON CONFLICT
 * DO NOTHING. Returns true if the binding was newly created, false
 * if it already existed.
 */
export async function assignPermissionToRole(
  roleId: string,
  permissionId: string
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO remote_agent_role_permissions (role_id, permission_id)
     VALUES ($1, $2)
     ON CONFLICT (role_id, permission_id) DO NOTHING`,
    [roleId, permissionId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Remove a permission from a role. Returns true if the binding was deleted. */
export async function removePermissionFromRole(
  roleId: string,
  permissionId: string
): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM remote_agent_role_permissions WHERE role_id = $1 AND permission_id = $2',
    [roleId, permissionId]
  );
  return (result.rowCount ?? 0) > 0;
}
