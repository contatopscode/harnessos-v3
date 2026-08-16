/**
 * Admin invite management for the web auth allowlist.
 *
 * Three admin endpoints (require an authenticated web user with role=admin):
 *   POST   /api/admin/invites              — issue a new invite, returns the link
 *   GET    /api/admin/invites              — list pending/accepted/revoked
 *   DELETE /api/admin/invites/:id          — revoke a pending invite
 *
 * Two PUBLIC endpoints (no auth — they are the invite acceptance flow):
 *   GET    /api/auth/invite/info?token=... — validate token, peek at email/role
 *   POST   /api/auth/invite/accept         — stamp accepted_at + return data
 *
 * The accepted_at column is stamped by the POST accept endpoint; the
 * Better Auth signup hook in ./auth/instance.ts consumes the same row
 * implicitly via isEmailOnAllowlist (any non-revoked, non-expired
 * row allows the email through).
 */
import { Hono } from 'hono';
import { randomBytes, createHash } from 'crypto';
import { getAuth } from '../auth/instance';
import { isWebAuthEnabled } from '../auth/config';
import { createLogger } from '@archon/paths';

const log = createLogger('admin-invites');

const DEFAULT_TTL_HOURS = 168; // 7 days
const MAX_TTL_HOURS = 720; // 30 days
const MIN_TOKEN_BYTES = 32;

function genToken(): string {
  // 32 bytes of randomness -> 64 hex chars. Same shape as Better Auth's
  // own verification tokens so the token is opaque-but-uniform.
  return randomBytes(MIN_TOKEN_BYTES).toString('hex');
}

function tokenHash(token: string): string {
  // Stored hash so a database dump doesn't leak usable invite links.
  return createHash('sha256').update(token).digest('hex');
}

interface InviteRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  token: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

function inviteToJson(row: InviteRow): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedByUserId: row.accepted_by_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

type ApiErrorStatus = 400 | 401 | 403 | 404 | 410 | 422 | 500 | 503;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

/**
 * Pull a typed pg.Pool out of a Better Auth instance, or null if it can't
 * be located (e.g. an older Better Auth version that wraps the pool).
 */
function authPool(): unknown {
  const auth = getAuth() as unknown as { options?: { database?: { pool?: unknown } } } | null;
  return auth?.options?.database?.pool;
}

/**
 * Require an authenticated web session whose canonical remote_agent_users
 * row has role='admin'. Returns either { userId } or an error response.
 */
async function requireWebAdmin(c: {
  req: { raw: { headers: Headers } };
  json: (data: unknown, status?: number) => Response;
}): Promise<{ userId: string } | { error: Response }> {
  const auth = getAuth();
  if (!auth) {
    return { error: apiError(c, 503, 'Web auth is not enabled on this install') };
  }
  let session: { user: { id: string; email?: string; name?: string | null } } | null = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    log.error({ err: err as Error }, 'admin.session_resolve_failed');
    return { error: apiError(c, 503, 'Could not verify session') };
  }
  if (!session?.user) {
    return { error: apiError(c, 401, 'Web authentication required') };
  }
  const pool = authPool() as {
    query: (sql: string, params: unknown[]) => Promise<{ rows: { role: string }[] }>;
  } | null;
  if (!pool) {
    return { error: apiError(c, 503, 'Auth pool unavailable') };
  }
  const result = await pool.query(
    `SELECT u.role
     FROM remote_agent_users u
     JOIN remote_agent_user_identities id
       ON id.user_id = u.id AND id.platform = 'web'
     WHERE id.platform_user_id = $1
     LIMIT 1`,
    [session.user.id]
  );
  const role = result.rows[0]?.role;
  if (role !== 'admin') {
    return { error: apiError(c, 403, 'Admin role required') };
  }
  return { userId: session.user.id };
}

// Typed wrapper around the Better Auth pool so the rest of the file can use
// `pool.query(sql, params)` without per-call `as` casts.
interface PgPool {
  query: (sql: string, params: unknown[]) => Promise<{ rows: InviteRow[]; rowCount: number }>;
}

function pool(): PgPool | null {
  return authPool() as PgPool | null;
}

const adminInvites = new Hono();

// ---- POST /api/admin/invites ----
adminInvites.post('/invites', async c => {
  const guard = await requireWebAdmin(c);
  if ('error' in guard) return guard.error;
  if (!isWebAuthEnabled()) {
    return apiError(c, 503, 'Web auth is not enabled');
  }
  const body = (await c.req.json().catch(() => null)) as {
    email?: string;
    role?: 'admin' | 'member';
    ttlHours?: number;
  } | null;
  const email = body?.email?.trim().toLowerCase();
  const role: 'admin' | 'member' = body?.role === 'admin' ? 'admin' : 'member';
  const ttlHours = Math.min(
    MAX_TTL_HOURS,
    Math.max(1, Math.floor(body?.ttlHours ?? DEFAULT_TTL_HOURS))
  );
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return apiError(c, 400, 'A valid email is required');
  }
  const db = pool();
  if (!db) return apiError(c, 503, 'Auth pool unavailable');
  // Idempotent: if there's already a live (non-revoked, non-expired)
  // invite for the same email, return that one.
  const existing = await db.query(
    `SELECT * FROM remote_agent_auth_invite
     WHERE email = $1
       AND revoked_at IS NULL
       AND (accepted_at IS NOT NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT 1`,
    [email]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return c.json({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      alreadyPending: true,
    });
  }
  const token = genToken();
  const tokenHashValue = tokenHash(token);
  const expires = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  const inserted = await db.query(
    `INSERT INTO remote_agent_auth_invite
       (email, role, token, expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [email, role, tokenHashValue, expires, guard.userId]
  );
  const row = inserted.rows[0];
  log.info({ email, role, inviteId: row.id, by: guard.userId }, 'admin.invite_created');
  return c.json({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    // Plaintext token, returned ONCE. The DB only stores the SHA-256 hash.
    inviteUrl: `/auth/invite?token=${token}`,
    token,
  });
});

// ---- GET /api/admin/invites ----
adminInvites.get('/invites', async c => {
  const guard = await requireWebAdmin(c);
  if ('error' in guard) return guard.error;
  if (!isWebAuthEnabled()) {
    return apiError(c, 503, 'Web auth is not enabled');
  }
  const db = pool();
  if (!db) return apiError(c, 503, 'Auth pool unavailable');
  const rows = await db.query(
    `SELECT * FROM remote_agent_auth_invite
     ORDER BY created_at DESC
     LIMIT $1`,
    [200]
  );
  return c.json({
    invites: rows.rows.map(r => inviteToJson(r)),
  });
});

// ---- DELETE /api/admin/invites/:id ----
adminInvites.delete('/invites/:id', async c => {
  const guard = await requireWebAdmin(c);
  if ('error' in guard) return guard.error;
  if (!isWebAuthEnabled()) {
    return apiError(c, 503, 'Web auth is not enabled');
  }
  const id = c.req.param('id');
  const db = pool();
  if (!db) return apiError(c, 503, 'Auth pool unavailable');
  const result = await db.query(
    `UPDATE remote_agent_auth_invite
     SET revoked_at = NOW()
     WHERE id = $1 AND revoked_at IS NULL AND accepted_at IS NULL
     RETURNING id`,
    [id]
  );
  if (result.rowCount === 0) {
    return apiError(c, 404, 'Invite not found or already accepted/revoked');
  }
  log.info({ inviteId: id, by: guard.userId }, 'admin.invite_revoked');
  return c.json({ ok: true });
});

const publicInvite = new Hono();

// ---- GET /api/auth/invite/info?token=... ----
// Public. Returns the email + role of a valid invite so the UI can
// pre-fill the signup form. 200 with details OR 404 with a reason.
publicInvite.get('/info', async c => {
  const token = c.req.query('token')?.trim();
  if (!token) return apiError(c, 400, 'token is required');
  if (!isWebAuthEnabled()) {
    return apiError(c, 503, 'Web auth is not enabled');
  }
  const db = pool();
  if (!db) return apiError(c, 503, 'Auth pool unavailable');
  const hash = tokenHash(token);
  const result = await db.query(
    `SELECT * FROM remote_agent_auth_invite
     WHERE token = $1
     LIMIT 1`,
    [hash]
  );
  const row = result.rows[0];
  if (!row) {
    return apiError(c, 404, 'Invite link is invalid');
  }
  if (row.revoked_at) {
    return apiError(c, 410, 'Invite link has been revoked');
  }
  if (row.accepted_at) {
    return apiError(c, 410, 'Invite link has already been used');
  }
  if (new Date(row.expires_at) < new Date()) {
    return apiError(c, 410, 'Invite link has expired');
  }
  return c.json({
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  });
});

// ---- POST /api/auth/invite/accept ----
// Public. Called by the UI right before the user submits the signup
// form. Stamps accepted_at so the same email can't accept twice and
// so the dynamic allowlist stays open for re-signup later.
publicInvite.post('/accept', async c => {
  const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
  const token = body?.token?.trim();
  if (!token) return apiError(c, 400, 'token is required');
  if (!isWebAuthEnabled()) {
    return apiError(c, 503, 'Web auth is not enabled');
  }
  const db = pool();
  if (!db) return apiError(c, 503, 'Auth pool unavailable');
  const hash = tokenHash(token);
  const result = await db.query(
    `UPDATE remote_agent_auth_invite
     SET accepted_at = NOW()
     WHERE token = $1
       AND revoked_at IS NULL
       AND accepted_at IS NULL
       AND expires_at > NOW()
     RETURNING *`,
    [hash]
  );
  const row = result.rows[0];
  if (!row) {
    return apiError(c, 410, 'Invite link is invalid, expired, or already used');
  }
  log.info({ email: row.email, inviteId: row.id }, 'invite.accepted');
  return c.json({
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  });
});

export { adminInvites, publicInvite };
