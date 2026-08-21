/**
 * VOLUND FORGE — demands (kanban cards) REST API.
 *
 * Includes the kanban board projection (`/demands/board`), the dedicated
 * status endpoint (`PATCH /demands/:id/status`) used by drag-and-drop in
 * the UI, and the **disparar RUN** endpoint (`POST /demands/:id/run`)
 * that triggers a workflow run linked to the demand. Filters at list
 * time mirror the schema: client_id, codebase_id, status, free-text on
 * slug/title.
 *
 * Auto-progress: when a workflow run is triggered from a demand, the
 * `completeWorkflowRun` / `failWorkflowRun` hooks advance the demand
 * status forward (backlog → triagem → requisitos → em_andamento) or
 * set 'bloqueada' on failure — the user does NOT need to move the
 * card manually after the run finishes.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`.
 */
import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { requireWebPermission } from '../auth/rbac';
import * as demandsDb from '@archon/core/db/demands';
import { recordAuditLog } from '@archon/core/db/audit-log';
import { changeDemandStatus } from '@archon/core/db/demand-activities';
import { createLogger } from '@archon/paths';
import { handleMessage } from '@archon/core/orchestrator/orchestrator-agent';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core/types';
import type { MessageChunk, TokenUsage } from '@archon/providers/types';

const log = createLogger('forge.demands');

/**
 * Minimal no-op IPlatformAdapter for fire-and-forget workflow runs
 * triggered from a demand. The orchestrator needs an adapter to call
 * `sendMessage` / `ensureThread` on, but the synthetic conversation
 * (`web-demand-${id}-${ts}`) is never opened in the Web UI — the user
 * follows the demand's progress through the kanban card auto-advance
 * instead of the chat SSE stream. So every method is a no-op that just
 * logs the discard at debug level.
 *
 * Keeping this inlined (rather than reaching for the live webAdapter
 * singleton) avoids a cross-file dependency + lets the route be
 * imported by any future surface (e.g. a CLI) without coupling to the
 * web transport.
 */
const noopDemandAdapter: IPlatformAdapter = {
  async sendMessage(
    _conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    log.debug({ messagePreview: message.slice(0, 80) }, 'demand_run.sendMessage_dropped');
  },
  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  },
  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  },
  getPlatformType(): string {
    return 'demand-runner';
  },
  async start(): Promise<void> {
    // no-op
  },
  stop(): void {
    // no-op
  },
  async sendStructuredEvent(_conversationId: string, _event: MessageChunk): Promise<void> {
    // no-op — the user follows progress via demand_activities, not via SSE
  },
  async emitRetract(): Promise<void> {
    // no-op
  },
  async sendResultFooter(
    _conversationId: string,
    _info: { cost?: number; tokens?: TokenUsage; stopReason?: string }
  ): Promise<void> {
    // no-op
  },
};
import {
  createDemandBodySchema,
  updateDemandBodySchema,
  updateDemandStatusBodySchema,
  type Demand,
} from '@archon/core/schemas';

type ApiErrorStatus = 400 | 404 | 409 | 500;

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
    metadata: {
      status_change: parsed.data.status,
      from: activity.from_status,
      to: parsed.data.status,
    },
  });
  return c.json({ demand: updated });
});

// ---------------------------------------------------------------------------
// POST /api/forge/demands/:id/run
//
// "Disparar RUN" button on the HarnessOS Console Kanban — triggers a
// workflow run against the codebase of the demand. The run is linked to
// the demand via `workflow_run.demand_id` (set by the dispatch chain),
// which lets the existing audit-trail hooks do two things for free:
//
//   1. Fire `run_started` activity on the demand (visible in the
//      DemandTimelineModal).
//   2. On completion / failure, auto-advance the demand's status
//      (`completeWorkflowRun` moves backlog → triagem → requisitos →
//      em_andamento forward-only; `failWorkflowRun` sets 'bloqueada').
//
// So the human just clicks the button; the demand card updates itself
// as the Builder works through it.
// ---------------------------------------------------------------------------
const triggerRunBodySchema = z
  .object({
    workflow: z.string().min(1).max(128),
    message: z.string().min(1).max(8000),
    triggered_by: z.enum(['chat', 'api', 'cron', 'auto', 'manual']).optional().default('manual'),
  })
  .openapi('TriggerDemandRunBody');

demands.post('/:id/run', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = triggerRunBodySchema.safeParse(body);
  if (!parsed.success) return apiError(c, 400, 'Invalid run body', parsed.error.message);

  const demand = await demandsDb.getDemandById(id);
  if (!demand) return apiError(c, 404, 'Demand not found');

  // A demand can only be run if it has a codebase attached (otherwise we
  // don't know where to dispatch the workflow).
  if (!demand.codebase_id) {
    return apiError(
      c,
      400,
      'Demand has no codebase attached — cannot dispatch a workflow run without a target repo'
    );
  }

  // Audit: the "disparar" click — we record it BEFORE the actual dispatch
  // so the action is captured even if the dispatch fails downstream.
  await recordAuditLog({
    action: 'demand.run_dispatched',
    entityType: 'demand',
    entityId: id,
    actorId: guard.userId,
    metadata: {
      workflow: parsed.data.workflow,
      triggered_by: parsed.data.triggered_by,
      codebase_id: demand.codebase_id,
    },
  });

  try {
    const platformConvId = `web-demand-${id}-${String(Date.now())}`;
    const fullMessage = `/workflow run ${parsed.data.workflow} ${parsed.data.message}`;
    // The orchestrator's handleMessage picks up demandId + triggeredBy
    // via the HandleMessageContext and threads them all the way to
    // `createWorkflowRun`, so the workflow_run row gets `demand_id` set
    // and the auto-progress hooks (completeWorkflowRun / failWorkflowRun)
    // advance the demand's status when the run finishes.
    //
    // Fire-and-forget: the HTTP response returns immediately while the
    // orchestrator's pre-create + executeWorkflow chain runs in the
    // background. The user sees the demand card auto-progress via the
    // demand_activities table (which the hooks populate on completion).
    void handleMessage(noopDemandAdapter, platformConvId, fullMessage, {
      userId: guard.userId,
      demandId: id,
      triggeredBy: parsed.data.triggered_by,
    }).catch((err: Error) => {
      // Audit-log the failure so a silent dispatch error is visible.
      log.error(
        { err, demandId: id, workflow: parsed.data.workflow },
        'demand.run_dispatch_failed'
      );
    });
    return c.json({
      accepted: true,
      status: 'dispatched',
      demand_id: id,
      workflow: parsed.data.workflow,
    });
  } catch (e: unknown) {
    const err = e as Error;
    return apiError(c, 500, `Failed to dispatch run: ${err.message}`);
  }
});

export default demands;
