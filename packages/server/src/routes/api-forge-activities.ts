/**
 * VOLUND FORGE — demand activities manual endpoint.
 *
 * Allows users to add a manual note (or trigger a status/priority
 * change) to a demand and have it logged in the demand_activities
 * audit trail. The timeline endpoint joins these rows with the
 * auto-generated ones (status changes from the PATCH endpoint, run
 * events, chat messages) into a single chronological feed.
 *
 * Schema: `createDemandActivityBodySchema`
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as activitiesDb from '@archon/core/db/demand-activities';
import * as demandsDb from '@archon/core/db/demands';
import { createLogger } from '@archon/paths';
import { createDemandActivityBodySchema } from '@archon/core/schemas';

const log = createLogger('forge.activities');

const activities = new Hono();

/**
 * POST /api/forge/demands/:id/activities
 *
 * Body: { action?: 'note' | 'status_change' | 'priority_change', note, to_status?, to_priority?, metadata? }
 *
 * For 'status_change' or 'priority_change', the corresponding `to_*` field is required.
 */
activities.post('/demands/:id/activities', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;

  const demandId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = createDemandActivityBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid activity body', detail: parsed.error.message }, 400);
  }

  // Verify demand exists
  const demand = await demandsDb.getDemandById(demandId);
  if (!demand) {
    return c.json({ error: 'Demand not found' }, 404);
  }

  // Dispatch by action type
  try {
    if (parsed.data.action === 'status_change') {
      if (!parsed.data.to_status) {
        return c.json({ error: 'to_status required for status_change' }, 400);
      }
      const activity = await activitiesDb.changeDemandStatus({
        demandId,
        toStatus: parsed.data.to_status,
        userId: guard.userId,
        source: 'manual',
        note: parsed.data.note,
      });
      // changeDemandStatus returns null if demand not found (double-check)
      if (!activity) {
        return c.json({ error: 'Demand not found' }, 404);
      }
      // Re-fetch the demand so the client sees the new status
      const updated = await demandsDb.getDemandById(demandId);
      return c.json({ activity, demand: updated }, 201);
    }
    if (parsed.data.action === 'priority_change') {
      if (!parsed.data.to_priority) {
        return c.json({ error: 'to_priority required for priority_change' }, 400);
      }
      const fromPriority = demand.priority;
      // Apply the priority change
      await demandsDb.updateDemand(demandId, { priority: parsed.data.to_priority });
      const activity = await activitiesDb.recordActivity({
        demandId,
        action: 'priority_change',
        fromPriority,
        toPriority: parsed.data.to_priority,
        userId: guard.userId,
        note: parsed.data.note,
        metadata: { source: 'manual', ...(parsed.data.metadata ?? {}) },
      });
      const updated = await demandsDb.getDemandById(demandId);
      return c.json({ activity, demand: updated }, 201);
    }
    // Default: 'note'
    const activity = await activitiesDb.recordActivity({
      demandId,
      action: 'note',
      userId: guard.userId,
      note: parsed.data.note,
      metadata: { source: 'manual', ...(parsed.data.metadata ?? {}) },
    });
    return c.json({ activity }, 201);
  } catch (e) {
    log.error({ err: (e as Error).message }, 'forge.activities.create_failed');
    return c.json({ error: 'Failed to create activity' }, 500);
  }
});

/**
 * GET /api/forge/demands/:id/activities
 *
 * Query params: limit (default 50, max 200)
 *
 * Returns the recent activities for a demand (most recent first).
 */
activities.get('/demands/:id/activities', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const demandId = c.req.param('id');
  const limitParam = Number(c.req.query('limit') ?? '50');
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200);
  const activities = await activitiesDb.listActivitiesForDemand(demandId, limit);
  return c.json({ activities });
});

export default activities;
