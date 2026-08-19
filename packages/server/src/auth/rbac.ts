/**
 * RBAC gate helper — the central choke point for permission checks.
 *
 * `requireWebPermission(c, 'sandbox:create')` resolves the Better Auth
 * session → canonical user_id → evaluates the permission set via the
 * aggregated view (role inheritance + direct grant/deny override) →
 * returns either `{ userId }` for the caller to continue, or
 * `{ error: Response }` with a 401/403/503 status.
 *
 * Permission evaluation order:
 *   1. Any of the user's ROLES grants the permission?         → ALLOW
 *   2. user_direct_permissions has a row with granted=true?    → ALLOW
 *   3. user_direct_permissions has a row with granted=false?   → DENY
 *   4. No override → fall through to route's default policy
 */
import { getAuth, getAuthPool } from './instance';
import { isWebAuthEnabled } from './config';
import { createLogger } from '@archon/paths';
import { listUserPermissionSlugs } from '@archon/core/db/user-roles';

const log = createLogger('rbac.gate');

type ApiErrorStatus = 401 | 403 | 503;

interface GuardContext {
  req: { raw: { headers: Headers } };
  json: (data: unknown, status?: number) => Response;
}

interface SessionUser {
  id: string;
  email?: string;
  name?: string | null;
}

async function resolveCanonicalUserId(sessionUserId: string): Promise<string | null> {
  const pool = getAuthPool();
  if (!pool) return null;
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM remote_agent_user_identities
     WHERE platform = 'web' AND platform_user_id = $1
     LIMIT 1`,
    [sessionUserId]
  );
  return result.rows[0]?.user_id ?? null;
}

function gateError(c: GuardContext, status: ApiErrorStatus, message: string): { error: Response } {
  return { error: c.json({ error: message }, status) };
}

export type PermissionGuardResult =
  | { userId: string; permissionSlugs: readonly string[] }
  | { error: Response };

/**
 * Gate helper. Returns the canonical user id + the set of
 * permission slugs the user currently holds, OR a 401/403/503 error
 * response the caller should `return` directly.
 */
export async function requireWebPermission(
  c: GuardContext,
  permissionSlug: string
): Promise<PermissionGuardResult> {
  if (!isWebAuthEnabled()) {
    return gateError(c, 503, 'Web auth is not enabled on this install');
  }

  const auth = getAuth();
  if (!auth) {
    return gateError(c, 503, 'Auth subsystem not initialized');
  }

  let session: { user: SessionUser } | null = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    log.error({ err: err as Error }, 'rbac.session_resolve_failed');
    return gateError(c, 503, 'Could not verify session');
  }
  if (!session?.user) {
    return gateError(c, 401, 'Web authentication required');
  }

  const userId = await resolveCanonicalUserId(session.user.id);
  if (!userId) {
    log.warn(
      { sessionUserId: session.user.id, email: session.user.email },
      'rbac.session_without_canonical_user'
    );
    return gateError(c, 403, 'No canonical user record for this session');
  }

  let permissionSlugs: readonly string[];
  try {
    permissionSlugs = await listUserPermissionSlugs(userId);
  } catch (err) {
    log.error({ err: err as Error, userId, permissionSlug }, 'rbac.permission_lookup_failed');
    return gateError(c, 503, 'Permission lookup failed');
  }

  if (!permissionSlugs.includes(permissionSlug)) {
    log.info(
      { userId, permissionSlug, totalPerms: permissionSlugs.length },
      'rbac.permission_denied'
    );
    return gateError(c, 403, `Permission denied: ${permissionSlug}`);
  }

  log.debug(
    { userId, permissionSlug, totalPerms: permissionSlugs.length },
    'rbac.permission_granted'
  );
  return { userId, permissionSlugs };
}

/**
 * Resolve the current session's canonical user id without checking
 * a specific permission. Used by routes that need the userId for
 * stamping created_by_user_id but don't gate the route itself.
 */
export async function requireWebSession(
  c: GuardContext
): Promise<{ userId: string; email: string | null } | { error: Response }> {
  if (!isWebAuthEnabled()) {
    return gateError(c, 503, 'Web auth is not enabled on this install');
  }
  const auth = getAuth();
  if (!auth) {
    return gateError(c, 503, 'Auth subsystem not initialized');
  }
  let session: { user: SessionUser } | null = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    log.error({ err: err as Error }, 'rbac.session_resolve_failed');
    return gateError(c, 503, 'Could not verify session');
  }
  if (!session?.user) {
    return gateError(c, 401, 'Web authentication required');
  }
  const userId = await resolveCanonicalUserId(session.user.id);
  if (!userId) {
    return gateError(c, 403, 'No canonical user record for this session');
  }
  return { userId, email: session.user.email ?? null };
}
