/**
 * VOLUND FORGE — OS's (Ordens de Serviço) REST API.
 *
 * An OS is a sub-task within a demand. The demand detail page shows
 * the OS list as a tab. Auto-stamping `completed_at` on status
 * transition to 'concluida' happens inside `updateOs()` in
 * `packages/core/src/db/oss.ts`.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as ossDb from '@archon/core/db/oss';
import { createOsBodySchema, updateOsBodySchema, type Os } from '@archon/core/schemas';

type ApiErrorStatus = 400 | 404;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const oss = new Hono();

// GET /api/forge/oss?demandId=&status=&assigneeUserId=
oss.get('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const q = c.req.query();
  const rows = await ossDb.listOss({
    demandId: q.demandId,
    status: q.status as ossDb.OsStatus | undefined,
    assigneeUserId: q.assigneeUserId,
  });
  return c.json({ oss: rows });
});

// POST /api/forge/oss
oss.post('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = createOsBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid OS body', parsed.error.message);
  }
  const created = await ossDb.createOs({
    demandId: parsed.data.demand_id,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    status: parsed.data.status,
    priority: parsed.data.priority,
    assigneeUserId: parsed.data.assignee_user_id ?? null,
    estimatedHours: parsed.data.estimated_hours ?? null,
    dueDate: parsed.data.due_date ?? null,
    metadata: parsed.data.metadata,
  });
  return c.json({ os: created satisfies Os }, 201);
});

// GET /api/forge/oss/:id
oss.get('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const row = await ossDb.getOsById(id);
  if (!row) return apiError(c, 404, 'OS not found');
  return c.json({ os: row });
});

// PATCH /api/forge/oss/:id
oss.patch('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = updateOsBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid OS body', parsed.error.message);
  }
  const updated = await ossDb.updateOs(id, {
    title: parsed.data.title,
    description: parsed.data.description,
    status: parsed.data.status,
    priority: parsed.data.priority,
    assigneeUserId: parsed.data.assignee_user_id,
    estimatedHours: parsed.data.estimated_hours,
    actualHours: parsed.data.actual_hours,
    dueDate: parsed.data.due_date,
    completedAt: parsed.data.completed_at,
    metadata: parsed.data.metadata,
  });
  if (!updated) return apiError(c, 404, 'OS not found');
  return c.json({ os: updated });
});

// DELETE /api/forge/oss/:id
oss.delete('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const ok = await ossDb.deleteOs(id);
  if (!ok) return apiError(c, 404, 'OS not found');
  return c.json({ ok: true });
});

export default oss;
