/**
 * VOLUND FORGE — demand activities (audit log).
 *
 * Every auditable event that touches a demand is recorded here:
 *   - Status change (manual via API or auto via run hook)
 *   - Priority change
 *   - Workflow run start / complete / fail
 *   - Chat message linked to a demand (FORGE)
 *   - Manual note from a human
 *   - Initial creation
 *
 * This is the single source of truth for "where is each demand and
 * what happened to it". The timeline endpoint joins activities +
 * runs + cost rows + messages into one chronological feed.
 *
 * Schema lives in `migrations/036_demand_audit_trail.sql`.
 */
import { pool, getDatabase } from './connection';
import type { DemandActivityAction } from '@archon/core/schemas';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface DemandActivityRow {
  id: string;
  demand_id: string;
  action: DemandActivityAction;
  from_status: string | null;
  to_status: string | null;
  from_priority: string | null;
  to_priority: string | null;
  run_id: string | null;
  message_id: string | null;
  user_id: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

function toActivity(row: RawRow): DemandActivityRow {
  return {
    id: String(row.id),
    demand_id: String(row.demand_id),
    action: row.action as DemandActivityAction,
    from_status: (row.from_status as string | null) ?? null,
    to_status: (row.to_status as string | null) ?? null,
    from_priority: (row.from_priority as string | null) ?? null,
    to_priority: (row.to_priority as string | null) ?? null,
    run_id: (row.run_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    user_id: (row.user_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    created_at: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------

export interface CreateActivityInput {
  demandId: string;
  action: DemandActivityAction;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromPriority?: string | null;
  toPriority?: string | null;
  runId?: string | null;
  messageId?: string | null;
  userId?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one activity row. Also updates the demand's denormalized
 * last_activity_at / last_run_id / counters so the kanban can show
 * "last touched" without joining.
 */
export async function recordActivity(input: CreateActivityInput): Promise<DemandActivityRow> {
  // The run of inserts (activity + demand summary update) is wrapped
  // in a single transaction so a crash mid-write doesn't leave a
  // status change un-recorded (or vice-versa).
  return getDatabase().withTransaction(async (txQuery): Promise<DemandActivityRow> => {
    const result = await txQuery<RawRow>(
      `INSERT INTO remote_agent_demand_activities (
         demand_id, action, from_status, to_status,
         from_priority, to_priority, run_id, message_id,
         user_id, note, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        input.demandId,
        input.action,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.fromPriority ?? null,
        input.toPriority ?? null,
        input.runId ?? null,
        input.messageId ?? null,
        input.userId ?? null,
        input.note ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    const activity = toActivity(result.rows[0]);

    // Update demand summary columns (denormalized for fast kanban queries)
    const summaryFields: string[] = ['last_activity_at = NOW()'];
    const summaryValues: unknown[] = [];
    let i = 1;
    if (input.runId) {
      summaryFields.push(`last_run_id = $${String(i++)}`);
      summaryValues.push(input.runId);
    }
    if (
      input.action === 'run_completed' ||
      input.action === 'run_failed' ||
      input.action === 'run_started'
    ) {
      summaryFields.push(`last_run_status = $${String(i++)}`);
      summaryValues.push(
        input.action === 'run_completed'
          ? 'succeeded'
          : input.action === 'run_failed'
            ? 'failed'
            : 'running'
      );
    }
    if (
      input.action === 'run_completed' ||
      input.action === 'run_failed' ||
      input.action === 'run_started'
    ) {
      summaryFields.push('runs_count = runs_count + 1');
    }
    if (input.action === 'message') {
      summaryFields.push('messages_count = messages_count + 1');
    }
    await txQuery(
      `UPDATE remote_agent_demands SET ${summaryFields.join(', ')} WHERE id = $${String(i)}`,
      [...summaryValues, input.demandId]
    );

    return activity;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listActivitiesForDemand(
  demandId: string,
  limit = 100
): Promise<DemandActivityRow[]> {
  const result = await pool.query<RawRow>(
    `SELECT * FROM remote_agent_demand_activities
     WHERE demand_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [demandId, limit]
  );
  return result.rows.map(toActivity);
}

export async function listRecentActivities(limit = 50): Promise<DemandActivityRow[]> {
  const result = await pool.query<RawRow>(
    `SELECT * FROM remote_agent_demand_activities
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(toActivity);
}

// ---------------------------------------------------------------------------
// Demand status changes — convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Apply a status change to a demand and log an activity in one shot.
 * Used by:
 *   - The FORGE UI (PATCH /api/forge/demands/:id)
 *   - The auto-move hook (when a workflow run completes or fails)
 */
export async function changeDemandStatus(args: {
  demandId: string;
  toStatus: string;
  userId?: string | null;
  source: 'manual' | 'auto_run_success' | 'auto_run_failed' | 'auto_run_started';
  note?: string;
}): Promise<DemandActivityRow | null> {
  // Look up current status
  const before = await pool.query<RawRow>('SELECT status FROM remote_agent_demands WHERE id = $1', [
    args.demandId,
  ]);
  if (before.rowCount === 0) return null;
  const fromStatus = String(before.rows[0].status);

  if (fromStatus === args.toStatus) {
    // No-op — still log a 'note' so the user knows we saw the request
    return recordActivity({
      demandId: args.demandId,
      action: 'note',
      userId: args.userId ?? null,
      note: args.note ?? `Status already ${fromStatus} (no change)`,
      metadata: { source: args.source, no_op: true },
    });
  }

  // Apply the status change
  await pool.query(
    `UPDATE remote_agent_demands
     SET status = $1, updated_at = NOW()
     WHERE id = $2`,
    [args.toStatus, args.demandId]
  );

  // Log the activity (and bump denormalized counters)
  return recordActivity({
    demandId: args.demandId,
    action: 'status_change',
    fromStatus,
    toStatus: args.toStatus,
    userId: args.userId ?? null,
    note: args.note ?? null,
    metadata: { source: args.source },
  });
}
