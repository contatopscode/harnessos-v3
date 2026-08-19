/**
 * RBAC admin skill — fetch wrappers for the 12 /api/admin/* endpoints
 * (PR5). Powers the Users / Roles / Permissions admin panels in the
 * Console spike.
 *
 * Wire shapes mirror the server's zod schemas in
 * packages/core/src/schemas/rbac.ts.
 */
import { requestJson } from '../lib/http';

// ---------------------------------------------------------------------------
// Types — mirror packages/core/src/schemas/rbac.ts
// ---------------------------------------------------------------------------

export interface Permission {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  created_at: string;
}

export interface Role {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleWithPermissions extends Role {
  permission_slugs: string[];
}

export interface UserRoleBinding {
  user_id: string;
  role_id: string;
  granted_by_user_id: string | null;
  granted_at: string;
  expires_at: string | null;
}

export interface UserWithPermissions {
  id: string;
  display_name: string | null;
  email: string | null;
  role_slugs: string[];
  permission_slugs: string[];
  created_at: string;
}

export interface UserDirectPermission {
  user_id: string;
  permission_id: string;
  granted: boolean;
  granted_by_user_id: string | null;
  granted_at: string;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** GET /api/admin/permissions — returns { permissions: { [category]: Permission[] } }. */
export function listPermissions(): Promise<{
  permissions: Record<string, Permission[]>;
}> {
  return requestJson('/api/admin/permissions');
}

/** GET /api/admin/roles — returns { roles: RoleWithPermissions[] }. */
export function listRoles(): Promise<{ roles: RoleWithPermissions[] }> {
  return requestJson('/api/admin/roles');
}

/** POST /api/admin/roles */
export function createRole(body: {
  slug: string;
  name: string;
  description?: string | null;
}): Promise<{ role: Role }> {
  return requestJson('/api/admin/roles', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** PATCH /api/admin/roles/:id */
export function updateRole(
  id: string,
  patch: { name?: string; description?: string | null }
): Promise<{ role: Role }> {
  return requestJson(`/api/admin/roles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** DELETE /api/admin/roles/:id */
export function deleteRole(id: string): Promise<{ ok: true }> {
  return requestJson(`/api/admin/roles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** POST /api/admin/roles/:id/permissions */
export function assignPermissionToRole(
  roleId: string,
  permissionSlug: string
): Promise<{ ok: true; created: boolean }> {
  return requestJson(`/api/admin/roles/${encodeURIComponent(roleId)}/permissions`, {
    method: 'POST',
    body: JSON.stringify({ permission_slug: permissionSlug }),
  });
}

/** DELETE /api/admin/roles/:id/permissions/:slug */
export function removePermissionFromRole(
  roleId: string,
  permissionSlug: string
): Promise<{ ok: true; removed: boolean }> {
  return requestJson(
    `/api/admin/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permissionSlug)}`,
    { method: 'DELETE' }
  );
}

/** GET /api/admin/users — returns { users: UserWithPermissions[] }. */
export function listUsers(): Promise<{ users: UserWithPermissions[] }> {
  return requestJson('/api/admin/users');
}

/** POST /api/admin/users/:id/roles */
export function assignRoleToUser(
  userId: string,
  roleSlug: string,
  expiresAt?: string
): Promise<{ binding: UserRoleBinding }> {
  return requestJson(`/api/admin/users/${encodeURIComponent(userId)}/roles`, {
    method: 'POST',
    body: JSON.stringify({
      role_slug: roleSlug,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    }),
  });
}

/** DELETE /api/admin/users/:id/roles/:roleSlug */
export function removeRoleFromUser(userId: string, roleSlug: string): Promise<{ ok: true }> {
  return requestJson(
    `/api/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleSlug)}`,
    { method: 'DELETE' }
  );
}

/** POST /api/admin/users/:id/permissions */
export function setUserDirectPermission(
  userId: string,
  permissionSlug: string,
  granted: boolean,
  expiresAt?: string
): Promise<{ override: UserDirectPermission }> {
  return requestJson(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: 'POST',
    body: JSON.stringify({
      permission_slug: permissionSlug,
      granted,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    }),
  });
}

/** DELETE /api/admin/users/:id/permissions/:slug */
export function clearUserDirectPermission(
  userId: string,
  permissionSlug: string
): Promise<{ ok: true }> {
  return requestJson(
    `/api/admin/users/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permissionSlug)}`,
    { method: 'DELETE' }
  );
}
