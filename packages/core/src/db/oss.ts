/**
 * VOLUND FORGE — OS's (Ordens de Serviço) CRUD.
 *
 * An OS is a sub-task within a demand. It can be assigned to a
 * user and tracks its own status + estimated/actual hours. The
 * demand detail page shows the OS list as a tab ("OS's (N)").
 *
 * When status transitions to 'concluida' we auto-stamp
 * `completed_at = NOW()` so the PMO UI can sort finished work
 * without needing a separate update call.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';

const log = createLogger('db.oss');

export type OsStatus = 'pendente' | 'em_andamento' | 'concluida' | 'cancelada' | 'bloqueada';
export type OsPriority = 'baixa' | 'media' | 'alta' | 'urgente';

export interface OsRow {
  id: string;
  demand_id: string;
  title: string;
  description: string | null;
  status: OsStatus;
  priority: OsPriority;
  assignee_user_id: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function toOs(row: Record<string, unknown>): OsRow {
  return {
    id: str(row.id),
    demand_id: str(row.demand_id),
    title: str(row.title),
    description: nullableStr(row.description),
    status: (str(row.status) as OsStatus) ?? 'pendente',
    priority: (str(row.priority) as OsPriority) ?? 'media',
    assignee_user_id: nullableStr(row.assignee_user_id),
    estimated_hours: numOrNull(row.estimated_hours),
    actual_hours: numOrNull(row.actual_hours),
    due_date: nullableStr(row.due_date),
    completed_at: nullableStr(row.completed_at),
    metadata: isObject(row.metadata) ? row.metadata : {},
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

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function listOss(filter?: {
  demandId?: string;
  status?: OsStatus;
  assigneeUserId?: string;
}): Promise<OsRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filter?.demandId) {
    where.push(`demand_id = $${String(i++)}`);
    values.push(filter.demandId);
  }
  if (filter?.status) {
    where.push(`status = $${String(i++)}`);
    values.push(filter.status);
  }
  if (filter?.assigneeUserId) {
    where.push(`assignee_user_id = $${String(i++)}`);
    values.push(filter.assigneeUserId);
  }
  const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_oss ${whereClause} ORDER BY priority DESC, created_at DESC`,
    values
  );
  return result.rows.map(toOs);
}

export async function getOsById(id: string): Promise<OsRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_oss WHERE id = $1',
    [id]
  );
  return result.rows[0] ? toOs(result.rows[0]) : null;
}

export async function createOs(input: {
  demandId: string;
  title: string;
  description?: string | null;
  status?: OsStatus;
  priority?: OsPriority;
  assigneeUserId?: string | null;
  estimatedHours?: number | null;
  dueDate?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<OsRow> {
  const status = input.status ?? 'pendente';
  // Auto-stamp completed_at on initial creation if status is 'concluida'
  const completedAt = status === 'concluida' ? new Date().toISOString() : null;
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_oss
       (demand_id, title, description, status, priority, assignee_user_id,
        estimated_hours, due_date, completed_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      input.demandId,
      input.title,
      input.description ?? null,
      status,
      input.priority ?? 'media',
      input.assigneeUserId ?? null,
      input.estimatedHours ?? null,
      input.dueDate ?? null,
      completedAt,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  log.info({ demandId: input.demandId, title: input.title, status }, 'os.created');
  return toOs(result.rows[0]);
}

export async function updateOs(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    status?: OsStatus;
    priority?: OsPriority;
    assigneeUserId?: string | null;
    estimatedHours?: number | null;
    actualHours?: number | null;
    dueDate?: string | null;
    completedAt?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<OsRow | null> {
  // Auto-stamp completed_at on transition to 'concluida' unless caller
  // provided an explicit value. Symmetric: explicit null clears it.
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.title !== undefined) {
    fields.push(`title = $${String(i++)}`);
    values.push(patch.title);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${String(i++)}`);
    values.push(patch.description);
  }
  if (patch.status !== undefined) {
    fields.push(`status = $${String(i++)}`);
    values.push(patch.status);
  }
  if (patch.priority !== undefined) {
    fields.push(`priority = $${String(i++)}`);
    values.push(patch.priority);
  }
  if (patch.assigneeUserId !== undefined) {
    fields.push(`assignee_user_id = $${String(i++)}`);
    values.push(patch.assigneeUserId);
  }
  if (patch.estimatedHours !== undefined) {
    fields.push(`estimated_hours = $${String(i++)}`);
    values.push(patch.estimatedHours);
  }
  if (patch.actualHours !== undefined) {
    fields.push(`actual_hours = $${String(i++)}`);
    values.push(patch.actualHours);
  }
  if (patch.dueDate !== undefined) {
    fields.push(`due_date = $${String(i++)}`);
    values.push(patch.dueDate);
  }
  if (patch.completedAt !== undefined) {
    fields.push(`completed_at = $${String(i++)}`);
    values.push(patch.completedAt);
  } else if (patch.status !== undefined) {
    if (patch.status === 'concluida') {
      // Auto-stamp on transition to 'concluida'
      fields.push('completed_at = COALESCE(completed_at, NOW())');
    } else {
      // Clear stamp when transitioning away from 'concluida'
      fields.push('completed_at = NULL');
    }
  }
  if (patch.metadata !== undefined) {
    fields.push(`metadata = $${String(i++)}::jsonb`);
    values.push(JSON.stringify(patch.metadata));
  }
  if (fields.length === 0) return getOsById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE remote_agent_oss SET ${fields.join(', ')} WHERE id = $${String(i)} RETURNING *`,
    values
  );
  return result.rows[0] ? toOs(result.rows[0]) : null;
}

export async function deleteOs(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM remote_agent_oss WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}
