/**
 * Storage for the Memory system (path B — Memory + RAG).
 *
 * Schema lives in `migrations/025_memory.sql` and the SQLite adapter's
 * inline `createSchema()` (see packages/core/src/db/adapters/sqlite.ts).
 * Search uses SQLite FTS5 with the porter + unicode61 tokenizer — no
 * external embedding service required.
 *
 * Append-only in spirit: the row's `content` and `kind` are written once.
 * Edits go through delete + add (a fresh row, fresh `created_at`). The
 * `use_count` and `last_used_at` columns are updated by `bumpMemoryUsage`
 * after a successful recall, so the UI can rank memories by usefulness.
 */
import { getDatabaseType, pool } from './connection';
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
 * declared in the migration — no separate FTS INSERT needed here.
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
 * if it didn't exist (or was already deleted). The `memories_ad` trigger
 * cleans up the FTS index automatically.
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
 * filter uses the FTS5 index (SQLite) or tsvector @@ to_tsquery (Postgres).
 * Total count comes from a separate aggregate (same pattern as the agents /
 * runs listings).
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

  // Free-text filter: SQLite uses FTS5 MATCH; Postgres uses tsvector @@
  // to_tsquery on the auto-maintained content_tsv column. Same contract
  // (return matching rows in the same order the caller would expect).
  const isPg = getDatabaseType() === 'postgresql';
  if (search !== undefined && search.trim() !== '') {
    const tokens = search
      .trim()
      .split(/\s+/)
      .map(t => t.replace(/[:()"']/g, ''))
      .filter(t => t.length > 0);
    if (tokens.length === 0) {
      return { total: 0, memories: [] };
    }
    if (isPg) {
      const tsQuery = tokens.join(' | ');
      params.push(tsQuery);
      where.push(`m.content_tsv @@ to_tsquery('simple', $${params.length})`);
    } else {
      const matchQuery = tokens.map(t => `"${t}"`).join(' OR ');
      params.push(matchQuery);
      const ftsResult = await pool.query<{ rowid: number }>(
        'SELECT rowid FROM remote_agent_memories_fts WHERE remote_agent_memories_fts MATCH $1 LIMIT 100',
        [matchQuery]
      );
      const ftsIds = ftsResult.rows.map(r => r.rowid);
      if (ftsIds.length === 0) {
        return { total: 0, memories: [] };
      }
      const placeholders = ftsIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      where.push(`m.rowid IN (${placeholders})`);
      params.push(...ftsIds);
    }
  }

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
 * eligible; FTS5 ranks them by relevance to the query". This mirrors how
 * the orchestrator needs memories in practice — a project fact should
 * still come up when the user chats about that project from any
 * conversation or with any agent persona.
 *
 * Uses the FTS5 `bm25` ranking function — lower scores are more relevant
 * (the convention for `bm25`). We negate the score so callers see a
 * standard "higher = better" confidence number in the 0-1 range.
 *
 * Side effect: bumps `use_count` and `last_used_at` on the returned rows
 * via a single UPDATE so future queries can rank by usefulness.
 */
export async function recallMemories(options: RecallOptions): Promise<Memory[]> {
  const { query, scopes, kind, limit = 5 } = options;
  if (scopes.length === 0) return [];

  // Build a WHERE clause that matches the FTS results against any of the
  // requested scopes. If `kind` is set, also filter by it.
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

  // Two backend paths: SQLite uses FTS5 with bm25 ranking; Postgres uses
  // tsvector + GIN. Same contract (rows scored 0-1) but the SQL and ranking
  // differ. Branching on getDatabaseType() avoids loading a driver-specific
  // module in the wrong runtime and keeps the upsert trigger migration
  // (which creates the FTS5 virtual table) untouched.
  const isPg = getDatabaseType() === 'postgresql';

  // Tokenize the query and OR the tokens together (AND would over-filter
  // natural-language queries that mix stopwords with signal words). For
  // FTS5 we quote-escape each token to keep the query parser happy. For PG
  // we feed the same tokens to plainto_tsquery / to_tsquery which already
  // handles the escaping for us.
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.replace(/[:()"']/g, ''))
    .filter(t => t.length > 0);

  if (tokens.length === 0) return [];

  let result: { rows: readonly (Record<string, unknown> & { rank_score: number })[] };

  if (isPg) {
    // Postgres: content_tsv is a generated tsvector column (kept in sync by
    // a trigger in 000_combined.sql). We rank with ts_rank which returns
    // 0-1 floats (higher = better), so no min/max normalization is needed —
    // we just pass rank_score through as 0-1. The `:tsquery` placeholder
    // uses `to_tsquery` with OR-joined tokens; to_tsquery understands
    // 'token1 | token2' syntax.
    const tsQuery = tokens.map(t => t).join(' | ');
    params.push(tsQuery);
    params.push(Math.max(limit * 4, 20));
    const sql = `
      SELECT m.id, m.scope, m.scope_id, m.kind, m.content, m.source,
             m.confidence, m.created_at, m.last_used_at, m.use_count,
             ts_rank(m.content_tsv, to_tsquery('simple', $${params.length - 1})) AS rank_score
      FROM remote_agent_memories m
      WHERE m.content_tsv @@ to_tsquery('simple', $${params.length - 1})
        AND (${where})
      ORDER BY rank_score DESC
      LIMIT $${params.length}
    `;
    result = await pool.query<Record<string, unknown> & { rank_score: number }>(sql, params);
  } else {
    // SQLite: FTS5 virtual table + bm25 ranking (lower is better).
    const matchQuery = tokens.map(t => `"${t}"`).join(' OR ');
    params.push(matchQuery);
    const matchParam = `$${params.length}`;
    const sql = `
      SELECT m.id, m.scope, m.scope_id, m.kind, m.content, m.source,
             m.confidence, m.created_at, m.last_used_at, m.use_count,
             bm25(remote_agent_memories_fts) AS bm25_score
      FROM remote_agent_memories_fts
      JOIN remote_agent_memories m ON m.rowid = remote_agent_memories_fts.rowid
      WHERE remote_agent_memories_fts MATCH ${matchParam}
        AND (${where})
      ORDER BY bm25_score ASC
      LIMIT $${params.length + 1}
    `;
    params.push(Math.max(limit * 4, 20));
    const rawResult = await pool.query<Record<string, unknown> & { bm25_score: number }>(
      sql,
      params
    );
    // Normalize bm25 (negative = better) to a 0-1 score so the rest of the
    // pipeline (which already handled this format) keeps working unchanged.
    const scores = rawResult.rows.map(r => r.bm25_score);
    const minScore = scores.length > 0 ? Math.min(...scores) : 0;
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
    const range = maxScore - minScore || 1;
    result = {
      rows: rawResult.rows.map(r => ({
        ...r,
        rank_score: 1 - (r.bm25_score - minScore) / range,
      })),
    };
  }

  // Both branches now expose `rank_score` (0-1, higher = better) on each
  // row. PG's ts_rank returns native 0-1; SQLite's bm25 was normalized
  // above. We just sort and trim.
  const ranked = result.rows
    .map(r => ({
      memory: rowToMemory(r),
      score: r.rank_score,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Bump usage counters so the UI can rank by usefulness later. Best-effort:
  // a failure here is non-fatal (the recall already returned the rows).
  if (ranked.length > 0) {
    try {
      const ids = ranked.map(r => r.memory.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(
        `UPDATE remote_agent_memories
            SET use_count = use_count + 1,
                last_used_at = datetime('now')
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
