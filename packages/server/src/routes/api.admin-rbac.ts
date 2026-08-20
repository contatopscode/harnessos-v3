/**
 * Admin RBAC endpoints (Gestão de Usuários).
 *
 * Routes (all require admin:users OR admin:roles permission):
 *   GET    /api/admin/users                       — list users with role+permission slugs
 *   POST   /api/admin/users                       — create a user shell (no auth)
 *   GET    /api/admin/roles                       — list roles with permission slugs
 *   GET    /api/admin/permissions                 — list the closed permission catalog
 *   POST   /api/admin/roles                       — create a new role
 *   PATCH  /api/admin/roles/:id                   — update name/description
 *   DELETE /api/admin/roles/:id                   — delete (refuses is_system=true)
 *   POST   /api/admin/roles/:id/permissions       — assign permission to role
 *   DELETE /api/admin/roles/:id/permissions/:slug — unassign permission from role
 *   POST   /api/admin/users/:id/roles             — assign role to user
 *   DELETE /api/admin/users/:id/roles/:roleSlug   — unassign role from user
 *   POST   /api/admin/users/:id/permissions       — set direct permission override
 *   DELETE /api/admin/users/:id/permissions/:slug — clear direct permission override
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as rolesDb from '@archon/core/db/roles';
import * as permsDb from '@archon/core/db/permissions';
import * as userRoleDb from '@archon/core/db/user-roles';
import * as usersDb from '@archon/core/db/users';
import { recordAuditLog } from '@archon/core/db/audit-log';
import { createLogger } from '@archon/paths';
import { pool } from '@archon/core/db/connection';
import {
  createRoleBodySchema,
  createUserBodySchema,
  assignUserRoleBodySchema,
  assignPermissionBodySchema,
  type Role,
  type Permission,
  type UserWithPermissions,
  type RoleWithPermissions,
} from '@archon/core/schemas';

const log = createLogger('admin-rbac');

type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 503;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const rbac = new Hono();

// ---------------------------------------------------------------------------
// GET /api/admin/permissions
// ---------------------------------------------------------------------------
rbac.get('/permissions', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const grouped = await permsDb.listPermissionsByCategory();
  const out: Record<string, Permission[]> = {};
  for (const [k, v] of grouped) {
    out[k ?? '__uncategorized__'] = [...v];
  }
  return c.json({ permissions: out });
});

// ---------------------------------------------------------------------------
// GET /api/admin/roles
// ---------------------------------------------------------------------------
rbac.get('/roles', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const roles = await rolesDb.listRoles();
  const enriched: RoleWithPermissions[] = await Promise.all(
    roles.map(async (r: Role): Promise<RoleWithPermissions> => {
      const slugs = await permsDb.listRolePermissionSlugs(r.id);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        is_system: r.is_system,
        permission_slugs: [...slugs],
      };
    })
  );
  return c.json({ roles: enriched });
});

// ---------------------------------------------------------------------------
// POST /api/admin/roles
// ---------------------------------------------------------------------------
rbac.post('/roles', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = createRoleBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid role body', parsed.error.message);
  }
  try {
    const role = await rolesDb.createRole({
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      isSystem: false,
    });
    log.info({ roleId: role.id, slug: role.slug, by: guard.userId }, 'admin.role_created');
    await recordAuditLog({
      action: 'rbac.role.created',
      entityType: 'role',
      entityId: role.id,
      actorId: guard.userId,
      metadata: { slug: role.slug, name: role.name },
    });
    return c.json({ role }, 201);
  } catch (e) {
    const err = e as Error;
    if (err.message.includes('duplicate') || err.message.includes('UNIQUE')) {
      return apiError(c, 409, `A role with slug "${parsed.data.slug}" already exists`);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/roles/:id
// ---------------------------------------------------------------------------
rbac.patch('/roles/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    description?: string | null;
  } | null;
  if (!body || (body.name === undefined && body.description === undefined)) {
    return apiError(c, 400, 'Provide at least one of name or description');
  }
  const updated = await rolesDb.updateRole(id, {
    name: body.name,
    description: body.description,
  });
  if (!updated) return apiError(c, 404, 'Role not found');
  await recordAuditLog({
    action: 'rbac.role.updated',
    entityType: 'role',
    entityId: id,
    actorId: guard.userId,
    metadata: {
      changes: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
    },
  });
  return c.json({ role: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/roles/:id
// ---------------------------------------------------------------------------
rbac.delete('/roles/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  try {
    const ok = await rolesDb.deleteRole(id);
    if (!ok) return apiError(c, 404, 'Role not found');
    log.info({ roleId: id, by: guard.userId }, 'admin.role_deleted');
    await recordAuditLog({
      action: 'rbac.role.deleted',
      entityType: 'role',
      entityId: id,
      actorId: guard.userId,
    });
    return c.json({ ok: true });
  } catch (e) {
    const err = e as Error;
    if (err.message.includes('system role')) {
      return apiError(c, 409, err.message);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/roles/:id/permissions
// ---------------------------------------------------------------------------
rbac.post('/roles/:id/permissions', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const roleId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = assignPermissionBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid body', parsed.error.message);
  }
  const perm = await permsDb.getPermissionBySlug(parsed.data.permission_slug);
  if (!perm) {
    return apiError(c, 404, `Unknown permission: ${parsed.data.permission_slug}`);
  }
  const role = await rolesDb.getRoleById(roleId);
  if (!role) return apiError(c, 404, 'Role not found');
  const created = await permsDb.assignPermissionToRole(role.id, perm.id);
  log.info(
    {
      roleId: role.id,
      roleSlug: role.slug,
      permSlug: perm.slug,
      created,
      by: guard.userId,
    },
    'admin.role_permission_assigned'
  );
  await recordAuditLog({
    action: 'rbac.permission.granted',
    entityType: 'role',
    entityId: role.id,
    actorId: guard.userId,
    metadata: { role_slug: role.slug, permission_slug: perm.slug, created },
  });
  return c.json({ ok: true, created });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/roles/:id/permissions/:slug
// ---------------------------------------------------------------------------
rbac.delete('/roles/:id/permissions/:slug', async c => {
  const guard = await requireWebPermission(c, 'admin:roles');
  if ('error' in guard) return guard.error;
  const roleId = c.req.param('id');
  const permSlug = c.req.param('slug');
  const perm = await permsDb.getPermissionBySlug(permSlug);
  if (!perm) return apiError(c, 404, `Unknown permission: ${permSlug}`);
  const role = await rolesDb.getRoleById(roleId);
  if (!role) return apiError(c, 404, 'Role not found');
  const removed = await permsDb.removePermissionFromRole(role.id, perm.id);
  log.info(
    {
      roleId: role.id,
      roleSlug: role.slug,
      permSlug: perm.slug,
      removed,
      by: guard.userId,
    },
    'admin.role_permission_unassigned'
  );
  await recordAuditLog({
    action: 'rbac.permission.revoked',
    entityType: 'role',
    entityId: role.id,
    actorId: guard.userId,
    metadata: { role_slug: role.slug, permission_slug: perm.slug, removed },
  });
  return c.json({ ok: true, removed });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users — create a user shell (no auth account)
// ---------------------------------------------------------------------------
rbac.post('/users', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = createUserBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid body', parsed.error.message);
  }
  if (!parsed.data.display_name && !parsed.data.email) {
    return apiError(c, 400, 'Provide at least one of display_name or email');
  }
  const user = await usersDb.createUserShell({
    displayName: parsed.data.display_name ?? null,
    email: parsed.data.email ?? null,
  });
  log.info(
    {
      newUserId: user.id,
      email: user.email,
      displayName: user.display_name,
      by: guard.userId,
    },
    'admin.user_shell_created'
  );
  await recordAuditLog({
    action: 'rbac.user.role_assigned', // closest matching action for "user created"
    entityType: 'user',
    entityId: user.id,
    actorId: guard.userId,
    metadata: { event: 'user_shell_created', email: user.email, display_name: user.display_name },
  });
  return c.json({ user }, 201);
});

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------
rbac.get('/users', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    email: string | null;
    created_at: string | Date;
  }>(
    `SELECT id, display_name, email, created_at
     FROM remote_agent_users
     ORDER BY created_at ASC`
  );
  const users: UserWithPermissions[] = await Promise.all(
    result.rows.map(async row => {
      const [roleSlugs, permSlugs] = await Promise.all([
        userRoleDb.listUserRoleSlugs(row.id),
        userRoleDb.listUserPermissionSlugs(row.id),
      ]);
      const createdAt =
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : typeof row.created_at === 'string'
            ? row.created_at
            : '';
      return {
        id: row.id,
        display_name: row.display_name,
        email: row.email,
        role_slugs: [...roleSlugs],
        permission_slugs: [...permSlugs],
        created_at: createdAt,
      };
    })
  );
  return c.json({ users });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/roles
// ---------------------------------------------------------------------------
rbac.post('/users/:id/roles', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = assignUserRoleBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid body', parsed.error.message);
  }
  const expiresAt = parsed.data.expires_at ? new Date(parsed.data.expires_at) : null;
  const binding = await userRoleDb.assignRoleToUser(
    userId,
    parsed.data.role_slug,
    guard.userId,
    expiresAt
  );
  if (!binding) {
    return apiError(c, 404, `Unknown role: ${parsed.data.role_slug}`);
  }
  log.info(
    {
      userId,
      roleSlug: parsed.data.role_slug,
      by: guard.userId,
      expiresAt: parsed.data.expires_at ?? null,
    },
    'admin.user_role_assigned'
  );
  await recordAuditLog({
    action: 'rbac.user.role_assigned',
    entityType: 'user',
    entityId: userId,
    actorId: guard.userId,
    metadata: { role_slug: parsed.data.role_slug, expires_at: parsed.data.expires_at ?? null },
  });
  return c.json({ binding }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id/roles/:roleSlug
// ---------------------------------------------------------------------------
rbac.delete('/users/:id/roles/:roleSlug', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const userId = c.req.param('id');
  const roleSlug = c.req.param('roleSlug');
  const removed = await userRoleDb.removeRoleFromUser(userId, roleSlug);
  if (!removed) {
    return apiError(c, 404, `User does not hold role "${roleSlug}"`);
  }
  log.info({ userId, roleSlug, by: guard.userId }, 'admin.user_role_unassigned');
  await recordAuditLog({
    action: 'rbac.user.role_revoked',
    entityType: 'user',
    entityId: userId,
    actorId: guard.userId,
    metadata: { role_slug: roleSlug },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/permissions  (direct override)
// ---------------------------------------------------------------------------
rbac.post('/users/:id/permissions', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const userId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    permission_slug?: string;
    granted?: boolean;
    expires_at?: string;
  } | null;
  if (!body?.permission_slug || typeof body.granted !== 'boolean') {
    return apiError(c, 400, 'permission_slug and granted are required');
  }
  const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
  const row = await userRoleDb.setUserDirectPermission(
    userId,
    body.permission_slug,
    body.granted,
    guard.userId,
    expiresAt
  );
  if (!row) {
    return apiError(c, 404, `Unknown permission: ${body.permission_slug}`);
  }
  log.info(
    {
      userId,
      permSlug: body.permission_slug,
      granted: body.granted,
      by: guard.userId,
    },
    'admin.user_direct_permission_set'
  );
  await recordAuditLog({
    action: body.granted ? 'rbac.user.permission_granted' : 'rbac.user.permission_revoked',
    entityType: 'user',
    entityId: userId,
    actorId: guard.userId,
    metadata: { permission_slug: body.permission_slug, granted: body.granted },
  });
  return c.json({ override: row }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id/permissions/:slug
// ---------------------------------------------------------------------------
rbac.delete('/users/:id/permissions/:slug', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const userId = c.req.param('id');
  const permSlug = c.req.param('slug');
  const cleared = await userRoleDb.clearUserDirectPermission(userId, permSlug);
  if (!cleared) {
    return apiError(c, 404, 'No direct override for that permission');
  }
  log.info({ userId, permSlug, by: guard.userId }, 'admin.user_direct_permission_cleared');
  await recordAuditLog({
    action: 'rbac.user.permission_revoked',
    entityType: 'user',
    entityId: userId,
    actorId: guard.userId,
    metadata: { permission_slug: permSlug, cleared: true },
  });
  return c.json({ ok: true });
});

export default rbac;
