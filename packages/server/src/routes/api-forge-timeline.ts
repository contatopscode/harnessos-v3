/**
 * VOLUND FORGE — demand timeline endpoint.
 *
 * Returns the full chronological story of a single demand — activities
 * (status changes, run start/end, chat messages, manual notes) PLUS
 * the underlying workflow_runs PLUS the cost rows PLUS the chat
 * messages attributed to the demand. Used by the demand detail modal
 * in the FORGE UI to answer "what happened to this demand and where
 * is it now?".
 *
 * Schema: `demandTimelineResponseSchema` (packages/core/src/schemas/forge.ts).
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import { pool } from '@archon/core/db/connection';
import * as demandsDb from '@archon/core/db/demands';
import type {
  DemandActivity,
  DemandTimelineEntry,
  DemandTimelineResponse,
} from '@archon/core/schemas';

const timeline = new Hono();

/**
 * GET /api/forge/demands/:id/timeline
 *
 * Mounted at /api/forge/demands (see api.ts). The full path is
 * /api/forge/demands/:id/timeline.
 *
 * Query params: limit (default 100, max 500)
 *
 * Returns: { demand, entries: [...], totals: { activities, runs, cost_calls, cost_total_usd, cost_total_brl, messages } }
 */
timeline.get('/:id/timeline', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const id = c.req.param('id');
  const limitParam = Number(c.req.query('limit') ?? '100');
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 100, 1), 500);

  // 1. Load the demand itself
  const demand = await demandsDb.getDemandById(id);
  if (!demand) {
    return c.json({ error: 'Demand not found' }, 404);
  }

  // 2. Activities (status changes, run start/end, messages, notes)
  const activitiesRes = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_demand_activities
     WHERE demand_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [id, limit]
  );
  const activities: DemandActivity[] = activitiesRes.rows.map(row => ({
    id: String(row.id),
    demand_id: String(row.demand_id),
    action: row.action as DemandActivity['action'],
    from_status: (row.from_status as string | null) ?? null,
    to_status: (row.to_status as string | null) ?? null,
    from_priority: (row.from_priority as string | null) ?? null,
    to_priority: (row.to_priority as string | null) ?? null,
    run_id: (row.run_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    user_id: (row.user_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    created_at: String(row.created_at),
  }));

  // 3. Workflow runs (latest ones, regardless of activity link)
  const runsRes = await pool.query<Record<string, unknown>>(
    `SELECT id, workflow_name, status, started_at, completed_at,
            user_message, current_step_index
     FROM remote_agent_workflow_runs
     WHERE demand_id = $1
     ORDER BY started_at DESC
     LIMIT $2`,
    [id, limit]
  );
  const runs = runsRes.rows;

  // 4. Cost rows (LLM calls attributed to this demand)
  const costsRes = await pool.query<Record<string, unknown>>(
    `SELECT id, model, kind, tokens_in, tokens_out, amount_usd, amount_brl, created_at, message_id
     FROM remote_agent_costs
     WHERE demand_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [id, limit]
  );
  const costs = costsRes.rows;
  const totalUsd = costs.reduce((s, c) => s + Number(c.amount_usd ?? 0), 0);
  const totalBrl = costs.reduce((s, c) => s + Number(c.amount_brl ?? 0), 0);

  // 5. Build the merged entries array (sorted by timestamp desc)
  const entries: DemandTimelineEntry[] = [];

  for (const a of activities) {
    let title = '';
    let detail: string | null = null;
    switch (a.action) {
      case 'created':
        title = 'Demanda criada';
        detail = a.note;
        break;
      case 'status_change':
        title = `Status: ${a.from_status ?? '?'} → ${a.to_status ?? '?'}`;
        detail = a.note;
        break;
      case 'priority_change':
        title = `Prioridade: ${a.from_priority ?? '?'} → ${a.to_priority ?? '?'}`;
        detail = a.note;
        break;
      case 'run_started':
        title = 'Run iniciado';
        detail = a.note;
        break;
      case 'run_completed':
        title = 'Run concluído ✓';
        detail = a.note;
        break;
      case 'run_failed':
        title = 'Run falhou ✗';
        detail = a.note;
        break;
      case 'message':
        title = 'Mensagem do chat';
        detail = a.note;
        break;
      case 'note':
        title = a.note ? `Nota: ${a.note.slice(0, 80)}` : 'Nota';
        detail = null;
        break;
    }
    entries.push({
      kind: 'activity',
      at: a.created_at,
      title,
      detail,
      activity: a,
    });
  }

  for (const r of runs) {
    entries.push({
      kind: 'run',
      at: String(r.started_at),
      title: `Run: ${String(r.workflow_name)} [${String(r.status)}]`,
      detail: truncate(String(r.user_message ?? ''), 200),
      run_id: String(r.id),
      run_status: String(r.status),
      run_workflow_name: String(r.workflow_name),
    });
  }

  for (const c of costs) {
    entries.push({
      kind: 'cost',
      at: String(c.created_at),
      title: `${String(c.model)} — ${String(c.kind)}`,
      detail: `${String(c.tokens_in)} in / ${String(c.tokens_out)} out · $${Number(c.amount_usd).toFixed(6)}`,
      cost_id: String(c.id),
      cost_model: String(c.model),
      cost_tokens_in: Number(c.tokens_in ?? 0),
      cost_tokens_out: Number(c.tokens_out ?? 0),
      cost_amount_usd: Number(c.amount_usd ?? 0),
      cost_amount_brl: Number(c.amount_brl ?? 0),
    });
  }

  // Sort desc by timestamp
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  // Cap to limit
  const trimmedEntries = entries.slice(0, limit);

  // Count message activities
  const messageActivities = activities.filter(a => a.action === 'message');

  const response: DemandTimelineResponse = {
    demand,
    entries: trimmedEntries,
    totals: {
      activities: activities.length,
      runs: runs.length,
      cost_calls: costs.length,
      cost_total_usd: round6(totalUsd),
      cost_total_brl: round2(totalBrl),
      messages: messageActivities.length,
    },
  };

  return c.json(response);
});

function truncate(text: string, n: number): string {
  if (!text) return '';
  if (text.length <= n) return text;
  return text.slice(0, n - 1) + '…';
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default timeline;
