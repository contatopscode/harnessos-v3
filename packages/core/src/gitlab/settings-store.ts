/**
 * GitLab integration — singleton settings store.
 *
 * One row in `remote_agent_gitlab_settings` per installation, keyed by
 * id=1. The token is encrypted at rest with the same AES-256-GCM helper
 * used for `user_github_tokens` and `user_provider_keys` (see
 * `packages/core/src/utils/token-crypto.ts`).
 *
 * The Settings UI (admin-only Console page) reads via `getGitlabSettings`
 * (token redacted) and writes via `saveGitlabSettings`. `testGitlabConnection`
 * decrypts the token, builds a one-shot `GitlabClient`, and reports
 * the username on success or the error message on failure.
 */
import { pool, getDialect } from '../db/connection';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import { createLogger } from '@archon/paths';
import { GitlabClient, GitlabApiError } from './client';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('gitlab.settings');
  return cachedLog;
}

// Re-export the client so the server-side route file can import both
// from one place.
export { GitlabClient, GitlabApiError } from './client';

/** Shape returned to the admin UI — token is REDACTED (never sent to the browser). */
export interface GitlabSettingsView {
  gitlabUrl: string;
  hasToken: boolean;
  tokenLast4: string | null;
  projectFilter: string[];
  syncEnabled: boolean;
  lastTestedAt: string | null;
  lastTestUser: string | null;
  lastTestStatus: 'ok' | 'auth_failed' | 'network_error' | 'never_tested' | null;
  lastTestError: string | null;
  updatedAt: string | null;
}

/** Params accepted by saveGitlabSettings. Empty token means "don't change". */
export interface SaveGitlabSettingsParams {
  gitlabUrl: string;
  /** Plaintext PAT. Empty string = leave the stored token unchanged. */
  accessToken: string;
  projectFilter: string[];
  syncEnabled: boolean;
}

interface GitlabSettingsRow {
  gitlab_url: string;
  access_token_encrypted: string;
  project_filter: string | null;
  sync_enabled: boolean | number;
  last_tested_at: Date | string | null;
  last_test_user: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
  updated_at: Date | string | null;
}

/** Coerce a dialect-dependent timestamp to ISO string (PG Date | SQLite ISO). */
function toIsoString(v: Date | string | null): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Coerce sync_enabled (PG boolean | SQLite 0/1) to boolean. */
function toBool(v: boolean | number): boolean {
  return v === true || v === 1;
}

/** Parse the project_filter TEXT column into a string[]. */
function parseProjectFilter(v: string | null): string[] {
  if (!v) return [];
  return v
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Serialize a string[] back to the project_filter TEXT format. */
function serializeProjectFilter(arr: string[]): string {
  // Trim + dedupe + drop empties so a hand-typed allowlist in the UI
  // doesn't accumulate whitespace or duplicates.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const v = raw.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.join('\n');
}

/**
 * Read the singleton settings row and project a redaction-safe view.
 *
 * We never return the plaintext or even the full encrypted token to
 * the UI — only the last 4 characters of the decrypted token (or null
 * if no token is set) so the admin can sanity-check which token is
 * active without us shipping a secret to the browser.
 */
export async function getGitlabSettings(): Promise<GitlabSettingsView> {
  const result = await pool.query<GitlabSettingsRow>(
    'SELECT gitlab_url, access_token_encrypted, project_filter, sync_enabled, ' +
      'last_tested_at, last_test_user, last_test_status, last_test_error, updated_at ' +
      'FROM remote_agent_gitlab_settings WHERE id = 1'
  );
  const row = result.rows[0];
  if (!row) {
    // Should be impossible because the migration inserts the row on
    // first install. But if it ever does happen, return a safe default
    // rather than throwing (the Settings page should still render).
    return {
      gitlabUrl: 'https://gitlab.com',
      hasToken: false,
      tokenLast4: null,
      projectFilter: [],
      syncEnabled: false,
      lastTestedAt: null,
      lastTestUser: null,
      lastTestStatus: 'never_tested',
      lastTestError: null,
      updatedAt: null,
    };
  }
  let hasToken = false;
  let tokenLast4: string | null = null;
  if (row.access_token_encrypted && row.access_token_encrypted.length > 0) {
    try {
      const key = getEncryptionKey();
      const plain = decryptToken(row.access_token_encrypted, key);
      hasToken = true;
      tokenLast4 = plain.length >= 4 ? plain.slice(-4) : plain;
    } catch (err) {
      // Wrong key (rotation), tampered ciphertext, etc. Don't leak the
      // error to the UI; just report "we have something but can't read
      // it" so the admin knows to re-save the token.
      getLog().error({ err: err as Error }, 'gitlab.settings.decrypt_failed');
      hasToken = false;
      tokenLast4 = null;
    }
  }
  return {
    gitlabUrl: row.gitlab_url,
    hasToken,
    tokenLast4,
    projectFilter: parseProjectFilter(row.project_filter),
    syncEnabled: toBool(row.sync_enabled),
    lastTestedAt: toIsoString(row.last_tested_at),
    lastTestUser: row.last_test_user,
    lastTestStatus: normalizeTestStatus(row.last_test_status),
    lastTestError: row.last_test_error,
    updatedAt: toIsoString(row.updated_at),
  };
}

/** Validate the test_status string from the DB and project to the enum the UI expects. */
function normalizeTestStatus(v: string | null): GitlabSettingsView['lastTestStatus'] {
  if (v === 'ok' || v === 'auth_failed' || v === 'network_error') return v;
  return v === null ? 'never_tested' : 'never_tested';
}

/**
 * Persist the settings. Empty `accessToken` = keep the stored token
 * (so the Settings form can save the URL without forcing a re-token).
 * We always re-encrypt if a non-empty token is provided.
 */
export async function saveGitlabSettings(
  params: SaveGitlabSettingsParams
): Promise<GitlabSettingsView> {
  // Cheap input validation — the Settings page already validates, but
  // we re-validate here so a future programmatic caller can't write
  // garbage to the DB.
  const url = params.gitlabUrl.trim();
  if (!url) {
    throw new Error('gitlabUrl is required');
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('gitlabUrl must start with http:// or https://');
  }
  const filterText = serializeProjectFilter(params.projectFilter);
  const dialect = getDialect();
  const now = dialect.now();

  if (params.accessToken && params.accessToken.length > 0) {
    const key = getEncryptionKey();
    const enc = encryptToken(params.accessToken, key);
    await pool.query(
      `UPDATE remote_agent_gitlab_settings
         SET gitlab_url = $1,
             access_token_encrypted = $2,
             project_filter = $3,
             sync_enabled = $4,
             -- Reset test diagnostic whenever credentials change.
             -- Stale "ok" from an old token would be misleading.
             last_tested_at = NULL,
             last_test_user = NULL,
             last_test_status = NULL,
             last_test_error = NULL,
             updated_at = ${now}
       WHERE id = 1`,
      [url, enc, filterText || null, params.syncEnabled]
    );
    getLog().info({ url, syncEnabled: params.syncEnabled }, 'gitlab.settings.saved_with_token');
  } else {
    await pool.query(
      `UPDATE remote_agent_gitlab_settings
         SET gitlab_url = $1,
             project_filter = $2,
             sync_enabled = $3,
             updated_at = ${now}
       WHERE id = 1`,
      [url, filterText || null, params.syncEnabled]
    );
    getLog().info({ url, syncEnabled: params.syncEnabled }, 'gitlab.settings.saved_without_token');
  }
  return getGitlabSettings();
}

/** Result of a connection test. */
export interface TestGitlabConnectionResult {
  ok: boolean;
  user: string | null;
  status: 'ok' | 'auth_failed' | 'network_error';
  error: string | null;
}

/**
 * Probe the configured GitLab with a lightweight GET /user. Updates
 * the singleton's last_test_* columns with the outcome so the admin
 * can see "last tested 5 min ago by prssilva@gmail.com" without
 * having to re-test.
 *
 * IMPORTANT: a successful test *does not* auto-enable sync. The admin
 * still has to flip `sync_enabled = true` on the Settings page — auto-
 * enabling on a successful connection is a foot-gun (e.g. PATs issued
 * with `read_api` only would silently fail on every write).
 */
export async function testGitlabConnection(): Promise<TestGitlabConnectionResult> {
  const { gitlabUrl, accessToken } = await getDecryptedSettings();
  if (!accessToken) {
    return {
      ok: false,
      user: null,
      status: 'auth_failed',
      error: 'Nenhum token configurado — salve o Personal Access Token antes de testar.',
    };
  }
  const client = new GitlabClient({ gitlabUrl, accessToken });
  const dialect = getDialect();
  const now = dialect.now();
  try {
    const user = await client.testConnection();
    await pool.query(
      `UPDATE remote_agent_gitlab_settings
         SET last_tested_at = ${now},
             last_test_user = $1,
             last_test_status = 'ok',
             last_test_error = NULL,
             updated_at = ${now}
       WHERE id = 1`,
      [user.username]
    );
    getLog().info({ user: user.username, url: gitlabUrl }, 'gitlab.test.ok');
    return { ok: true, user: user.username, status: 'ok', error: null };
  } catch (err) {
    const status = classifyTestError(err);
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE remote_agent_gitlab_settings
         SET last_tested_at = ${now},
             last_test_user = NULL,
             last_test_status = $1,
             last_test_error = $2,
             updated_at = ${now}
       WHERE id = 1`,
      [status, message.slice(0, 500)]
    );
    getLog().warn({ status, url: gitlabUrl, err: message }, 'gitlab.test.failed');
    return { ok: false, user: null, status, error: message };
  }
}

/** Map a GitLab test error to the coarse 3-state enum the UI displays. */
function classifyTestError(err: unknown): 'auth_failed' | 'network_error' {
  if (err instanceof GitlabApiError) {
    if (err.status === 401 || err.status === 403) return 'auth_failed';
    // 5xx, 404, or anything else: treat as "the server is reachable
    // but the URL is wrong" — it's a network/hosting problem from the
    // admin's perspective. (4xx that isn't 401/403 — e.g. 404 on /user
    // because the URL points to a non-GitLab host — is a config error.)
    return 'network_error';
  }
  return 'network_error';
}

/** Internal: read + decrypt the settings, throwing if no token is set. */
async function getDecryptedSettings(): Promise<{ gitlabUrl: string; accessToken: string | null }> {
  const result = await pool.query<{ gitlab_url: string; access_token_encrypted: string }>(
    'SELECT gitlab_url, access_token_encrypted FROM remote_agent_gitlab_settings WHERE id = 1'
  );
  const row = result.rows[0];
  if (!row) return { gitlabUrl: 'https://gitlab.com', accessToken: null };
  if (!row.access_token_encrypted) {
    return { gitlabUrl: row.gitlab_url, accessToken: null };
  }
  try {
    const key = getEncryptionKey();
    return {
      gitlabUrl: row.gitlab_url,
      accessToken: decryptToken(row.access_token_encrypted, key),
    };
  } catch (err) {
    getLog().error({ err: err as Error }, 'gitlab.settings.decrypt_failed');
    return { gitlabUrl: row.gitlab_url, accessToken: null };
  }
}

/**
 * Build a one-shot GitlabClient from the persisted settings. Returns
 * null when no token is set so callers can branch on "GitLab not
 * configured yet" without a try/catch. Use this in Phase 2+ code
 * (issue board, sync worker) — Phase 1 only uses the store directly
 * for the settings UI + test endpoint.
 */
export async function buildGitlabClient(): Promise<GitlabClient | null> {
  const { gitlabUrl, accessToken } = await getDecryptedSettings();
  if (!accessToken) return null;
  return new GitlabClient({ gitlabUrl, accessToken });
}
