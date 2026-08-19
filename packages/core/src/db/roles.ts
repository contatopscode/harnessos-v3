/**
 * Database operations for the RBAC roles table.
 *
 * Roles are referenced by stable `slug` strings (e.g. 'admin',
 * 'sandbox-user') so the backfill in migration 029 can wire legacy
 * `users.role` values to the matching seeded role without knowing
 * its UUID. The `is_system` flag is a UI hint — the DB accepts
 * any insert/delete; the admin UI (PR 6) refuses to mutate
 * system roles.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';
import type { Role } from '../schemas';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.roles');
  return cachedLog;
}

/** Map a raw DB row to the Role shape with `is_system` as a real boolean. */
function toRole(row: Record<string, unknown>): Role {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: nullableStr(row.description),
    is_system: Boolean(row.is_system),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/**
 * Coerce an unknown DB column to a string. Mirrors the helper in
 * permissions.ts — typeof guards + Date.toISOString, fallback ''.
 * Never calls String(value) directly: @typescript-eslint/no-base-to-string
 * forbids stringifying arbitrary objects (would yield "[object Object]").
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

function toIso(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** List every role, newest first. Used by the admin UI's roles page. */
export async function listRoles(): Promise<readonly Role[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_roles ORDER BY is_system DESC, slug ASC'
  );
  return result.rows.map(toRole);
}

/** Get a role by id. Returns null when not found. */
export async function getRoleById(id: string): Promise<Role | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_roles WHERE id = $1',
    [id]
  );
  if (result.rows.length === 0) return null;
  return toRole(result.rows[0]);
}

/** Get a role by slug. Returns null when not found. */
export async function getRoleBySlug(slug: string): Promise<Role | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_roles WHERE slug = $1',
    [slug]
  );
  if (result.rows.length === 0) return null;
  return toRole(result.rows[0]);
}

/**
 * Create a new role. `is_system` defaults to false; system roles are
 * seeded on startup (rbac-seed.ts) and cannot be created from the API.
 *
 * Returns the new role. Throws on slug collision (UNIQUE).
 */
export async function createRole(input: {
  slug: string;
  name: string;
  description?: string | null;
  isSystem?: boolean;
}): Promise<Role> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_roles (slug, name, description, is_system)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.slug, input.name, input.description ?? null, input.isSystem ?? false]
  );
  getLog().info({ roleId: result.rows[0]?.id, slug: input.slug }, 'role_created');
  return toRole(result.rows[0]);
}

/**
 * Update a role's name and description. Slug is immutable (the stable
 * identifier — re-slugging would break every binding FK and every
 * API contract that references the role by slug).
 */
export async function updateRole(
  id: string,
  patch: { name?: string; description?: string | null }
): Promise<Role | null> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    fields.push(`name = $${String(i++)}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${String(i++)}`);
    values.push(patch.description);
  }
  if (fields.length === 0) return getRoleById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE remote_agent_roles SET ${fields.join(', ')} WHERE id = $${String(i)} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return null;
  return toRole(result.rows[0]);
}

/**
 * Delete a role by id. Cascades to role_permissions + user_roles.
 * Throws when the role is system (is_system=true): the caller is
 * expected to check that flag before calling delete. We throw
 * instead of silently no-op'ing so the operator sees a clear error.
 */
export async function deleteRole(id: string): Promise<boolean> {
  const current = await getRoleById(id);
  if (current === null) return false;
  if (current.is_system) {
    throw new Error(
      `Refusing to delete system role '${current.slug}' — system roles are immutable.`
    );
  }
  const result = await pool.query('DELETE FROM remote_agent_roles WHERE id = $1', [id]);
  getLog().info({ roleId: id, slug: current.slug }, 'role_deleted');
  return (result.rowCount ?? 0) > 0;
}
