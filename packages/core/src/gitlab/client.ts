/**
 * GitLab REST v4 client — minimal, fetch-based, zero dependencies.
 *
 * Why fetch (not @gitbeaker/node):
 *   - The whole stack runs on Bun + Node 20+, both of which ship a
 *     spec-compliant global `fetch`. Adding a 3 MB SDK for ~6
 *     endpoints is not worth the install / supply-chain weight.
 *   - We only need 6 calls: /user, /projects, /issues, /issues/:id,
 *     POST /issues, PUT /issues/:id, plus notes. All small JSON.
 *   - Errors should be Archon-shaped (`GitlabApiError` with status +
 *     body snippet), not SDK-specific.
 *
 * The base URL is whatever the admin entered in Settings
 * (`https://gitlab.com` or a self-hosted CE/EE). We strip a trailing
 * slash so `gitlabUrl + '/api/v4/projects'` is always canonical.
 *
 * Auth: `PRIVATE-TOKEN: <pat>` header. The token is decrypted from
 * the settings row by the caller and passed in here as a plain
 * string — this module never touches the DB or encryption.
 */
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('gitlab.client');
  return cachedLog;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PER_PAGE = 50;
const MAX_PAGES = 10;

export class GitlabApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly endpoint: string;
  constructor(status: number, endpoint: string, body: string) {
    // Truncate to keep the message readable in logs and UI; the full
    // body is rarely useful and bloated bodies (e.g. 5xx HTML) make
    // error toasts useless.
    const snippet = body.length > 240 ? `${body.slice(0, 240)}…` : body;
    super(`GitLab API ${String(status)} (${endpoint}): ${snippet}`);
    this.name = 'GitlabApiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export interface GitlabUser {
  id: number;
  username: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
}

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  visibility: 'private' | 'internal' | 'public';
  archived: boolean;
  last_activity_at: string;
}

export interface GitlabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  labels: string[];
  author: { id: number; username: string; name: string; avatar_url: string | null };
  assignees: { id: number; username: string; name: string; avatar_url: string | null }[];
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  milestone: { id: number; title: string } | null;
  weight: number | null;
}

export interface CreateIssueParams {
  title: string;
  description?: string;
  labels?: string;
  assignee_ids?: number[];
  milestone_id?: number | null;
  weight?: number | null;
}

export interface UpdateIssueParams {
  title?: string;
  description?: string;
  labels?: string;
  state_event?: 'close' | 'reopen';
  assignee_ids?: number[];
  milestone_id?: number | null;
  weight?: number | null;
}

export interface ListIssuesParams {
  state?: 'opened' | 'closed' | 'all';
  labels?: string;
  search?: string;
  perPage?: number;
  page?: number;
}

export interface GitlabClientOptions {
  gitlabUrl: string;
  accessToken: string;
  /** Optional fetch override (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin, defensive GitLab client. One instance per request — construction
 * is cheap and stateless, so we don't need pooling. The caller (settings
 * store or future issue-sync worker) decrypts the token once and passes
 * the plaintext here.
 */
export class GitlabClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitlabClientOptions) {
    // Strip trailing slashes so `${baseUrl}/api/v4/...` is always canonical
    // regardless of how the admin typed the URL in Settings.
    this.baseUrl = `${opts.gitlabUrl.replace(/\/+$/, '')}/api/v4`;
    this.headers = {
      'PRIVATE-TOKEN': opts.accessToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Lightweight connection test — GET /user. Returns the user object
   * on success, throws GitlabApiError on any non-2xx. The Settings UI
   * surfaces the thrown error's message verbatim.
   */
  async testConnection(): Promise<GitlabUser> {
    return this.request<GitlabUser>('GET', '/user');
  }

  /**
   * List projects the token can see, filtered by an optional allowlist of
   * "group/project" paths. Auto-paginates (GitLab paginates with X-Next-Page
   * up to perPage*MAX_PAGES results). For the FORGE issue board this is
   * plenty — projects are in the dozens, not thousands.
   */
  async listProjects(
    opts: { allowlist?: string[] | null; archived?: boolean } = {}
  ): Promise<GitlabProject[]> {
    const all: GitlabProject[] = [];
    const perPage = 100;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query: Record<string, string> = {
        per_page: String(perPage),
        page: String(page),
        // Default to "show non-archived only" — most orgs treat the archive
        // flag as a hide-from-board signal.
        archived: opts.archived === true ? 'true' : 'false',
        // Order by last_activity_at DESC so the most-recently-active project
        // is at the top of the FORGE project picker.
        order_by: 'last_activity_at',
        sort: 'desc',
        // membership=true (default) returns only projects the user is a
        // member of; this matches what the FORGE issue board needs (the
        // PATs the user provisions are usually scoped to a group).
        membership: 'true',
      };
      const batch = await this.request<GitlabProject[]>('GET', '/projects', query);
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    if (opts.allowlist && opts.allowlist.length > 0) {
      const allow = new Set(opts.allowlist);
      return all.filter(p => allow.has(p.path_with_namespace));
    }
    return all;
  }

  /**
   * List issues for a project. One page at a time; callers that need
   * the full list should use `listAllIssues`. Filters map 1:1 to
   * GitLab's query params (see https://docs.gitlab.com/api/issues/).
   */
  async listIssues(projectId: number, params: ListIssuesParams = {}): Promise<GitlabIssue[]> {
    const query: Record<string, string> = {
      per_page: String(params.perPage ?? DEFAULT_PER_PAGE),
    };
    if (params.page !== undefined) query.page = String(params.page);
    if (params.state !== undefined) query.state = params.state;
    if (params.labels !== undefined) query.labels = params.labels;
    if (params.search !== undefined) query.search = params.search;
    return this.request<GitlabIssue[]>(
      'GET',
      `/projects/${encodeURIComponent(String(projectId))}/issues`,
      query
    );
  }

  /**
   * Paginated "all issues" — walks pages until empty. Same MAX_PAGES cap
   * as listProjects; if you have more than 500 open issues in one project
   * you have bigger problems than the FORGE board can solve.
   */
  async listAllIssues(
    projectId: number,
    params: Omit<ListIssuesParams, 'page'> = {}
  ): Promise<GitlabIssue[]> {
    const all: GitlabIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.listIssues(projectId, { ...params, page });
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < DEFAULT_PER_PAGE) break;
    }
    return all;
  }

  async getIssue(projectId: number, issueIid: number): Promise<GitlabIssue> {
    return this.request<GitlabIssue>(
      'GET',
      `/projects/${encodeURIComponent(String(projectId))}/issues/${encodeURIComponent(String(issueIid))}`
    );
  }

  /**
   * Create an issue. The response is the full issue object (with the
   * assigned iid) — the caller stores the (project_id, iid) into
   * `remote_agent_gitlab_issue_links` so the FORGE demand row gets
   * a back-reference to the GitLab side.
   */
  async createIssue(projectId: number, params: CreateIssueParams): Promise<GitlabIssue> {
    return this.request<GitlabIssue>(
      'POST',
      `/projects/${encodeURIComponent(String(projectId))}/issues`,
      undefined,
      params as unknown as Record<string, unknown>
    );
  }

  /**
   * Update an issue. The `state_event` field is the only way to close
   * or reopen an issue via the REST API (you can't set state directly).
   * Returns the full updated issue so the caller can compare
   * `updated_at` against `last_synced_remote_updated_at` to detect
   * a "someone else edited it under us" race.
   */
  async updateIssue(
    projectId: number,
    issueIid: number,
    params: UpdateIssueParams
  ): Promise<GitlabIssue> {
    return this.request<GitlabIssue>(
      'PUT',
      `/projects/${encodeURIComponent(String(projectId))}/issues/${encodeURIComponent(String(issueIid))}`,
      undefined,
      params as unknown as Record<string, unknown>
    );
  }

  /**
   * Centralized fetch wrapper. Adds the timeout via AbortController,
   * normalizes non-2xx into GitlabApiError, and JSON-parses the body.
   * Kept private — exposing it would invite callers to skip the
   * normalization.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url =
      query && Object.keys(query).length > 0
        ? `${this.baseUrl}${path}?${new URLSearchParams(query).toString()}`
        : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout((): void => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError fires both on timeout and on user cancel; treat both
      // as a network error so the Settings UI shows "check your URL /
      // network" rather than a generic "request aborted".
      getLog().warn({ err: err as Error, url }, 'gitlab.request_aborted_or_network');
      throw new GitlabApiError(0, path, `network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      getLog().warn(
        { status: response.status, method, path, body: text.slice(0, 240) },
        'gitlab.request_failed'
      );
      throw new GitlabApiError(response.status, path, text);
    }
    // Some endpoints (DELETE) return 204 No Content; for those we let
    // the caller handle the return as undefined-ish JSON. None of our
    // current callers DELETE, but the support is here for free.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
