/**
 * Storage for installed agents (bundled + local + installed from registry).
 *
 * JSON-as-TEXT columns (`tags_json`, `keywords_json`, `examples_json`,
 * `allowed_tools_json`, `definition_json`) are serialized on write and
 * parsed on read, so SQLite and Postgres behave identically. The store does
 * not validate field shapes — the schema (agentDefinitionSchema) is the
 * authority; the DB just stores strings.
 */
import { pool, getDialect } from './connection';
import {
  type Agent,
  type AgentSource,
  type ListAgentsOptions,
  type ListAgentsResult,
} from '../schemas';

// ---------------------------------------------------------------------------
// (no logger needed — pure data in / data out, errors are SQL errors that
// bubble up to the caller, which already logs the routing decision)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Insert shape — same as Agent minus the DB-assigned fields (id, timestamps).
// Used by both the bundled bootstrap and the future `archon agent install`
// CLI path.
// ---------------------------------------------------------------------------

export interface AgentInsert {
  slug: string;
  name: string;
  source: AgentSource;
  version: string;
  description: string;
  systemPrompt: string;
  tags: string[];
  keywords: string[];
  examples: string[];
  allowedTools: string[];
  model: string | null;
  memoryRef: string | null;
  author: string | null;
  definitionYaml: string;
  definition: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Row → object mapping. Centralised so the field renames live in one place.
// ---------------------------------------------------------------------------

const AGENT_COLUMNS =
  'id, slug, name, source, version, description, system_prompt, ' +
  'tags_json, keywords_json, examples_json, allowed_tools_json, ' +
  'model, memory_ref, author, definition_yaml, definition_json, ' +
  'installed_at, updated_at';

/**
 * Read an agent row into the canonical `Agent` object shape.
 * Date columns are coerced to JS Date (the driver returns strings on SQLite).
 */
function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    source: row.source as AgentSource,
    version: row.version as string,
    description: row.description as string,
    system_prompt: row.system_prompt as string,
    tags_json: row.tags_json as string,
    keywords_json: row.keywords_json as string,
    examples_json: row.examples_json as string,
    allowed_tools_json: row.allowed_tools_json as string,
    model: (row.model as string | null) ?? null,
    memory_ref: (row.memory_ref as string | null) ?? null,
    author: (row.author as string | null) ?? null,
    definition_yaml: row.definition_yaml as string,
    definition_json: row.definition_json as string,
    installed_at:
      row.installed_at instanceof Date ? row.installed_at : new Date(row.installed_at as string),
    updated_at:
      row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAgentBySlug(slug: string): Promise<Agent | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${AGENT_COLUMNS} FROM remote_agent_agents WHERE slug = $1`,
    [slug]
  );
  const row = result.rows[0];
  return row ? rowToAgent(row) : null;
}

export async function listAgents(options: ListAgentsOptions): Promise<ListAgentsResult> {
  const { source, search, limit, offset } = options;
  const where: string[] = [];
  const params: unknown[] = [];
  if (source) {
    params.push(source);
    where.push(`source = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`(LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`);
  }
  const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

  // Page
  params.push(limit, offset);
  const pageSql = `SELECT ${AGENT_COLUMNS} FROM remote_agent_agents ${whereSql}
    ORDER BY source ASC, name ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  // Counts (run a single aggregate per source — same pattern as workflow_runs
  // listing because SQLite doesn't have FILTER). Avoids the cost of fetching
  // all rows just to count them. CAST(... AS INTEGER) is portable SQL that
  // works on both SQLite and Postgres; the `::int` shorthand is Postgres-only.
  const countParams = params.slice(0, params.length - 2);
  const countSql = `SELECT source, CAST(COUNT(*) AS INTEGER) AS n FROM remote_agent_agents
    ${whereSql}
    GROUP BY source`;

  const [pageResult, countResult] = await Promise.all([
    pool.query<Record<string, unknown>>(pageSql, params),
    pool.query<{ source: AgentSource; n: number }>(countSql, countParams),
  ]);

  const counts = { all: 0, bundled: 0, local: 0, installed: 0 };
  for (const r of countResult.rows) counts[r.source] = r.n;
  counts.all = counts.bundled + counts.local + counts.installed;

  return {
    agents: pageResult.rows.map(rowToAgent),
    total: counts.all,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Upsert by slug. On conflict (same slug already installed) the row is
 * replaced atomically — this is what the bundled bootstrap uses to re-seed
 * the table on every server boot. `installed_at` is preserved on update so
 * we can tell when the row was first installed vs last edited.
 */
export async function upsertAgent(insert: AgentInsert): Promise<Agent> {
  const dialect = getDialect();
  const id = dialect.generateUuid();

  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO remote_agent_agents (
       id, slug, name, source, version, description, system_prompt,
       tags_json, keywords_json, examples_json, allowed_tools_json,
       model, memory_ref, author, definition_yaml, definition_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, $16
     )
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       source = EXCLUDED.source,
       version = EXCLUDED.version,
       description = EXCLUDED.description,
       system_prompt = EXCLUDED.system_prompt,
       tags_json = EXCLUDED.tags_json,
       keywords_json = EXCLUDED.keywords_json,
       examples_json = EXCLUDED.examples_json,
       allowed_tools_json = EXCLUDED.allowed_tools_json,
       model = EXCLUDED.model,
       memory_ref = EXCLUDED.memory_ref,
       author = EXCLUDED.author,
       definition_yaml = EXCLUDED.definition_yaml,
       definition_json = EXCLUDED.definition_json,
       updated_at = ${dialect.now()}
     RETURNING ${AGENT_COLUMNS}`,
    [
      id,
      insert.slug,
      insert.name,
      insert.source,
      insert.version,
      insert.description,
      insert.systemPrompt,
      JSON.stringify(insert.tags),
      JSON.stringify(insert.keywords),
      JSON.stringify(insert.examples),
      JSON.stringify(insert.allowedTools),
      insert.model,
      insert.memoryRef,
      insert.author,
      insert.definitionYaml,
      JSON.stringify(insert.definition),
    ]
  );

  const row = result.rows[0];
  if (!row) {
    // RETURNING on ON CONFLICT DO UPDATE is always one row — never null.
    // This is a defensive throw; if it ever fires it indicates a real bug.
    throw new Error(`upsertAgent failed to return row for slug ${insert.slug}`);
  }
  return rowToAgent(row);
}

export async function deleteAgentBySlug(slug: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM remote_agent_agents WHERE slug = $1', [slug]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Helpers used by the bundled bootstrap
// ---------------------------------------------------------------------------

/**
 * Build an AgentInsert from the loader's LoadedAgent shape (so the bundled
 * bootstrap and the future `archon agent install` path share one code path).
 */
export function toAgentInsert(loaded: {
  definition: {
    slug: string;
    name: string;
    version: string;
    description: string;
    systemPrompt: string;
    tags: string[];
    keywords: string[];
    examples: string[];
    allowedTools: string[];
    model?: string;
    memoryRef?: string;
    author?: string;
  };
  source: AgentSource;
  sourcePath: string;
  definitionYaml: string;
}): AgentInsert {
  return {
    slug: loaded.definition.slug,
    name: loaded.definition.name,
    source: loaded.source,
    version: loaded.definition.version,
    description: loaded.definition.description,
    systemPrompt: loaded.definition.systemPrompt,
    tags: loaded.definition.tags,
    keywords: loaded.definition.keywords,
    examples: loaded.definition.examples,
    allowedTools: loaded.definition.allowedTools,
    model: loaded.definition.model ?? null,
    memoryRef: loaded.definition.memoryRef ?? null,
    author: loaded.definition.author ?? null,
    definitionYaml: loaded.definitionYaml,
    definition: { ...loaded.definition, source: loaded.source, sourcePath: loaded.sourcePath },
  };
}
