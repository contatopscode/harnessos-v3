/**
 * Admin endpoints for the GitLab integration — Phase 1 (settings + test).
 *
 *   GET    /api/admin/gitlab/settings        — redaction-safe view (no token)
 *   PUT    /api/admin/gitlab/settings        — update URL / filter / sync_enabled
 *                                              (token only re-saved if provided)
 *   POST   /api/admin/gitlab/settings/test   — probe with the stored token
 *   GET    /api/admin/gitlab/projects        — list projects visible to the token
 *                                              (Phase 2 preview — used by the
 *                                              "pick a project" picker in the
 *                                              issue link form)
 *
 * All four require the `admin:users` permission (admin-only — the settings
 * page is already gated by the SettingsPage's `requireAdmin` route guard;
 * the server-side guard is the second layer of the same "admins only" rule).
 *
 * Phase 2 (issue board view), Phase 3 (write sync), and Phase 4 (webhook
 * receiver) will add their own non-admin routes under /api/gitlab/ once
 * the data model + read path are validated.
 */
import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { requireWebPermission } from '../auth/rbac';
import {
  getGitlabSettings,
  saveGitlabSettings,
  testGitlabConnection,
  buildGitlabClient,
  type SaveGitlabSettingsParams,
} from '@archon/core/gitlab';
import { createLogger } from '@archon/paths';

const log = createLogger('admin-gitlab');

type ApiErrorStatus = 400 | 401 | 403 | 404 | 502 | 503;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

// Body of PUT /api/admin/gitlab/settings. `accessToken` is OPTIONAL — when
// omitted, the existing stored token is preserved (so the admin can change
// the URL or sync_enabled without rotating the PAT).
const saveSettingsBodySchema = z.object({
  gitlabUrl: z.string().min(1).max(512),
  accessToken: z.string().optional().default(''),
  projectFilter: z.array(z.string().min(1).max(255)).max(500).default([]),
  syncEnabled: z.boolean().default(false),
});

const gitlab = new Hono();

// ---------------------------------------------------------------------------
// GET /api/admin/gitlab/settings
// ---------------------------------------------------------------------------
gitlab.get('/gitlab/settings', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const view = await getGitlabSettings();
  return c.json({ settings: view });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/gitlab/settings
// ---------------------------------------------------------------------------
gitlab.put('/gitlab/settings', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = saveSettingsBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid settings body', parsed.error.message);
  }
  try {
    const view = await saveGitlabSettings(parsed.data as SaveGitlabSettingsParams);
    return c.json({ settings: view });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'admin.gitlab.save_failed');
    return apiError(c, 400, 'Failed to save GitLab settings', message);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/gitlab/settings/test
// ---------------------------------------------------------------------------
gitlab.post('/gitlab/settings/test', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const result = await testGitlabConnection();
  // Always 200 — the test endpoint reports its own outcome in the body so
  // the UI can show the inline error without interpreting HTTP status codes.
  return c.json({ result });
});

// ---------------------------------------------------------------------------
// GET /api/admin/gitlab/projects
//   Phase 2 preview — admin-only so the Settings page can offer a
//   "Pick a project from your GitLab" picker. The list is filtered by
//   the allowlist saved in settings.project_filter (so the admin sees
//   exactly the projects that will be exposed in FORGE).
// ---------------------------------------------------------------------------
gitlab.get('/gitlab/projects', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const client = await buildGitlabClient();
  if (!client) {
    return apiError(c, 400, 'GitLab not configured — save the token first.');
  }
  const view = await getGitlabSettings();
  try {
    const projects = await client.listProjects({ allowlist: view.projectFilter });
    return c.json({ projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'admin.gitlab.list_projects_failed');
    return apiError(c, 502, 'Failed to list GitLab projects', message);
  }
});

export default gitlab;
