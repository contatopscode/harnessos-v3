/**
 * VOLUND FORGE — projects (PMO view of codebases).
 *
 * A "project" in the PMO surface is a `remote_agent_codebases` row
 * enriched with PMO counts (open demands, total demands, runs).
 * The FORGE app uses this single endpoint so the UI doesn't have
 * to fan out to /api/codebases + /api/forge/demands + /api/codebase/:id/runs.
 *
 * Open demands = status NOT IN ('concluido', 'cancelado').
 */
import { pool } from './connection';

export interface ProjectSummaryRow {
  id: string;
  /** Derived from codebases.name (no `slug` column exists in codebases). */
  slug: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  status: string;
  default_branch: string | null;
  open_demands: number;
  total_demands: number;
  runs_count: number;
  repository_url: string | null;
}

function toProject(row: Record<string, unknown>): ProjectSummaryRow {
  const name = str(row.name);
  return {
    id: str(row.id),
    // codebases has no `slug` column — synthesize one from the owner/repo name
    // so URLs like /forge/projects/contatopscode-facegate still read nicely.
    slug: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    name,
    client_id: nullableStr(row.client_id),
    client_name: nullableStr(row.client_name),
    status: str(row.status) || 'active',
    default_branch: nullableStr(row.default_branch),
    open_demands: intOrZero(row.open_demands),
    total_demands: intOrZero(row.total_demands),
    runs_count: intOrZero(row.runs_count),
    repository_url: nullableStr(row.repository_url),
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

export async function listProjectsWithCounts(): Promise<ProjectSummaryRow[]> {
  // Subqueries are simpler than LEFT JOIN GROUP BY for an MVP —
  // codebases are a few hundred at most, this is fine.
  // NOTE: codebases has no `slug` column — `name` is the human-facing
  // identifier (usually `owner/repo`). We synthesize a URL-safe `slug`
  // in `toProject` for FORGE UI use.
  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       cb.id,
       cb.name,
       cb.client_id,
       c.name AS client_name,
       cb.kind AS status,
       cb.default_branch,
       cb.repository_url,
       (SELECT COUNT(*) FROM remote_agent_demands d
         WHERE d.codebase_id = cb.id
           AND d.status NOT IN ('concluido', 'cancelado')) AS open_demands,
       (SELECT COUNT(*) FROM remote_agent_demands d
         WHERE d.codebase_id = cb.id) AS total_demands,
       (SELECT COUNT(*) FROM remote_agent_workflow_runs wr
         WHERE wr.codebase_id = cb.id) AS runs_count
     FROM remote_agent_codebases cb
     LEFT JOIN remote_agent_clients c ON c.id = cb.client_id
     ORDER BY cb.name ASC`
  );
  return result.rows.map(toProject);
}

export async function getProjectById(id: string): Promise<ProjectSummaryRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       cb.id,
       cb.name,
       cb.client_id,
       c.name AS client_name,
       cb.kind AS status,
       cb.default_branch,
       cb.repository_url,
       (SELECT COUNT(*) FROM remote_agent_demands d
         WHERE d.codebase_id = cb.id
           AND d.status NOT IN ('concluido', 'cancelado')) AS open_demands,
       (SELECT COUNT(*) FROM remote_agent_demands d
         WHERE d.codebase_id = cb.id) AS total_demands,
       (SELECT COUNT(*) FROM remote_agent_workflow_runs wr
         WHERE wr.codebase_id = cb.id) AS runs_count
     FROM remote_agent_codebases cb
     LEFT JOIN remote_agent_clients c ON c.id = cb.client_id
     WHERE cb.id = $1`,
    [id]
  );
  return result.rows[0] ? toProject(result.rows[0]) : null;
}
