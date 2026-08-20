/**
 * Better Auth instance (lazy singleton).
 *
 * `getAuth()` returns a configured Better Auth instance when web auth is enabled
 * (see ./config `isWebAuthEnabled`), otherwise `null`. The instance owns its own
 * small pg.Pool — Better Auth needs a raw `pg.Pool`, whereas core's `pool`
 * export is a thin query shim, not a real pool. Keeping a dedicated pool also
 * keeps the auth module self-contained.
 *
 * Better Auth owns four tables, renamed to the `remote_agent_auth_*` prefix via
 * `modelName` so they sit alongside Archon's other `remote_agent_*` tables. The
 * CANONICAL Archon user stays `remote_agent_users`; a Better Auth session is
 * mapped to it elsewhere via `findOrCreateUserByPlatformIdentity('web', …)`.
 *
 * Module-singleton pattern mirrors `registeredGitHubAppAuthProvider`.
 */
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { Pool } from 'pg';
import { createLogger } from '@archon/paths';
import { isWebAuthEnabled, getSignupMode } from './config';
import { isEmailOnAllowlist, makePgAllowlistQuery } from './allowlist';
import { recordLoginEvent } from '@archon/core/db/audit-log';
import { getPendingLoginRequestContext } from './login-context';

const log = createLogger('web-auth');

/** The configured Better Auth instance type (inferred — no hand-written shape). */
export type AuthInstance = ReturnType<typeof betterAuth>;

// `undefined` = not yet resolved; `null` = resolved-as-disabled. This lets a
// disabled install short-circuit without re-checking env on every request.
let cached: AuthInstance | null | undefined;

// The dedicated pg.Pool owned by the Better Auth instance, retained so
// closeAuth() can release it on shutdown. Null when web auth is disabled.
let authPool: Pool | null = null;

/**
 * Resolve the singleton Better Auth instance, or `null` when web auth is
 * disabled. Safe to call on every request — construction happens at most once.
 *
 * A construction failure (e.g. a malformed DATABASE_URL) is logged and cached as
 * `null` so it surfaces as a clear log line and a disabled auth surface, rather
 * than throwing into the request path where the soft seam would swallow it as a
 * generic "session resolve failed".
 */
export function getAuth(env: NodeJS.ProcessEnv = process.env): AuthInstance | null {
  if (cached !== undefined) return cached;
  if (!isWebAuthEnabled(env)) {
    cached = null;
    return cached;
  }
  try {
    cached = buildAuth(env);
    log.info('web_auth.instance_built');
  } catch (err) {
    log.error(
      { err: err as Error },
      'web_auth.instance_build_failed — web auth will be unavailable'
    );
    cached = null;
  }
  return cached;
}

function buildAuth(env: NodeJS.ProcessEnv): AuthInstance {
  // isWebAuthEnabled guarantees both are present; locals avoid `!` assertions.
  const connectionString = env.DATABASE_URL ?? '';
  const secret = env.BETTER_AUTH_SECRET ?? '';
  const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Safe default: with no allowlist and no explicit open-signup flag, signup is
  // OFF (login only) rather than silently open on a reachable URL. The env
  // allowlist is consulted dynamically by isEmailOnAllowlist (see ./allowlist).
  const signupDisabled = getSignupMode(env) === 'disabled';

  // Dedicated small pool; Better Auth requires a real pg.Pool. Retained at module
  // scope so closeAuth() can end it on shutdown.
  authPool = new Pool({ connectionString, max: 5 });

  return betterAuth({
    database: authPool,
    secret,
    // Omit baseURL for same-origin deploys — Better Auth infers it from the
    // request. Set BETTER_AUTH_URL only when behind a proxy with a fixed origin.
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    ...(trustedOrigins.length ? { trustedOrigins } : {}),
    // Cross-origin cookies for the FORGE webapp (forge.pscode.ia.br +
    // http://213.199.32.229:5180). Without SameSite=None + Secure, the
    // browser refuses to send the session cookie on cross-origin XHR.
    // Better Auth's default is Lax (samesite) which breaks our flow.
    // We only force this when the deployment exposes the API publicly
    // (any non-localhost trust origin in the list) — local single-origin
    // dev keeps the safer default.
    advanced: {
      ...(trustedOrigins.some(o => !o.startsWith('http://localhost'))
        ? {
            defaultCookieAttributes: {
              sameSite: 'none',
              secure: true,
            },
          }
        : {}),
    },
    // requireEmailVerification defaults false → simple flow, no email sender.
    // disableSignUp closes self-serve registration when the posture is
    // `disabled` (no allowlist + no ARCHON_AUTH_OPEN_SIGNUP=true). The allowlist
    // hook below is the belt-and-suspenders for `allowlist` mode.
    emailAndPassword: { enabled: true, disableSignUp: signupDisabled },
    user: { modelName: 'remote_agent_auth_user' },
    session: { modelName: 'remote_agent_auth_session' },
    account: { modelName: 'remote_agent_auth_account' },
    verification: { modelName: 'remote_agent_auth_verification' },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            // Defense in depth: `disableSignUp` (set above from getSignupMode)
            // already blocks registration in `disabled` mode before this hook
            // runs — re-check here so the hook stays correct on its own if that
            // upstream enforcement ever changes.
            if (signupDisabled) {
              throw new APIError('FORBIDDEN', { message: 'Signup is disabled.' });
            }
            // Invite gate (env allowlist OR durable invite in
            // remote_agent_auth_invite). isEmailOnAllowlist combines the two:
            // static env seed (admins pre-provisioned via Easypanel) and dynamic
            // invites issued via /api/admin/invites. Better Auth's pool is reused
            // for the lookup so we don't add another connection.
            if (!authPool) {
              throw new APIError('INTERNAL_SERVER_ERROR', {
                message: 'Auth pool not initialized',
              });
            }
            const onAllowlist = await isEmailOnAllowlist({
              email: user.email,
              env,
              queryDb: makePgAllowlistQuery(authPool),
            });
            if (!onAllowlist) {
              throw new APIError('FORBIDDEN', {
                message: 'This email is not on the invite allowlist.',
              });
            }
            return { data: user };
          },
        },
      },
      session: {
        // Audit trail: every successful login creates a session row, so
        // this hook fires exactly once per login. We use it to bump
        // `users.last_login_at / last_login_ip / login_count` and write a
        // `login.succeeded` row to the global audit log. Best-effort:
        // never throw out of the hook (it would break the login).
        create: {
          after: async (session: { userId: string; id: string }) => {
            try {
              // Look up the user's email from Better Auth's user table.
              // The auth pool is reused so we don't open another connection.
              if (!authPool) return;
              const userRes = await authPool.query<{ email: string }>(
                'SELECT email FROM remote_agent_auth_user WHERE id = $1',
                [session.userId]
              );
              const email = userRes.rows[0]?.email ?? 'unknown';
              // Resolve the CANONICAL Archon user_id from the Better Auth
              // user_id (mapped via remote_agent_user_identities). Falls
              // back to null when no mapping exists (a fresh signup that
              // hasn't linked yet — rare, but the audit row still records
              // the email).
              let canonicalUserId: string | null = null;
              try {
                const identRes = await authPool.query<{ user_id: string }>(
                  `SELECT user_id FROM remote_agent_user_identities
                   WHERE platform = 'web' AND platform_user_id = $1
                   LIMIT 1`,
                  [session.userId]
                );
                canonicalUserId = identRes.rows[0]?.user_id ?? null;
              } catch (lookupErr) {
                log.warn(
                  { err: (lookupErr as Error).message, sessionId: session.id },
                  'web_auth.identity_lookup_failed'
                );
              }
              // Read IP + User-Agent from the per-request carrier set by
              // the index.ts wrapper (Better Auth hooks don't get the
              // Hono request).
              const ctx = getPendingLoginRequestContext();
              await recordLoginEvent({
                userId: canonicalUserId,
                email,
                success: true,
                ip: ctx?.ip ?? null,
                userAgent: ctx?.userAgent ?? null,
                source: 'web',
              });
            } catch (err) {
              log.warn(
                { err: (err as Error).message, sessionId: session.id },
                'web_auth.session_create_audit_failed'
              );
            }
          },
        },
      },
    },
  });
}

/**
 * Release the Better Auth pg.Pool on graceful shutdown. No-op when web auth is
 * disabled (no pool was ever created).
 */
export async function closeAuth(): Promise<void> {
  if (authPool) {
    await authPool.end();
    authPool = null;
  }
}

/** Direct accessor for the Better Auth pg.Pool (or null when web auth is off).
 *  Sibling route files (./api.admin-invites) need a handle on the same pool
 *  Better Auth uses, so they query the same database as the auth instance.
 *  Returns null rather than throwing when auth is disabled — callers can
 *  decide whether to 503.
 */
export function getAuthPool(): Pool | null {
  return authPool;
}

/** Test-only: clear the cached instance so env changes take effect. */
export function resetAuthForTest(): void {
  cached = undefined;
  authPool = null;
}
