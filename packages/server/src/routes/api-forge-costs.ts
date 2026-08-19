/**
 * VOLUND FORGE — costs (LLM usage ledger) REST API.
 *
 * The POST endpoint is the ingestion hook called by the orchestrator
 * / chat loop. The summary + breakdown endpoints power the dashboard
 * (header KPIs + per-model / per-project / per-pipeline charts).
 *
 * `recordCost` snapshots the USD/BRL rate onto the row at write time,
 * so historical amounts stay stable when the rate changes later.
 *
 * TODO(forge-perms): gate should narrow to `forge:read` / `forge:write`.
 */
import { Hono } from 'hono';
import { requireWebPermission } from '../auth/rbac';
import * as costsDb from '@archon/core/db/costs';
import { recordCostBodySchema, type Cost } from '@archon/core/schemas';

type ApiErrorStatus = 400 | 500;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

const costs = new Hono();

// Helper to parse the windowDays query param with sane bounds.
function parseWindowDays(raw: string | undefined): number {
  if (!raw) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.max(Math.trunc(n), 1), 365);
}

// GET /api/forge/costs?runId=&demandId=&codebaseId=&model=&sinceDays=&limit=
costs.get('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const q = c.req.query();
  const sinceDays = q.sinceDays ? Number(q.sinceDays) : undefined;
  const limit = q.limit ? Number(q.limit) : undefined;
  const rows = await costsDb.listCosts({
    runId: q.runId,
    demandId: q.demandId,
    codebaseId: q.codebaseId,
    model: q.model,
    sinceDays: Number.isFinite(sinceDays) ? sinceDays : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return c.json({ costs: rows });
});

// GET /api/forge/costs/summary?windowDays=30 — MUST be declared before /:id
costs.get('/summary', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const windowDays = parseWindowDays(c.req.query('windowDays'));
  const summary = await costsDb.getCostSummary(windowDays);
  return c.json(summary);
});

// GET /api/forge/costs/breakdown?windowDays=30
costs.get('/breakdown', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const windowDays = parseWindowDays(c.req.query('windowDays'));
  const breakdown = await costsDb.getCostBreakdown(windowDays);
  return c.json(breakdown);
});

// POST /api/forge/costs
costs.post('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;
  const body = await c.req.json().catch(() => null);
  const parsed = recordCostBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid cost body', parsed.error.message);
  }
  const created = await costsDb.recordCost({
    runId: parsed.data.run_id ?? null,
    demandId: parsed.data.demand_id ?? null,
    codebaseId: parsed.data.codebase_id ?? null,
    model: parsed.data.model,
    provider: parsed.data.provider,
    kind: parsed.data.kind,
    tokensIn: parsed.data.tokens_in,
    tokensOut: parsed.data.tokens_out,
    amountUsd: parsed.data.amount_usd,
    usdBrlRate: parsed.data.usd_brl_rate,
  });
  return c.json({ cost: created satisfies Cost }, 201);
});

export default costs;
