/**
 * VOLUND FORGE — costs (LLM usage ledger).
 *
 * One row per LLM call. The orchestrator / chat loop calls
 * `recordCost()` to append a row; the dashboard hits
 * `getCostSummary()` for KPIs and `getCostBreakdown()` for the
 * per-model / per-project / per-pipeline rollup.
 *
 * amount_brl is informational — we capture the USD/BRL rate on the
 * row at write time so the historical amount is stable even when
 * the rate moves later. Real billing happens in USD.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';

const log = createLogger('db.costs');

export type CostKind = 'chat' | 'completion' | 'embedding' | 'tool' | 'image';

export interface CostRow {
  id: string;
  run_id: string | null;
  demand_id: string | null;
  codebase_id: string | null;
  model: string;
  provider: string;
  kind: CostKind;
  tokens_in: number;
  tokens_out: number;
  amount_usd: number;
  usd_brl_rate: number;
  amount_brl: number;
  created_at: string;
}

const DEFAULT_USD_BRL_RATE = 5.0;

function toCost(row: Record<string, unknown>): CostRow {
  return {
    id: str(row.id),
    run_id: nullableStr(row.run_id),
    demand_id: nullableStr(row.demand_id),
    codebase_id: nullableStr(row.codebase_id),
    model: str(row.model),
    provider: str(row.provider),
    kind: (str(row.kind) as CostKind) ?? 'chat',
    tokens_in: intOrZero(row.tokens_in),
    tokens_out: intOrZero(row.tokens_out),
    amount_usd: numOrZero(row.amount_usd),
    usd_brl_rate: numOrZero(row.usd_brl_rate) || DEFAULT_USD_BRL_RATE,
    amount_brl: numOrZero(row.amount_brl),
    created_at: str(row.created_at),
  };
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  return '';
}

function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  return null;
}

function intOrZero(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

function numOrZero(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function recordCost(input: {
  runId?: string | null;
  demandId?: string | null;
  codebaseId?: string | null;
  model: string;
  provider: string;
  kind?: CostKind;
  tokensIn: number;
  tokensOut: number;
  amountUsd: number;
  usdBrlRate?: number;
}): Promise<CostRow> {
  const rate = input.usdBrlRate ?? DEFAULT_USD_BRL_RATE;
  const amountBrl = input.amountUsd * rate;
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_costs
       (run_id, demand_id, codebase_id, model, provider, kind,
        tokens_in, tokens_out, amount_usd, usd_brl_rate, amount_brl)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.runId ?? null,
      input.demandId ?? null,
      input.codebaseId ?? null,
      input.model,
      input.provider,
      input.kind ?? 'chat',
      input.tokensIn,
      input.tokensOut,
      input.amountUsd,
      rate,
      amountBrl,
    ]
  );
  log.info(
    {
      model: input.model,
      provider: input.provider,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      amountUsd: input.amountUsd,
      amountBrl: Number(amountBrl.toFixed(2)),
    },
    'cost.recorded'
  );
  return toCost(result.rows[0]);
}

export async function listCosts(filter?: {
  runId?: string;
  demandId?: string;
  codebaseId?: string;
  model?: string;
  sinceDays?: number;
  limit?: number;
}): Promise<CostRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filter?.runId) {
    where.push(`run_id = $${String(i++)}`);
    values.push(filter.runId);
  }
  if (filter?.demandId) {
    where.push(`demand_id = $${String(i++)}`);
    values.push(filter.demandId);
  }
  if (filter?.codebaseId) {
    where.push(`codebase_id = $${String(i++)}`);
    values.push(filter.codebaseId);
  }
  if (filter?.model) {
    where.push(`model = $${String(i++)}`);
    values.push(filter.model);
  }
  if (filter?.sinceDays !== undefined && filter.sinceDays > 0) {
    where.push(`created_at >= NOW() - ($${String(i++)}::int || ' days')::interval`);
    values.push(filter.sinceDays);
  }
  const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(filter?.limit ?? 500, 2000);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_costs ${whereClause}
     ORDER BY created_at DESC
     LIMIT ${String(limit)}`,
    values
  );
  return result.rows.map(toCost);
}

export interface CostSummary {
  total_usd: number;
  total_brl: number;
  runs_count: number;
  cost_rows_count: number;
  tokens_in_total: number;
  tokens_out_total: number;
  window_days: number;
}

export async function getCostSummary(windowDays = 30): Promise<CostSummary> {
  const result = await pool.query<{
    total_usd: string | number;
    total_brl: string | number;
    runs_count: string | number;
    cost_rows_count: string | number;
    tokens_in_total: string | number;
    tokens_out_total: string | number;
  }>(
    `SELECT
       COALESCE(SUM(amount_usd), 0)::numeric AS total_usd,
       COALESCE(SUM(amount_brl), 0)::numeric AS total_brl,
       COUNT(DISTINCT run_id) AS runs_count,
       COUNT(*) AS cost_rows_count,
       COALESCE(SUM(tokens_in), 0) AS tokens_in_total,
       COALESCE(SUM(tokens_out), 0) AS tokens_out_total
     FROM remote_agent_costs
     WHERE created_at >= NOW() - ($1::int || ' days')::interval`,
    [windowDays]
  );
  const row = result.rows[0];
  if (!row) {
    return {
      total_usd: 0,
      total_brl: 0,
      runs_count: 0,
      cost_rows_count: 0,
      tokens_in_total: 0,
      tokens_out_total: 0,
      window_days: windowDays,
    };
  }
  return {
    total_usd: numOrZero(row.total_usd),
    total_brl: numOrZero(row.total_brl),
    runs_count: intOrZero(row.runs_count),
    cost_rows_count: intOrZero(row.cost_rows_count),
    tokens_in_total: intOrZero(row.tokens_in_total),
    tokens_out_total: intOrZero(row.tokens_out_total),
    window_days: windowDays,
  };
}

export interface CostBreakdownEntry {
  key: string;
  amount_usd: number;
  amount_brl: number;
  tokens_in: number;
  tokens_out: number;
  cost_rows_count: number;
}

export interface CostBreakdown {
  by_model: CostBreakdownEntry[];
  by_codebase: CostBreakdownEntry[];
  by_pipeline: CostBreakdownEntry[];
  window_days: number;
}

interface BreakdownRow {
  key: string;
  amount_usd: string | number;
  amount_brl: string | number;
  tokens_in: string | number;
  tokens_out: string | number;
  cost_rows_count: string | number;
}

function mapBreakdown(rows: readonly BreakdownRow[]): CostBreakdownEntry[] {
  return rows.map(r => ({
    key: r.key,
    amount_usd: numOrZero(r.amount_usd),
    amount_brl: numOrZero(r.amount_brl),
    tokens_in: intOrZero(r.tokens_in),
    tokens_out: intOrZero(r.tokens_out),
    cost_rows_count: intOrZero(r.cost_rows_count),
  }));
}

export async function getCostBreakdown(windowDays = 30): Promise<CostBreakdown> {
  // by_model
  const byModelResult = await pool.query<BreakdownRow>(
    `SELECT
       model AS key,
       SUM(amount_usd)::numeric AS amount_usd,
       SUM(amount_brl)::numeric AS amount_brl,
       SUM(tokens_in) AS tokens_in,
       SUM(tokens_out) AS tokens_out,
       COUNT(*) AS cost_rows_count
     FROM remote_agent_costs
     WHERE created_at >= NOW() - ($1::int || ' days')::interval
     GROUP BY model
     ORDER BY amount_usd DESC`,
    [windowDays]
  );

  // by_codebase — join codebases for human-readable name
  const byCodebaseResult = await pool.query<BreakdownRow>(
    `SELECT
       COALESCE(c.name, c.slug, 'sem projeto') AS key,
       SUM(co.amount_usd)::numeric AS amount_usd,
       SUM(co.amount_brl)::numeric AS amount_brl,
       SUM(co.tokens_in) AS tokens_in,
       SUM(co.tokens_out) AS tokens_out,
       COUNT(*) AS cost_rows_count
     FROM remote_agent_costs co
     LEFT JOIN remote_agent_codebases c ON c.id = co.codebase_id
     WHERE co.created_at >= NOW() - ($1::int || ' days')::interval
     GROUP BY c.name, c.slug
     ORDER BY amount_usd DESC`,
    [windowDays]
  );

  // by_pipeline — group by run's pipeline name (joined via workflow_runs)
  const byPipelineResult = await pool.query<BreakdownRow>(
    `SELECT
       COALESCE(wr.workflow_name, 'ad-hoc') AS key,
       SUM(co.amount_usd)::numeric AS amount_usd,
       SUM(co.amount_brl)::numeric AS amount_brl,
       SUM(co.tokens_in) AS tokens_in,
       SUM(co.tokens_out) AS tokens_out,
       COUNT(*) AS cost_rows_count
     FROM remote_agent_costs co
     LEFT JOIN remote_agent_workflow_runs wr ON wr.id = co.run_id
     WHERE co.created_at >= NOW() - ($1::int || ' days')::interval
     GROUP BY wr.workflow_name
     ORDER BY amount_usd DESC`,
    [windowDays]
  );

  return {
    by_model: mapBreakdown(byModelResult.rows),
    by_codebase: mapBreakdown(byCodebaseResult.rows),
    by_pipeline: mapBreakdown(byPipelineResult.rows),
    window_days: windowDays,
  };
}
