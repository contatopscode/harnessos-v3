/**
 * Memory command — list, add, search, and forget memories the orchestrator
 * stores across user/agent/project/conversation scopes.
 *
 * Mirrors the shape of `archon agent …` so the CLI feels familiar. Every
 * subcommand accepts `--json` for machine-readable output so the same
 * command feeds humans and CI.
 *
 * Exit code contract: 0 success, 1 invalid args / load error, 2 not found
 * (so `archon memory forget <id> && …` works in shell pipelines).
 */
import {
  addMemory,
  deleteMemory,
  listMemories,
  recallMemories,
  type MemoryKind,
  type MemoryScope,
} from '@archon/core';

const EXIT_OK = 0;
const EXIT_BAD_ARGS = 1;
const EXIT_NOT_FOUND = 2;

const SCOPES: readonly MemoryScope[] = ['user', 'agent', 'project', 'conversation'] as const;
const KINDS: readonly MemoryKind[] = [
  'note',
  'preference',
  'fact',
  'project_context',
  'feedback',
] as const;

function isScope(value: string): value is MemoryScope {
  return (SCOPES as readonly string[]).includes(value);
}

function isKind(value: string): value is MemoryKind {
  return (KINDS as readonly string[]).includes(value);
}

function memoryToJson(m: {
  id: string;
  scope: string;
  scope_id: string | null;
  kind: string;
  content: string;
  source: string;
  confidence: number;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}): Record<string, unknown> {
  return {
    id: m.id,
    scope: m.scope,
    scope_id: m.scope_id,
    kind: m.kind,
    content: m.content,
    source: m.source,
    confidence: m.confidence,
    use_count: m.use_count,
    created_at: m.created_at,
    last_used_at: m.last_used_at,
  };
}

interface ListOptions {
  json?: boolean;
  scope?: string;
  kind?: string;
  limit?: number;
}

interface AddOptions {
  json?: boolean;
  scope?: string;
  scopeId?: string;
  kind?: string;
  source?: string;
}

interface SearchOptions {
  json?: boolean;
  scope?: string;
  kind?: string;
  limit?: number;
}

/**
 * `archon memory list` — show all stored memories (default: user scope,
 * paginated). Filter by `--scope` and `--kind`. The free-text search box
 * is the `search` subcommand; `list` is the operator-friendly dump.
 */
export async function memoryListCommand(options: ListOptions = {}): Promise<number> {
  const limit = options.limit ?? 50;
  let scope: MemoryScope | undefined;
  if (options.scope !== undefined) {
    if (!isScope(options.scope)) {
      console.error(`Error: --scope must be one of ${SCOPES.join(', ')}; got '${options.scope}'.`);
      return EXIT_BAD_ARGS;
    }
    scope = options.scope;
  }
  let kind: MemoryKind | undefined;
  if (options.kind !== undefined) {
    if (!isKind(options.kind)) {
      console.error(`Error: --kind must be one of ${KINDS.join(', ')}; got '${options.kind}'.`);
      return EXIT_BAD_ARGS;
    }
    kind = options.kind;
  }

  const result = await listMemories({ scope, kind, limit, offset: 0 });

  if (options.json) {
    console.log(
      JSON.stringify({ total: result.total, memories: result.memories.map(memoryToJson) }, null, 2)
    );
    return EXIT_OK;
  }

  console.log(`Stored memories (${result.total} total):`);
  console.log('');
  for (const m of result.memories) {
    const ts = m.created_at;
    const tag = `[${m.scope}${m.scope_id ? `:${m.scope_id}` : ''}/${m.kind}]`;
    const preview = m.content.length > 90 ? m.content.slice(0, 87) + '…' : m.content;
    console.log(`  ${ts}  ${tag.padEnd(36)}  used ${m.use_count}x`);
    console.log(`    ${preview}`);
  }
  return EXIT_OK;
}

/**
 * `archon memory add <content> [--scope user|agent|project|conversation] [--scope-id <id>]`
 *                              `[--kind note|preference|fact|project_context|feedback]`
 *                              `[--source chat|manual|imported]`
 *
 * The same plumbing used by the orchestrator's "remember this" signal
 * detection — useful for bulk import, migrations, and CI seeding.
 */
export async function memoryAddCommand(content: string, options: AddOptions = {}): Promise<number> {
  if (!content?.trim()) {
    console.error(
      'Usage: archon memory add <content> [--scope <scope>] [--scope-id <id>] [--kind <kind>] [--source <source>] [--json]'
    );
    return EXIT_BAD_ARGS;
  }

  let scope: MemoryScope = 'user';
  if (options.scope !== undefined) {
    if (!isScope(options.scope)) {
      console.error(`Error: --scope must be one of ${SCOPES.join(', ')}; got '${options.scope}'.`);
      return EXIT_BAD_ARGS;
    }
    scope = options.scope;
  }
  let kind: MemoryKind = 'note';
  if (options.kind !== undefined) {
    if (!isKind(options.kind)) {
      console.error(`Error: --kind must be one of ${KINDS.join(', ')}; got '${options.kind}'.`);
      return EXIT_BAD_ARGS;
    }
    kind = options.kind;
  }
  const source = options.source ?? 'manual';
  if (source !== 'chat' && source !== 'manual' && source !== 'imported') {
    console.error(`Error: --source must be one of chat, manual, imported; got '${source}'.`);
    return EXIT_BAD_ARGS;
  }

  const scopeId = options.scopeId ?? null;
  const saved = await addMemory({
    scope,
    scopeId,
    kind,
    content: content.trim(),
    source,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, memory: memoryToJson(saved) }, null, 2));
    return EXIT_OK;
  }
  console.log(`Saved memory ${saved.id}  [${scope}${scopeId ? `:${scopeId}` : ''}/${kind}]`);
  console.log(`  ${saved.content}`);
  return EXIT_OK;
}

/**
 * `archon memory search <query>` — FTS5 semantic search across the same
 * scope set the orchestrator uses (user + agent + project + conversation).
 * bm25 rank is converted to 0-1 confidence so the output matches the rest
 * of the system. Use this to test recall quality, find duplicates, or
 * inspect what the model would see on a given message.
 */
export async function memorySearchCommand(
  query: string,
  options: SearchOptions = {}
): Promise<number> {
  if (!query?.trim()) {
    console.error(
      'Usage: archon memory search <query> [--scope <scope>] [--kind <kind>] [--limit <n>] [--json]'
    );
    return EXIT_BAD_ARGS;
  }
  const limit = options.limit ?? 10;

  let scopeFilter: MemoryScope | undefined;
  if (options.scope !== undefined) {
    if (!isScope(options.scope)) {
      console.error(`Error: --scope must be one of ${SCOPES.join(', ')}; got '${options.scope}'.`);
      return EXIT_BAD_ARGS;
    }
    scopeFilter = options.scope;
  }
  let kindFilter: MemoryKind | undefined;
  if (options.kind !== undefined) {
    if (!isKind(options.kind)) {
      console.error(`Error: --kind must be one of ${KINDS.join(', ')}; got '${options.kind}'.`);
      return EXIT_BAD_ARGS;
    }
    kindFilter = options.kind;
  }

  // Mirror the orchestrator: query across all 4 scopes. The optional filters
  // narrow the output post-recall. This keeps `archon memory search` and
  // "what would the agent see right now" aligned.
  const scopes = SCOPES.map(s => ({ scope: s, scopeId: null }));
  const memories = await recallMemories({ query, scopes, kind: kindFilter, limit });

  // Optional scope filter applied client-side (recallMemories doesn't filter
  // by scope on its own; it's the multi-scope intent that drives recall).
  const filtered = scopeFilter ? memories.filter(m => m.scope === scopeFilter) : memories;

  if (options.json) {
    console.log(
      JSON.stringify(
        { query, total: filtered.length, memories: filtered.map(memoryToJson) },
        null,
        2
      )
    );
    return EXIT_OK;
  }

  console.log(
    `Search results for "${query}" (${filtered.length} hit${filtered.length === 1 ? '' : 's'}):`
  );
  console.log('');
  if (filtered.length === 0) {
    console.log('  (no matches)');
    return EXIT_OK;
  }
  for (const m of filtered) {
    const tag = `[${m.scope}${m.scope_id ? `:${m.scope_id}` : ''}/${m.kind}]`;
    const preview = m.content.length > 90 ? m.content.slice(0, 87) + '…' : m.content;
    console.log(`  ${tag.padEnd(36)}  used ${m.use_count}x  conf ${m.confidence.toFixed(2)}`);
    console.log(`    ${preview}`);
    console.log(`    id: ${m.id}`);
  }
  return EXIT_OK;
}

/**
 * `archon memory forget <id>` — delete a memory by id. Use `memory list` or
 * `memory search` to find ids. Returns exit 2 when the id doesn't exist
 * so callers can `&&` cleanly.
 */
export async function memoryForgetCommand(id: string): Promise<number> {
  if (!id?.trim()) {
    console.error('Usage: archon memory forget <id>');
    return EXIT_BAD_ARGS;
  }
  const removed = await deleteMemory(id.trim());
  if (!removed) {
    console.error(`Error: memory '${id}' not found.`);
    return EXIT_NOT_FOUND;
  }
  console.log(`Forgot memory ${id}.`);
  return EXIT_OK;
}
