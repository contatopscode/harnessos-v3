/**
 * VOLUND FORGE — demand ↔ pipeline links (m:n bridge).
 *
 * A demand can be linked to one or more HarnessOS workflow
 * pipelines (e.g. `fsw`, `vigília`, `planejador-viagem`). The kanban
 * UI uses the link list to render the pipeline chips under each
 * card. A pipeline can serve multiple demands if it's a reusable
 * workflow.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';

const log = createLogger('db.demand-pipeline-links');

export interface DemandPipelineLinkRow {
  id: string;
  demand_id: string;
  pipeline: string;
  pipeline_version: string | null;
  notes: string | null;
  created_at: string;
}

function toLink(row: Record<string, unknown>): DemandPipelineLinkRow {
  return {
    id: str(row.id),
    demand_id: str(row.demand_id),
    pipeline: str(row.pipeline),
    pipeline_version: nullableStr(row.pipeline_version),
    notes: nullableStr(row.notes),
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

export async function listLinksForDemand(demandId: string): Promise<DemandPipelineLinkRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_demand_pipeline_links
     WHERE demand_id = $1
     ORDER BY created_at DESC`,
    [demandId]
  );
  return result.rows.map(toLink);
}

export async function listDemandsForPipeline(
  pipeline: string,
  pipelineVersion?: string | null
): Promise<DemandPipelineLinkRow[]> {
  const where: string[] = ['pipeline = $1'];
  const values: unknown[] = [pipeline];
  if (pipelineVersion !== undefined) {
    where.push('pipeline_version = $2');
    values.push(pipelineVersion);
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_demand_pipeline_links
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC`,
    values
  );
  return result.rows.map(toLink);
}

export async function createLink(input: {
  demandId: string;
  pipeline: string;
  pipelineVersion?: string | null;
  notes?: string | null;
}): Promise<DemandPipelineLinkRow> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_demand_pipeline_links
       (demand_id, pipeline, pipeline_version, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (demand_id, pipeline, pipeline_version) DO UPDATE
       SET notes = COALESCE(EXCLUDED.notes, remote_agent_demand_pipeline_links.notes)
     RETURNING *`,
    [input.demandId, input.pipeline, input.pipelineVersion ?? null, input.notes ?? null]
  );
  log.info(
    { demandId: input.demandId, pipeline: input.pipeline, version: input.pipelineVersion ?? null },
    'demand_pipeline_link.upserted'
  );
  return toLink(result.rows[0]);
}

export async function deleteLink(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM remote_agent_demand_pipeline_links WHERE id = $1', [
    id,
  ]);
  return result.rowCount !== null && result.rowCount > 0;
}

export async function deleteLinksForDemand(demandId: string): Promise<number> {
  const result = await pool.query(
    'DELETE FROM remote_agent_demand_pipeline_links WHERE demand_id = $1',
    [demandId]
  );
  return result.rowCount ?? 0;
}
