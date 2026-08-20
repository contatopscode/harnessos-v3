/**
 * VOLUND FORGE — demands (kanban cards) CRUD + board projection.
 *
 * A demand is the central work unit. The PMO kanban groups by
 * `status` (backlog / triagem / requisitos / aprovacao_cliente /
 * em_andamento / concluido / cancelado). The board endpoint
 * returns columns pre-sorted for the UI.
 *
 * Metadata is JSONB. Use it for: assignee, labels, sprint_id,
 * custom fields. Keeping it JSONB avoids schema churn when the
 * PMO UI evolves.
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';
import { listClients } from './clients';

const log = createLogger('db.demands');

export type DemandStatus =
  | 'backlog'
  | 'triagem'
  | 'requisitos'
  | 'aprovacao_cliente'
  | 'em_andamento'
  | 'bloqueada' // auto-set when a workflow run fails (migrations/036)
  | 'concluido'
  | 'cancelado';

export type DemandPriority = 'baixa' | 'media' | 'alta' | 'urgente';

export interface DemandRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  client_id: string;
  codebase_id: string | null;
  status: DemandStatus;
  priority: DemandPriority;
  metadata: Record<string, unknown>;
  due_date: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  // Audit-trail denormalized summary (migrations/036)
  last_activity_at: string | null;
  last_run_id: string | null;
  last_run_status: string | null;
  runs_count: number;
  messages_count: number;
}

function toDemand(row: Record<string, unknown>): DemandRow {
  return {
    id: str(row.id),
    slug: str(row.slug),
    title: str(row.title),
    description: nullableStr(row.description),
    client_id: str(row.client_id),
    codebase_id: nullableStr(row.codebase_id),
    status: (str(row.status) as DemandStatus) ?? 'backlog',
    priority: (str(row.priority) as DemandPriority) ?? 'media',
    metadata: isObject(row.metadata) ? row.metadata : {},
    due_date: nullableStr(row.due_date),
    created_by_user_id: nullableStr(row.created_by_user_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    last_activity_at: nullableStr(row.last_activity_at),
    last_run_id: nullableStr(row.last_run_id),
    last_run_status: nullableStr(row.last_run_status),
    runs_count: typeof row.runs_count === 'number' ? row.runs_count : 0,
    messages_count: typeof row.messages_count === 'number' ? row.messages_count : 0,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function listDemands(filter?: {
  clientId?: string;
  codebaseId?: string;
  status?: DemandStatus;
  search?: string;
  limit?: number;
}): Promise<DemandRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filter?.clientId) {
    where.push(`client_id = $${String(i++)}`);
    values.push(filter.clientId);
  }
  if (filter?.codebaseId) {
    where.push(`codebase_id = $${String(i++)}`);
    values.push(filter.codebaseId);
  }
  if (filter?.status) {
    where.push(`status = $${String(i++)}`);
    values.push(filter.status);
  }
  if (filter?.search) {
    where.push(`(slug ILIKE $${String(i)} OR title ILIKE $${String(i)})`);
    values.push(`%${filter.search}%`);
    i++;
  }
  const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const limitClause = filter?.limit ? `LIMIT $${String(i++)}` : '';
  if (filter?.limit) {
    values.push(filter.limit);
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_demands ${whereClause} ORDER BY priority DESC, created_at DESC ${limitClause}`,
    values
  );
  return result.rows.map(toDemand);
}

export async function getDemandById(id: string): Promise<DemandRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_demands WHERE id = $1',
    [id]
  );
  return result.rows[0] ? toDemand(result.rows[0]) : null;
}

export async function getDemandBySlug(slug: string): Promise<DemandRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_demands WHERE slug = $1',
    [slug]
  );
  return result.rows[0] ? toDemand(result.rows[0]) : null;
}

export async function createDemand(input: {
  slug: string;
  title: string;
  clientId: string;
  description?: string | null;
  codebaseId?: string | null;
  priority?: DemandPriority;
  dueDate?: string | null;
  metadata?: Record<string, unknown>;
  createdByUserId?: string | null;
}): Promise<DemandRow> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_demands
       (slug, title, description, client_id, codebase_id, priority, due_date, metadata, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING *`,
    [
      input.slug,
      input.title,
      input.description ?? null,
      input.clientId,
      input.codebaseId ?? null,
      input.priority ?? 'media',
      input.dueDate ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdByUserId ?? null,
    ]
  );
  log.info({ slug: input.slug, clientId: input.clientId, title: input.title }, 'demand.created');
  return toDemand(result.rows[0]);
}

export async function updateDemand(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    status?: DemandStatus;
    priority?: DemandPriority;
    codebaseId?: string | null;
    dueDate?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<DemandRow | null> {
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
  if (patch.codebaseId !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(patch.codebaseId);
  }
  if (patch.dueDate !== undefined) {
    fields.push(`due_date = $${String(i++)}`);
    values.push(patch.dueDate);
  }
  if (patch.metadata !== undefined) {
    fields.push(`metadata = $${String(i++)}::jsonb`);
    values.push(JSON.stringify(patch.metadata));
  }
  if (fields.length === 0) return getDemandById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE remote_agent_demands SET ${fields.join(', ')} WHERE id = $${String(i)} RETURNING *`,
    values
  );
  return result.rows[0] ? toDemand(result.rows[0]) : null;
}

/**
 * Kanban board payload — the column order matches the UI's
 * left-to-right reading order. Demands within a column are sorted
 * by priority DESC then created_at DESC (matches listDemands).
 */
export async function listDemandsAsBoard(filter?: {
  clientId?: string;
  codebaseId?: string;
  search?: string;
}): Promise<{
  columns: { status: DemandStatus; demands: DemandRow[] }[];
  total: number;
}> {
  const demands = await listDemands(filter);
  const order: DemandStatus[] = [
    'backlog',
    'triagem',
    'requisitos',
    'aprovacao_cliente',
    'em_andamento',
    'concluido',
    'cancelado',
  ];
  const columns = order.map(status => ({
    status,
    demands: demands.filter(d => d.status === status),
  }));
  return { columns, total: demands.length };
}

/**
 * Convenience: ensures the default client exists. Called by the
 * `seedRbac`/seed flow so migration 031's backfill always resolves.
 */
export async function ensureDefaultClient(): Promise<void> {
  const clients = await listClients();
  if (clients.some(c => c.slug === 'default')) return;
  log.warn('default client missing — creating it now');
  await pool.query(
    `INSERT INTO remote_agent_clients (slug, name, description)
     VALUES ('default', 'Default', 'Auto-created fallback client.')`
  );
}
