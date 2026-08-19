/**
 * VOLUND FORGE — clients table CRUD.
 *
 * One row per top-level customer / org. A codebase belongs to a client
 * (FK `remote_agent_codebases.client_id`); demands belong to a
 * client (FK `remote_agent_demands.client_id`).
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';

const log = createLogger('db.clients');

export interface ClientRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'archived';
  contact_email: string | null;
  created_at: string;
  updated_at: string;
}

function toClient(row: Record<string, unknown>): ClientRow {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: nullableStr(row.description),
    status: (str(row.status) as ClientRow['status']) ?? 'active',
    contact_email: nullableStr(row.contact_email),
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

export async function listClients(): Promise<ClientRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_clients ORDER BY status ASC, name ASC'
  );
  return result.rows.map(toClient);
}

export async function getClientById(id: string): Promise<ClientRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_clients WHERE id = $1',
    [id]
  );
  return result.rows[0] ? toClient(result.rows[0]) : null;
}

export async function getClientBySlug(slug: string): Promise<ClientRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_clients WHERE slug = $1',
    [slug]
  );
  return result.rows[0] ? toClient(result.rows[0]) : null;
}

export async function createClient(input: {
  slug: string;
  name: string;
  description?: string | null;
  contact_email?: string | null;
}): Promise<ClientRow> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_clients (slug, name, description, contact_email)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.slug, input.name, input.description ?? null, input.contact_email ?? null]
  );
  log.info({ slug: input.slug, name: input.name }, 'client.created');
  return toClient(result.rows[0]);
}

export async function updateClient(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    contact_email?: string | null;
    status?: 'active' | 'inactive' | 'archived';
  }
): Promise<ClientRow | null> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    fields.push(`name = $${String(i++)}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${String(i++)}`);
    values.push(patch.description);
  }
  if (patch.contact_email !== undefined) {
    fields.push(`contact_email = $${String(i++)}`);
    values.push(patch.contact_email);
  }
  if (patch.status !== undefined) {
    fields.push(`status = $${String(i++)}`);
    values.push(patch.status);
  }
  if (fields.length === 0) return getClientById(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE remote_agent_clients SET ${fields.join(', ')} WHERE id = $${String(i)} RETURNING *`,
    values
  );
  return result.rows[0] ? toClient(result.rows[0]) : null;
}

/**
 * Hard-delete a client. Refuses (returns 0) if any codebase or demand
 * still references it — the caller must reparent or delete those first.
 * This is a safety net so `forge/clients/:id DELETE` doesn't accidentally
 * orphan projects.
 */
export async function deleteClient(id: string): Promise<{ deleted: boolean; reason?: string }> {
  const inUse = await pool.query<{ count: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM remote_agent_codebases WHERE client_id = $1)
       +
       (SELECT COUNT(*) FROM remote_agent_demands WHERE client_id = $1)
     )::text AS count`,
    [id]
  );
  if (Number(inUse.rows[0]?.count ?? 0) > 0) {
    return {
      deleted: false,
      reason:
        'Cliente ainda tem projetos ou demandas vinculados. Remova-os antes de excluir o cliente.',
    };
  }
  const result = await pool.query<Record<string, unknown>>(
    'DELETE FROM remote_agent_clients WHERE id = $1 RETURNING id',
    [id]
  );
  if (result.rows[0]) {
    log.info({ clientId: id }, 'client.deleted');
    return { deleted: true };
  }
  return { deleted: false, reason: 'Cliente não encontrado' };
}
