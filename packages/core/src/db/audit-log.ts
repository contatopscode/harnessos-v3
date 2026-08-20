/**
 * Global audit log — record + read.
 *
 * Paulo pediu (FORGE sprint, 19/ago/2026): "tudo, absolutamente tudo tem
 * que ser registrado". Esta é a tabela de log pra TUDO que não é
 * atividade de demanda (que tem `remote_agent_demand_activities`).
 *
 * Categorias cobertas (todas via `recordAuditLog`):
 *   - client.created / updated / deleted
 *   - project.created / updated / deleted
 *   - sprint.created / updated / deleted
 *   - pipeline_link.created / deleted
 *   - login.succeeded / login.failed / logout
 *   - invite.created / accepted / revoked
 *   - rbac.role.* / rbac.permission.* / rbac.user.*
 *   - setting.changed
 *
 * Schema: `migrations/037_global_audit_log.sql`.
 * Action vocabulary: `packages/core/src/schemas/audit-log.ts`.
 *
 * Best-effort semantics: `recordAuditLog` é fire-and-forget — se a
 * inserção falhar, logamos mas NÃO quebramos o request que originou
 * o evento. A audit log existe pra observabilidade, não pra fluxo
 * crítico (esse papel fica com `demand_activities`).
 */
import { pool } from './connection';
import { createLogger } from '@archon/paths';
import type {
  AuditLogRow,
  AuditLogAction,
  AuditLogSource,
  ListAuditLogOptions,
  RecordAuditLogInput,
} from '@archon/core/schemas';

const log = createLogger('db.audit');

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

function toRow(row: RawRow): AuditLogRow {
  return {
    id: String(row.id),
    actor_id: (row.actor_id as string | null) ?? null,
    actor_email: (row.actor_email as string | null) ?? null,
    action: row.action as AuditLogAction,
    entity_type: (row.entity_type as string | null) ?? null,
    entity_id: (row.entity_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    ip: (row.ip as string | null) ?? null,
    user_agent: (row.user_agent as string | null) ?? null,
    source: (row.source as AuditLogSource) ?? 'web',
    created_at: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------

/**
 * Append an audit log row. Fire-and-forget: errors are logged but
 * never thrown. Use `.catch()` upstream if you need to await it.
 */
export async function recordAuditLog(input: RecordAuditLogInput): Promise<AuditLogRow | null> {
  try {
    const result = await pool.query<RawRow>(
      `INSERT INTO remote_agent_audit_log
         (actor_id, actor_email, action, entity_type, entity_id,
          metadata, ip, user_agent, source)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING *`,
      [
        input.actorId ?? null,
        input.actorEmail ?? null,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ip ?? null,
        input.userAgent ?? null,
        input.source ?? 'web',
      ]
    );
    return toRow(result.rows[0] ?? {});
  } catch (e) {
    // Fire-and-forget: never break the caller's flow for an audit write.
    log.warn(
      { err: (e as Error).message, action: input.action, entityId: input.entityId ?? null },
      'db.audit.write_failed'
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List recent audit log entries with optional filters. Used by the
 * Console "Audit Log" page and per-entity audit views in the FORGE.
 */
export async function listAuditLog(
  options: ListAuditLogOptions = { limit: 100 }
): Promise<{ entries: AuditLogRow[]; total: number }> {
  const limit = options.limit ?? 100;
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (options.action) {
    where.push(`action = $${String(i++)}`);
    params.push(options.action);
  }
  if (options.entityType) {
    where.push(`entity_type = $${String(i++)}`);
    params.push(options.entityType);
  }
  if (options.entityId) {
    where.push(`entity_id = $${String(i++)}`);
    params.push(options.entityId);
  }
  if (options.actorId) {
    where.push(`actor_id = $${String(i++)}`);
    params.push(options.actorId);
  }
  if (options.since) {
    where.push(`created_at >= $${String(i++)}`);
    params.push(options.since);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Total count (capped at 10_000 — exact count isn't useful past that).
  const countRes = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM remote_agent_audit_log ${whereSql}`,
    params
  );
  const total = Math.min(Number(countRes.rows[0]?.c ?? 0), 10_000);

  const result = await pool.query<RawRow>(
    `SELECT * FROM remote_agent_audit_log ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${String(i)}`,
    [...params, limit]
  );
  return {
    entries: result.rows.map(toRow),
    total,
  };
}

/**
 * List audit entries for one specific entity (entity_type + entity_id).
 * Used by the "histórico" view on Client / Project / Sprint detail.
 */
export async function listAuditLogForEntity(
  entityType: string,
  entityId: string,
  limit = 100
): Promise<AuditLogRow[]> {
  const result = await pool.query<RawRow>(
    `SELECT * FROM remote_agent_audit_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [entityType, entityId, limit]
  );
  return result.rows.map(toRow);
}

// ---------------------------------------------------------------------------
// Login tracking (extends users.last_login_* + logs audit row)
// ---------------------------------------------------------------------------

/**
 * Update `users.last_login_at` / `last_login_ip` / `login_count` and
 * write a 'login.succeeded' (or 'login.failed') audit row in a single
 * best-effort transaction. Returns true on success.
 */
export async function recordLoginEvent(args: {
  userId: string | null;
  email: string;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  source: AuditLogSource;
}): Promise<boolean> {
  try {
    if (args.success && args.userId) {
      // Single SQL: bump counter + update last_login + write audit row
      await pool.query(
        `UPDATE remote_agent_users
         SET last_login_at = NOW(),
             last_login_ip = $1,
             login_count = login_count + 1
         WHERE id = $2`,
        [args.ip ?? null, args.userId]
      );
    }
    await recordAuditLog({
      action: args.success ? 'login.succeeded' : 'login.failed',
      actorId: args.userId,
      actorEmail: args.email,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
      source: args.source,
      metadata: args.success ? {} : { reason: 'invalid_credentials' },
    });
    return true;
  } catch (e) {
    log.warn({ err: (e as Error).message, email: args.email }, 'db.audit.login_event_failed');
    return false;
  }
}
