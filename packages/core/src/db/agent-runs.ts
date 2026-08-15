/**
 * Storage for the agent routing audit log.
 *
 * Append-only: every routing decision lands one row. The router never
 * updates or deletes existing rows — corrections happen by writing a new
 * decision, not by mutating history. If we ever need to GC, do it by
 * `created_at < NOW() - INTERVAL 'N days'` (separate from any code path
 * that consults the table).
 */
import { pool, getDialect } from './connection';
import type { AgentRun, RoutingDecision } from '../schemas';

// ---------------------------------------------------------------------------
// (no logger needed — pure data in / data out, errors are SQL errors that
// bubble up to the caller, which already logs the routing decision)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Insert shape — same as AgentRun minus the DB-assigned id and created_at.
// ---------------------------------------------------------------------------

export interface AgentRunInsert {
  agentSlug: string;
  conversationId: string | null;
  messageId: string | null;
  decision: RoutingDecision;
  confidence: number;
  reason: string;
  latencyMs: number;
  userMessagePreview: string;
}

// ---------------------------------------------------------------------------
// Row → object mapping
// ---------------------------------------------------------------------------

function rowToRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    agent_slug: row.agent_slug as string,
    conversation_id: (row.conversation_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    decision: row.decision as RoutingDecision,
    confidence: Number(row.confidence),
    reason: row.reason as string,
    latency_ms: Number(row.latency_ms),
    user_message_preview: row.user_message_preview as string,
    created_at:
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// Writes (append-only)
// ---------------------------------------------------------------------------

/**
 * Record a routing decision. The orchestrator calls this AFTER a successful
 * route — never on error paths, so the audit reflects what actually happened,
 * not what was tried.
 */
export async function recordAgentRun(insert: AgentRunInsert): Promise<AgentRun> {
  const dialect = getDialect();
  const id = dialect.generateUuid();

  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_agent_runs (
       id, agent_slug, conversation_id, message_id,
       decision, confidence, reason, latency_ms, user_message_preview
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, agent_slug, conversation_id, message_id,
               decision, confidence, reason, latency_ms,
               user_message_preview, created_at`,
    [
      id,
      insert.agentSlug,
      insert.conversationId,
      insert.messageId,
      insert.decision,
      insert.confidence,
      insert.reason,
      insert.latencyMs,
      insert.userMessagePreview,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('recordAgentRun failed to return row');
  }
  return rowToRun(row);
}

// ---------------------------------------------------------------------------
// Reads (used by the future `archon agent runs` CLI and the Console UI page)
// ---------------------------------------------------------------------------

export interface ListAgentRunsOptions {
  agentSlug?: string;
  conversationId?: string;
  limit?: number;
  offset?: number;
}

export interface ListAgentRunsResult {
  runs: AgentRun[];
  total: number;
}

export async function listAgentRuns(
  options: ListAgentRunsOptions = {}
): Promise<ListAgentRunsResult> {
  const { agentSlug, conversationId, limit = 50, offset = 0 } = options;
  const where: string[] = [];
  const params: unknown[] = [];
  if (agentSlug) {
    params.push(agentSlug);
    where.push(`agent_slug = $${params.length}`);
  }
  if (conversationId) {
    params.push(conversationId);
    where.push(`conversation_id = $${params.length}`);
  }
  const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

  const [pageResult, countResult] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT id, agent_slug, conversation_id, message_id,
              decision, confidence, reason, latency_ms,
              user_message_preview, created_at
       FROM remote_agent_agent_runs ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query<{ total: number }>(
      `SELECT CAST(COUNT(*) AS INTEGER) AS total FROM remote_agent_agent_runs ${whereSql}`,
      params
    ),
  ]);

  return {
    runs: pageResult.rows.map(rowToRun),
    total: countResult.rows[0]?.total ?? 0,
  };
}

/**
 * Count how many times each agent has been routed to in the last `hours`.
 * Used by the future "most-used agent" widget on the Console dashboard.
 */
export async function topRoutedAgents(
  hours = 24,
  limit = 5
): Promise<{ slug: string; count: number }[]> {
  const dialect = getDialect();
  const result = await pool.query<{ agent_slug: string; count: number }>(
    `SELECT agent_slug, CAST(COUNT(*) AS INTEGER) AS count
     FROM remote_agent_agent_runs
     WHERE created_at > ${dialect.nowMinusHours(1)}
     GROUP BY agent_slug
     ORDER BY count DESC
     LIMIT $2`,
    [hours, limit]
  );
  return result.rows.map(r => ({ slug: r.agent_slug, count: r.count }));
}
