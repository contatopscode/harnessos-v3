/**
 * VOLUND FORGE — sprints CRUD.
 *
 * A sprint is a time-boxed commitment window per client. Demands
 * reference a sprint through `metadata.sprint_id` (JSONB lookup)
 * — there's no FK column, by design, so backlog demands without a
 * sprint are a valid state.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';

const log = createLogger('db.sprints');

export type SprintStatus = 'planejado' | 'em_andamento' | 'concluido' | 'cancelado';

export interface SprintRow {
  id: string;
  client_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: SprintStatus;
  goal: string | null;
  created_at: string;
  updated_at: string;
}

function toSprint(row: Record<string, unknown>): SprintRow {
  return {
    id: str(row.id),
    client_id: str(row.client_id),
    name: str(row.name),
    start_date: str(row.start_date),
    end_date: str(row.end_date),
    status: (str(row.status) as SprintStatus) ?? 'planejado',
    goal: nullableStr(row.goal),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
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

export async function listSprints(filter?: { clientId?: string }): Promise<SprintRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filter?.clientId) {
    where.push(`client_id = $${String(i++)}`);
    values.push(filter.clientId);
  }
  const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_sprints ${whereClause} ORDER BY start_date DESC`,
    values
  );
  return result.rows.map(toSprint);
}

export async function getSprintById(id: string): Promise<SprintRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_sprints WHERE id = $1',
    [id]
  );
  return result.rows[0] ? toSprint(result.rows[0]) : null;
}

export async function createSprint(input: {
  clientId: string;
  name: string;
  startDate: string;
  endDate: string;
  status?: SprintStatus;
  goal?: string | null;
}): Promise<SprintRow> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_sprints
       (client_id, name, start_date, end_date, status, goal)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.clientId,
      input.name,
      input.startDate,
      input.endDate,
      input.status ?? 'planejado',
      input.goal ?? null,
    ]
  );
  log.info(
    { name: input.name, clientId: input.clientId, startDate: input.startDate },
    'sprint.created'
  );
  return toSprint(result.rows[0]);
}

export async function updateSprint(
  id: string,
  patch: {
    name?: string;
    startDate?: string;
    endDate?: string;
    status?: SprintStatus;
    goal?: string | null;
  }
): Promise<SprintRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    fields.push(`name = $${String(i++)}`);
    values.push(patch.name);
  }
  if (patch.startDate !== undefined) {
    fields.push(`start_date = $${String(i++)}`);
    values.push(patch.startDate);
  }
  if (patch.endDate !== undefined) {
    fields.push(`end_date = $${String(i++)}`);
    values.push(patch.endDate);
  }
  if (patch.status !== undefined) {
    fields.push(`status = $${String(i++)}`);
    values.push(patch.status);
  }
  if (patch.goal !== undefined) {
    fields.push(`goal = $${String(i++)}`);
    values.push(patch.goal);
  }
  if (fields.length === 0) return getSprintById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE remote_agent_sprints SET ${fields.join(', ')} WHERE id = $${String(i)} RETURNING *`,
    values
  );
  return result.rows[0] ? toSprint(result.rows[0]) : null;
}
