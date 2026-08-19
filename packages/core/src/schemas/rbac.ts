/**
 * Zod schemas for the RBAC data model.
 *
 * The runtime DB rows are plain JS objects (timestamps parsed to
 * Date on read); the Zod layer is the single source of truth for
 * the API surface and the openapi-generated `api.generated.d.ts`
 * the frontend consumes.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * A role bundles a set of permissions. Roles are referenced by `slug`
 * (stable string identifier like 'admin', 'sandbox-user') so the
 * backfill in migration 029 can wire `users.role` to the matching
 * seeded role without knowing its UUID.
 *
 * `is_system=true` is a UI hint, not a DB constraint: the operator
 * cannot delete system roles from the admin UI, but the DB accepts
 * any insert. Operators with raw SQL access can do what they want
 * — that's the operator tier, not a security boundary.
 */
export const roleRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_system: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Role = z.infer<typeof roleRowSchema>;

/** POST /api/admin/roles body — creates a new role. */
export const createRoleBodySchema = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, 'slug must be lowercase alphanum / dash / underscore'),
    name: z.string().min(1).max(128),
    description: z.string().max(2000).optional(),
  })
  .openapi('CreateRoleBody');

/** POST /api/admin/roles/{id}/permissions — assigns a permission to a role. */
export const assignPermissionBodySchema = z
  .object({
    permission_slug: z.string().min(1),
  })
  .openapi('AssignPermissionBody');

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/**
 * A single privilege. Slugs are colon-namespaced so the gate helper
 * (`requirePermission`) can group them by category for the UI:
 *   - 'sandbox:create', 'sandbox:merge', 'sandbox:discard'
 *   - 'git:revert',     'git:publish'
 *   - 'admin:users',    'admin:roles', 'admin:invites'
 *   - 'memory:read',    'memory:write'
 *   - 'chat:send'
 *   - 'workflow:run'
 *   - 'codebases:read', 'codebases:write'
 *
 * `category` is a human label for grouping; it is NOT used by the
 * gate helper (the gate looks up the exact slug). It exists so the
 * admin UI can render a permission matrix grouped by category.
 */
export const permissionRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  created_at: z.string(),
});

export type Permission = z.infer<typeof permissionRowSchema>;

// ---------------------------------------------------------------------------
// User ↔ Role binding
// ---------------------------------------------------------------------------

/**
 * A user can hold many roles. `expires_at` supports temporary grants
 * (e.g., 30-day admin boost for a teammate onboarding). NULL =
 * permanent. The gate helper filters expired rows at read time.
 */
export const userRoleRowSchema = z.object({
  user_id: z.string(),
  role_id: z.string(),
  granted_by_user_id: z.string().nullable(),
  granted_at: z.string(),
  expires_at: z.string().nullable(),
});

export type UserRoleBinding = z.infer<typeof userRoleRowSchema>;

/** POST /api/admin/users/{id}/roles — assigns a role to a user. */
export const assignUserRoleBodySchema = z
  .object({
    role_slug: z.string().min(1),
    expires_at: z.string().datetime().optional(),
  })
  .openapi('AssignUserRoleBody');

/** POST /api/admin/users — creates a user shell (display_name + email, no auth). */
export const createUserBodySchema = z
  .object({
    display_name: z.string().min(1).max(255).optional(),
    email: z
      .string()
      .email()
      .max(255)
      .optional()
      .transform(v => (v ? v.trim().toLowerCase() : v)),
  })
  .openapi('CreateUserBody');

// ---------------------------------------------------------------------------
// User direct permission (override)
// ---------------------------------------------------------------------------

/**
 * A per-user grant/revoke override. `granted=true` is a positive
 * grant; `granted=false` is a revoke that overrides any role that
 * would otherwise grant this permission. The gate helper evaluates:
 *   - If any of the user's ROLES grants the permission → ALLOW
 *   - Else if user_direct_permissions has a row with granted=true → ALLOW
 *   - Else if user_direct_permissions has a row with granted=false → DENY
 *   - Else (no row at all) → no override, fall through to default-deny or
 *     default-allow per the route's policy
 */
export const userDirectPermissionRowSchema = z.object({
  user_id: z.string(),
  permission_id: z.string(),
  granted: z.boolean(),
  granted_by_user_id: z.string().nullable(),
  granted_at: z.string(),
  expires_at: z.string().nullable(),
});

export type UserDirectPermission = z.infer<typeof userDirectPermissionRowSchema>;

// ---------------------------------------------------------------------------
// Aggregated views (for the admin UI)
// ---------------------------------------------------------------------------

/**
 * A user with the role slugs and permission slugs they currently
 * hold. Computed by joining user_roles + role_permissions +
 * user_direct_permissions. Returned by GET /api/admin/users.
 */
export const userWithPermissionsSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  role_slugs: z.array(z.string()),
  permission_slugs: z.array(z.string()),
  created_at: z.string(),
});

export type UserWithPermissions = z.infer<typeof userWithPermissionsSchema>;

/**
 * A role with the permission slugs it currently grants. Returned by
 * GET /api/admin/roles.
 */
export const roleWithPermissionsSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_system: z.boolean(),
  permission_slugs: z.array(z.string()),
});

export type RoleWithPermissions = z.infer<typeof roleWithPermissionsSchema>;
