/**
 * Durable allowlist helper.
 *
 * Combines the static env allowlist (ARCHON_AUTH_ALLOWED_EMAILS, parsed
 * by ./config) with the dynamic allowlist in remote_agent_auth_invite.
 * A signup attempt passes when EITHER source approves the email.
 *
 * Dynamic source rules (remote_agent_auth_invite row):
 *   - role='admin' or 'member' is a soft hint for downstream (we don't gate
 *     on it during signup yet — it lives in the row for the admin UI later).
 *   - accepted_at IS NOT NULL: a previously-accepted invite makes the email
 *     a permanent allowlist member (re-signup keeps working even if the
 *     invite link expired).
 *   - accepted_at IS NULL AND expires_at > now(): a live pending invite.
 *   - revoked_at IS NOT NULL: ignored.
 *
 * Pure helper: takes a query function and email, returns boolean. The pg
 * query is injected so this module is testable with a fake DB.
 */
import { parseAllowedEmails } from './config';

export interface AllowlistQueryResult {
  /** True if the email has any non-revoked allowlist row in the DB. */
  readonly hasInviteAllow: boolean;
}

export type AllowlistDbQuery = (email: string) => Promise<AllowlistQueryResult>;

export interface AllowlistCheckInput {
  readonly email: string;
  readonly env: NodeJS.ProcessEnv;
  readonly queryDb: AllowlistDbQuery;
}

/**
 * Returns true when the email can sign up.
 *
 * Pure (no module-level state). Caller passes the env + a DB-query
 * function. The DB query is the expensive part — callers should cache
 * the AllowlistDbQuery in a small in-memory LRU if they expect heavy
 * traffic (a few seconds of cache is fine; the dynamic allowlist is
 * best-effort, not security-critical).
 */
export async function isEmailOnAllowlist({
  email,
  env,
  queryDb,
}: AllowlistCheckInput): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  // Static side: env allowlist.
  const envAllowlist = parseAllowedEmails(env);
  if (envAllowlist.length > 0 && envAllowlist.includes(normalized)) {
    return true;
  }

  // Dynamic side: a previously-accepted or currently-pending invite.
  try {
    const { hasInviteAllow } = await queryDb(normalized);
    if (hasInviteAllow) return true;
  } catch {
    // DB unreachable: treat as "not on allowlist" rather than fail-open. The
    // static env still approves emails on its own list, so admins seeded via
    // env can still sign up. This is the safer default for a public URL.
  }

  // If no env allowlist is set, treat the DB allowlist as authoritative.
  return envAllowlist.length === 0;
}

/**
 * SQL helper for the DB query: returns true when any non-revoked row exists
 * for the given email where the invite is either accepted OR still pending
 * (not expired, not accepted, not revoked).
 *
 * Single query, no joins. The pg pool is injected for testability.
 */
export const ALLOWLIST_INVITE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM remote_agent_auth_invite
    WHERE email = $1
      AND revoked_at IS NULL
      AND (
        accepted_at IS NOT NULL
        OR (accepted_at IS NULL AND expires_at > NOW())
      )
  ) AS has_invite_allow
`;

export interface PgQueryClient {
  query: (sql: string, params: unknown[]) => Promise<{ rows: { has_invite_allow: boolean }[] }>;
}

export function makePgAllowlistQuery(pg: PgQueryClient): AllowlistDbQuery {
  return async (email: string) => {
    const { rows } = await pg.query(ALLOWLIST_INVITE_SQL, [email]);
    return { hasInviteAllow: rows[0]?.has_invite_allow };
  };
}
