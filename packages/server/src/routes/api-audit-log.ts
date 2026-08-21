/**
 * Global audit log — admin-only listing endpoint.
 *
 * Surfaces the `remote_agent_audit_log` table (migration 037) to the
 * Console UI. Paulo pediu (FORGE sprint, 19/ago/2026): "tudo,
 * absolutamente tudo tem que ser registrado". This endpoint is the
 * reading view for that requirement.
 *
 * Two endpoints:
 *   GET /api/audit/log                 — paginated list, filterable by
 *                                        action / entity_type / entity_id /
 *                                        actor_id / since
 *   GET /api/audit/log/entity/:type/:id — per-entity history
 *
 * Both require the `admin:users` permission (admin-only, by design —
 * the audit log contains user IPs and PII adjacent to the data model).
 *
 * Writes happen via `recordAuditLog()` from CRUD endpoints, the
 * Better Auth session.create hook, and workflow run lifecycle hooks —
 * no separate POST endpoint for now.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as auditDb from '@archon/core/db/audit-log';
import {
  listAuditLogOptionsSchema,
  type ListAuditLogResponse,
  type EntityAuditLogResponse,
} from '@archon/core/schemas';

const audit = new Hono();

// ---------------------------------------------------------------------------
// GET /api/audit/log
// ---------------------------------------------------------------------------
audit.get('/log', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;

  // Parse query — keep it permissive so the UI can pass any subset
  const q = c.req.query();
  const parsed = listAuditLogOptionsSchema.safeParse({
    limit: q.limit ? Number(q.limit) : 100,
    action: q.action ?? undefined,
    entityType: q.entityType ?? undefined,
    entityId: q.entityId ?? undefined,
    actorId: q.actorId ?? undefined,
    since: q.since ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', detail: parsed.error.message }, 400);
  }
  const result = await auditDb.listAuditLog(parsed.data);
  const response: ListAuditLogResponse = {
    entries: result.entries,
    total: result.total,
    limit: parsed.data.limit ?? 100,
  };
  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /api/audit/log/entity/:type/:id
// ---------------------------------------------------------------------------
audit.get('/log/entity/:type/:id', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const entityType = c.req.param('type');
  const entityId = c.req.param('id');
  const limitParam = Number(c.req.query('limit') ?? '50');
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200);
  const entries = await auditDb.listAuditLogForEntity(entityType, entityId, limit);
  const response: EntityAuditLogResponse = {
    entity_type: entityType,
    entity_id: entityId,
    entries,
  };
  return c.json(response);
});

export default audit;
