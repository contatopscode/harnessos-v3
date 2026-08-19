/**
 * Storage for the Memory system (path B — Memory + RAG).
 *
 * Schema lives in `migrations/025_memory.sql` (SQLite FTS5) and the Postgres
 * adaptation in `deploy/postgres/harnessos-postgres-init.sql` (tsvector +
 * GIN). The query path here is dialect-aware: SQLite uses FTS5 + bm25(),
 * Postgres uses the `content_tsv` column + ts_rank_cd / plainto_tsquery.
 *
 * Append-only in spirit: the row's `content` and `kind` are written once.
 * Edits go through delete + add (a fresh row, fresh `created_at`). The
 * `use_count` and `last_used_at` columns are updated by `bumpMemoryUsage`
 * after a successful recall, so the UI can rank memories by usefulness.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DROP-IN REPLACEMENT for packages/core/src/db/memories.ts
 * ─────────────────────────────────────────────────────────────────────────
 * Apply with:
 *   cp deploy/postgres/memories-postgres-aware.ts \
 *      packages/core/src/db/memories.ts
 * then `bun --filter @archon/core type-check` + run the test suite.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { pool, getDatabaseType } from './connection';
import type { Memory, MemoryKind, MemoryScope } from '../schemas';

// ---------------------------------------------------------------------------
// Row → object mapping
// ---------------------------------------------------------------------------

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    scope_id: (row.scope_id as string | null) ?? null,
    kind: row.kind as MemoryKind,
    content: row.content as string,
    source: row.source as 'chat' | 'manual' | 'imported',
    confidence: Number(row.confidence),
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at as string),
    last_used_at:
      row.last_used_at === null || row.last_used_at === undefined
        ? null
        : row.last_used_at instanceof Date
          ? row.last_used_at.toISOString()
          : (row.last_used_at as string),
    use_count: Number(row.use_count),
  };
}

/** True when DATABASE_URL points at a Postgres instance. SQLite is the
 *  dev default; Postgres is the prod target on Contabo/Easypanel. */
function isPostgres(): boolean {
  return getDatabaseType() === 'postgresql';
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryInsert {
  scope: MemoryScope;
  scopeId?: string | null;
  kind: MemoryKind;
  content: string;
  source?: 'chat' | 'manual' | 'imported';
  confidence?: number;
}

export interface RecallScope {
  scope: MemoryScope;
  scopeId?: string | null;
}

export interface RecallOptions {
  query: string;
  scopes: RecallScope[];
  kind?: MemoryKind;
  limit?: number;
}

export interface ListMemoriesOptions {
  scope?: MemoryScope;
  kind?: MemoryKind;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListMemoriesResult {
  total: number;
  memories: Memory[];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Add a memory. The FTS index is kept in sync by the `memories_ai` trigger
 * (SQLite) or the `memories_tsv_update` BEFORE INSERT trigger (Postgres) —
 * no separate FTS INSERT needed here.
 */
export async function addMemory(insert: MemoryInsert): Promise<Memory> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_memories
       (scope, scope_id, kind, content, source, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, scope, scope_id, kind, content, source, confidence,
               created_at, last_used_at, use_count`,
    [
      insert.scope,
      insert.scopeId ?? null,
      insert.kind,
      insert.content,
      insert.source ?? 'manual',
      insert.confidence ?? 1.0,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('addMemory failed to return row');
  return rowToMemory(row);
}

/**
 * Delete a memory by ID. Returns true if a row was actually removed, false
 * if it didn't exist (or was already deleted). The trigger (FTS5 insert-side
 * on SQLite; tsvector BEFORE UPDATE on Postgres) keeps the index in sync.
 */
export async function deleteMemory(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM remote_agent_memories WHERE id = $1', [id]);
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List memories with optional scope / kind / free-text filters. The free-text
 * filter uses the FTS index — SQLite FTS5 (MATCH) or Postgres tsvector
 * (`@@ plainto_tsquery('simple', $1)`), dialect-detected at call time.
 */
export async function listMemories(options: ListMemoriesOptions = {}): Promise<ListMemoriesResult> {
  const { scope, kind, search, limit = 50, offset = 0 } = options;
  const where: string[] = [];
  const params: unknown[] = [];

  if (scope !== undefined) {
    params.push(scope);
    where.push(`m.scope = $${params.length}`);
  }
  if (kind !== undefined) {
    params.push(kind);
    where.push(`m.kind = $${params.length}`);
  }

  // Free-text filter: dialect-aware. On both adapters the rowid/id-based
  // set is the input to the rest of the query so the page + count SQL stays
  // shared.
  let ftsRowidsOrEmpty: number[] = [];
  let useRowidJoin = false;
  if (search !== undefined && search.trim() !== '') {
    if (isPostgres()) {
      // Postgres path: filter by tsvector match, then join by id (UUID).
      const pgResult = await pool.query<{ id: string }>(
        `SELECT id FROM remote_agent_memories
         WHERE content_tsv @@ plainto_tsquery('simple', $1)
         LIMIT 100`,
        [search.trim()]
      );
      if (pgResult.rows.length === 0) {
        return { total: 0, memories: [] };
      }
      const idClauses = pgResult.rows.map((_, i) => `$${params.length + i + 1}::uuid`).join(',');
      where.push(`m.id IN (${idClauses})`);
      params.push(...pgResult.rows.map(r => r.id));
    } else {
      // SQLite path: FTS5 MATCH on the virtual table, then join by rowid.
      const ftsResult = await pool.query<{ rowid: number }>(
        'SELECT rowid FROM remote_agent_memories_fts WHERE remote_agent_memories_fts MATCH $1 LIMIT 100',
        [search.trim()]
      );
      ftsRowidsOrEmpty = ftsResult.rows.map(r => r.rowid);
      if (ftsRowidsOrEmpty.length === 0) {
        return { total: 0, memories: [] };
      }
      const placeholders = ftsRowidsOrEmpty.map((_, i) => `$${params.length + i + 1}`).join(',');
      where.push(`m.rowid IN (${placeholders})`);
      params.push(...ftsRowidsOrEmpty);
      useRowidJoin = true;
    }
  }
  // Suppress lint about unused marker (kept to make the SQLite branch explicit)
  void useRowidJoin;

  const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

  // Page
  params.push(limit, offset);
  const pageSql = `SELECT m.id, m.scope, m.scope_id, m.kind, m.content, m.source,
                          m.confidence, m.created_at, m.last_used_at, m.use_count
                   FROM remote_agent_memories m
                   ${whereSql}
                   ORDER BY m.created_at DESC
                   LIMIT $${params.length - 1} OFFSET $${params.length}`;

  // Total
  const countParams = params.slice(0, params.length - 2);
  const countSql = `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM remote_agent_memories m ${whereSql}`;

  const [pageResult, countResult] = await Promise.all([
    pool.query<Record<string, unknown>>(pageSql, params),
    pool.query<{ n: number }>(countSql, countParams),
  ]);

  return {
    memories: pageResult.rows.map(rowToMemory),
    total: countResult.rows[0]?.n ?? 0,
  };
}

/**
 * Find memories relevant to a query across multiple scopes. The recall
 * model is "any memory that matches ANY of the requested scopes is
 * eligible; the search index ranks them by relevance to the query".
 *
 * SQLite uses FTS5 + bm25(lower = better); Postgres uses tsvector +
 * ts_rank_cd (higher = better). We normalize both to a 0-1 score where
 * the top hit = 1.0 and no-signal = 0.0 so the UI and orchestrator
 * can stay dialect-agnostic.
 */
export async function recallMemories(options: RecallOptions): Promise<Memory[]> {
  const { query, scopes, kind, limit = 5 } = options;
  if (scopes.length === 0) return [];

  // Scope filter (shared by both dialects)
  const scopeClauses: string[] = [];
  const params: unknown[] = [];
  for (const s of scopes) {
    if (s.scopeId === null || s.scopeId === undefined) {
      params.push(s.scope);
      scopeClauses.push(`(m.scope = $${params.length} AND m.scope_id IS NULL)`);
    } else {
      params.push(s.scope, s.scopeId);
      scopeClauses.push(`(m.scope = $${params.length - 1} AND m.scope_id = $${params.length})`);
    }
  }
  let where = scopeClauses.join(' OR ');
  if (kind !== undefined) {
    params.push(kind);
    where += ` AND m.kind = $${params.length}`;
  }

  // Tokenize for OR-semantics (FTS5 default is AND; we want natural-language
  // ranking). Quote-escape reserved characters (AND, OR, NOT, parens, quotes,
  // colons) so the FTS5 parser doesn't choke. plainto_tsquery on Postgres
  // ignores these by design — same surface area, no surprises either way.
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => {
      const cleaned = t.replace(/[:()"']/g, '');
      return cleaned.length > 0 ? `"${cleaned}"` : null;
    })
    .filter((t): t is string => t !== null);
  const matchQuery = tokens.length > 0 ? tokens.join(' OR ') : '""';

  params.push(matchQuery);
  const matchParam = `$${params.length}`;

  // Dialect-specific rank + filter SQL.
  const sql = isPostgres()
    ? `
    SELECT m.id, m.scope, m.scope_id, m.kind, m.content, m.source,
           m.confidence, m.created_at, m.last_used_at, m.use_count,
           ts_rank_cd(m.content_tsv, plainto_tsquery('simple', ${matchParam})) AS rank_score
    FROM remote_agent_memories m
    WHERE m.content_tsv @@ plainto_tsquery('simple', ${matchParam})
      AND (${where})
    ORDER BY rank_score DESC
    LIMIT $${params.length + 1}
  `
    : `
    SELECT m.id, m.scope, m.scope_id, m.kind, m.content, m.source,
           m.confidence, m.created_at, m.last_used_at, m.use_count,
           bm25(remote_agent_memories_fts) AS rank_score
    FROM remote_agent_memories_fts
    JOIN remote_agent_memories m ON m.rowid = remote_agent_memories_fts.rowid
    WHERE remote_agent_memories_fts MATCH ${matchParam}
      AND (${where})
    ORDER BY rank_score ASC
    LIMIT $${params.length + 1}
  `;
  params.push(Math.max(limit * 4, 20));
  const result = await pool.query<Record<string, unknown> & { rank_score: number }>(sql, params);

  // Normalize to 0-1. SQLite bm25: lower = better (negate). Postgres
  // ts_rank_cd: higher = better (no negate).
  const scores = result.rows.map(r => r.rank_score);
  const minScore = scores.length > 0 ? Math.min(...scores) : 0;
  const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
  const range = maxScore - minScore || 1;
  const normalize = (s: number): number =>
    isPostgres() ? (s - minScore) / range : 1 - (s - minScore) / range;

  const ranked = result.rows
    .map(r => ({ memory: rowToMemory(r), score: normalize(r.rank_score) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Bump usage counters (best-effort, non-fatal). NOW() on Postgres,
  // datetime('now') on SQLite.
  if (ranked.length > 0) {
    try {
      const ids = ranked.map(r => r.memory.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const nowExpr = isPostgres() ? 'NOW()' : "datetime('now')";
      await pool.query(
        `UPDATE remote_agent_memories
            SET use_count = use_count + 1,
                last_used_at = ${nowExpr}
          WHERE id IN (${placeholders})`,
        ids
      );
    } catch {
      // non-fatal
    }
  }

  return ranked.map(r => r.memory);
}

/**
 * Count memories by kind — handy for the Web UI's dashboard.
 */
export async function countMemoriesByKind(): Promise<Record<MemoryKind, number>> {
  const result = await pool.query<{ kind: MemoryKind; n: number }>(
    `SELECT kind, CAST(COUNT(*) AS INTEGER) AS n
       FROM remote_agent_memories
       GROUP BY kind`
  );
  const out: Record<MemoryKind, number> = {
    preference: 0,
    fact: 0,
    project_context: 0,
    feedback: 0,
    note: 0,
  };
  for (const r of result.rows) out[r.kind] = r.n;
  return out;
}
