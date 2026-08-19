/**
 * VOLUND FORGE — projects (PMO view of codebases) REST API.
 *
 * Surfaces a codebase with PMO counts (open demands, total demands,
 * runs) so the FORGE app can render the project grid from one call.
 * Mirrors /api/codebases but enriched — the FORGE app prefers this
 * endpoint to keep the dashboard payload a single round-trip.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as projectsDb from '@archon/core/db/projects';
import { type ProjectSummary } from '@archon/core/schemas';
import { createLogger } from '@archon/paths';

const log = createLogger('forge.projects');

type ApiErrorStatus = 400 | 404 | 409 | 500;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const projects = new Hono();

// GET /api/forge/projects
projects.get('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  try {
    const rows = await projectsDb.listProjectsWithCounts();
    return c.json({ projects: rows satisfies ProjectSummary[] });
  } catch (e) {
    const err = e as Error;
    log.error({ err }, 'list_projects_failed');
    return apiError(c, 500, 'Failed to list projects', err.message);
  }
});

// GET /api/forge/projects/:id
projects.get('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  try {
    const row = await projectsDb.getProjectById(id);
    if (!row) return apiError(c, 404, 'Project not found');
    return c.json({ project: row satisfies ProjectSummary });
  } catch (e) {
    const err = e as Error;
    log.error({ err, id }, 'get_project_failed');
    return apiError(c, 500, 'Failed to get project', err.message);
  }
});

// PATCH /api/forge/projects/:id — edit client_id, default_branch,
// repository_url, or kind. Does NOT touch codebases.name (that is
// the identity of the project and editing it would orphan workflows).
projects.patch('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    client_id?: string | null;
    default_branch?: string | null;
    repository_url?: string | null;
    kind?: 'repo' | 'folder';
  } | null;
  if (!body) return apiError(c, 400, 'Body required');
  try {
    const updated = await projectsDb.updateProject(id, {
      client_id: body.client_id,
      default_branch: body.default_branch,
      repository_url: body.repository_url,
      kind: body.kind,
    });
    if (!updated) return apiError(c, 404, 'Project not found');
    return c.json({ project: updated satisfies ProjectSummary });
  } catch (e) {
    const err = e as Error;
    log.error({ err, id }, 'update_project_failed');
    return apiError(c, 500, 'Failed to update project', err.message);
  }
});

// DELETE /api/forge/projects/:id — refuses if demands or runs exist.
projects.delete('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const result = await projectsDb.deleteProject(id);
  if (!result.deleted) {
    return c.json(
      { error: result.reason ?? 'Não foi possível remover o projeto' },
      result.reason?.includes('não encontrado') ? 404 : 409
    );
  }
  return c.json({ ok: true });
});

export default projects;
