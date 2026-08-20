/**
 * VOLUND FORGE — demands (kanban cards) REST API.
 *
 * Includes the kanban board projection (`/demands/board`) and the
 * dedicated status endpoint (`PATCH /demands/:id/status`) used by
 * drag-and-drop in the UI. Filters at list time mirror the schema:
 * client_id, codebase_id, status, free-text on slug/title.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as demandsDb from '@archon/core/db/demands';
import { recordAuditLog } from '@archon/core/db/audit-log';
import { changeDemandStatus } from '@archon/core/db/demand-activities';
import {
  createDemandBodySchema,
  updateDemandBodySchema,
  updateDemandStatusBodySchema,
  type Demand,
} from '@archon/core/schemas';

type ApiErrorStatus = 400 | 404 | 409;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const demands = new Hono();

// GET /api/forge/demands
// Query: clientId, codebaseId, status, search
demands.get('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const q = c.req.query();
  const rows = await demandsDb.listDemands({
    clientId: q.clientId,
    codebaseId: q.codebaseId,
    status: q.status as demandsDb.DemandStatus | undefined,
    search: q.search,
  });
  return c.json({ demands: rows });
});

// GET /api/forge/demands/board — kanban payload, MUST be declared before /:id
demands.get('/board', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const q = c.req.query();
  const board = await demandsDb.listDemandsAsBoard({
    clientId: q.clientId,
    codebaseId: q.codebaseId,
    search: q.search,
  });
  return c.json(board);
});

// POST /api/forge/demands
demands.post('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = createDemandBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid demand body', parsed.error.message);
  }
  try {
    const created = await demandsDb.createDemand({
      slug: parsed.data.slug,
      title: parsed.data.title,
      clientId: parsed.data.client_id,
      description: parsed.data.description ?? null,
      codebaseId: parsed.data.codebase_id ?? null,
      priority: parsed.data.priority,
      dueDate: parsed.data.due_date ?? null,
      metadata: parsed.data.metadata,
      createdByUserId: guard.userId,
    });
    // Audit: demand.created
    await recordAuditLog({
      action: 'demand.created',
      entityType: 'demand',
      entityId: created.id,
      actorId: guard.userId,
      metadata: {
        slug: created.slug,
        title: created.title,
        client_id: created.client_id,
        priority: created.priority,
      },
    });
    return c.json({ demand: created satisfies Demand }, 201);
  } catch (e) {
    const err = e as Error;
    if (err.message.includes('duplicate') || err.message.includes('UNIQUE')) {
      return apiError(c, 409, `A demand with slug "${parsed.data.slug}" already exists`);
    }
    throw e;
  }
});

// GET /api/forge/demands/:id
demands.get('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const row = await demandsDb.getDemandById(id);
  if (!row) return apiError(c, 404, 'Demand not found');
  return c.json({ demand: row });
});

// PATCH /api/forge/demands/:id
demands.patch('/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = updateDemandBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid demand body', parsed.error.message);
  }
  const updated = await demandsDb.updateDemand(id, {
    title: parsed.data.title,
    description: parsed.data.description,
    status: parsed.data.status,
    priority: parsed.data.priority,
    codebaseId: parsed.data.codebase_id,
    dueDate: parsed.data.due_date,
    metadata: parsed.data.metadata,
  });
  if (!updated) return apiError(c, 404, 'Demand not found');
  // Audit: demand.updated
  await recordAuditLog({
    action: 'demand.updated',
    entityType: 'demand',
    entityId: id,
    actorId: guard.userId,
    metadata: {
      changes: Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
    },
  });
  return c.json({ demand: updated });
});

// PATCH /api/forge/demands/:id/status — kanban drag-and-drop target
demands.patch('/:id/status', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = updateDemandStatusBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid status body', parsed.error.message);
  }
  // Use changeDemandStatus so we ALSO log a demand_activities row
  // (the kanban timeline shows status changes; the audit_log captures
  // the same event for the global view). Returns null on demand-not-found.
  const activity = await changeDemandStatus({
    demandId: id,
    toStatus: parsed.data.status,
    userId: guard.userId,
    source: 'manual',
    note: undefined,
  });
  if (!activity) return apiError(c, 404, 'Demand not found');
  // Re-fetch so the client sees the canonical row
  const updated = await demandsDb.getDemandById(id);
  // Audit: demand.updated (mirror the activity in the global log too)
  await recordAuditLog({
    action: 'demand.updated',
    entityType: 'demand',
    entityId: id,
    actorId: guard.userId,
    metadata: { status_change: parsed.data.status, from: activity.from_status, to: parsed.data.status },
  });
  return c.json({ demand: updated });
});

export default demands;
