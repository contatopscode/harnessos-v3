/**
 * VOLUND FORGE — sprints (time-boxed commitment window) REST API.
 *
 * A demand references a sprint through `metadata.sprint_id` (JSONB
 * lookup), not a FK. So this resource is the master list; demand
 * detail pages look up the linked sprint by id when rendering.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as sprintsDb from '@archon/core/db/sprints';
import { recordAuditLog } from '@archon/core/db/audit-log';
import { createSprintBodySchema, type Sprint } from '@archon/core/schemas';

type ApiErrorStatus = 400 | 404;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const sprints = new Hono();

// GET /api/forge/sprints?clientId=
sprints.get('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const clientId = c.req.query('clientId');
  const rows = await sprintsDb.listSprints({ clientId });
  return c.json({ sprints: rows });
});

// POST /api/forge/sprints
sprints.post('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = createSprintBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid sprint body', parsed.error.message);
  }
  const created = await sprintsDb.createSprint({
    clientId: parsed.data.client_id,
    name: parsed.data.name,
    startDate: parsed.data.start_date,
    endDate: parsed.data.end_date,
    status: parsed.data.status,
    goal: parsed.data.goal ?? null,
  });
  // Audit: sprint.created
  await recordAuditLog({
    action: 'sprint.created',
    entityType: 'sprint',
    entityId: created.id,
    actorId: guard.userId,
    metadata: {
      name: created.name,
      client_id: created.client_id,
      start_date: created.start_date,
      end_date: created.end_date,
    },
  });
  return c.json({ sprint: created satisfies Sprint }, 201);
});

// GET /api/forge/sprints/:id
sprints.get('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const row = await sprintsDb.getSprintById(id);
  if (!row) return apiError(c, 404, 'Sprint not found');
  return c.json({ sprint: row });
});

// PATCH /api/forge/sprints/:id — name/dates/status/goal are mutable
sprints.patch('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    start_date?: string;
    end_date?: string;
    status?: sprintsDb.SprintStatus;
    goal?: string | null;
  } | null;
  if (!body) return apiError(c, 400, 'Body required');
  const updated = await sprintsDb.updateSprint(id, {
    name: body.name,
    startDate: body.start_date,
    endDate: body.end_date,
    status: body.status,
    goal: body.goal,
  });
  if (!updated) return apiError(c, 404, 'Sprint not found');
  // Audit: sprint.updated
  await recordAuditLog({
    action: 'sprint.updated',
    entityType: 'sprint',
    entityId: id,
    actorId: guard.userId,
    metadata: {
      changes: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
    },
  });
  return c.json({ sprint: updated });
});

export default sprints;
