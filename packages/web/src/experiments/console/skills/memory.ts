/**
 * Memory skill — the UI-facing surface for the orchestrator's memory system
 * (path B — Memory + RAG). The console never calls the DB directly: it goes
 * through these verbs, which translate to the `/api/memories*` HTTP routes.
 *
 * Mirror of `archon memory …` on the CLI. Same payload shapes, same
 * filtering options. Anything the Web UI can do here, the CLI can do too.
 */
import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

type Memory = components['schemas']['Memory'];
type MemoryRecallHit = components['schemas']['MemoryRecallHit'];
type MemoryScope = components['schemas']['MemoryScope'];
type MemoryKind = components['schemas']['MemoryKind'];
type MemorySource = components['schemas']['MemorySource'];

export interface ListMemoriesOptions {
  scope?: MemoryScope;
  kind?: MemoryKind;
  /** Free-text search across `content` (FTS5 OR semantics, accent-stripped). */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface RecallOptions {
  query: string;
  /** Default: all 4 scopes (user, agent, project, conversation). */
  scopes?: MemoryScope[];
  kind?: MemoryKind;
  limit?: number;
}

export interface AddMemoryOptions {
  content: string;
  scope?: MemoryScope;
  scopeId?: string | null;
  kind?: MemoryKind;
  source?: MemorySource;
}

export async function listMemories(options: ListMemoriesOptions = {}): Promise<{
  total: number;
  memories: Memory[];
}> {
  const params = new URLSearchParams();
  if (options.scope !== undefined) params.set('scope', options.scope);
  if (options.kind !== undefined) params.set('kind', options.kind);
  if (options.search !== undefined) params.set('search', options.search);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const qs = params.toString();
  return requestJson<{ total: number; memories: Memory[] }>(
    `/api/memories${qs.length > 0 ? `?${qs}` : ''}`
  );
}

export async function addMemory(
  options: AddMemoryOptions
): Promise<{ ok: boolean; memory: Memory }> {
  return requestJson<{ ok: boolean; memory: Memory }>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({
      content: options.content,
      scope: options.scope ?? 'user',
      scope_id: options.scopeId ?? null,
      kind: options.kind ?? 'note',
      source: options.source ?? 'manual',
    }),
  });
}

export async function recallMemories(options: RecallOptions): Promise<{
  query: string;
  total: number;
  hits: MemoryRecallHit[];
}> {
  return requestJson<{ query: string; total: number; hits: MemoryRecallHit[] }>(
    '/api/memories/recall',
    {
      method: 'POST',
      body: JSON.stringify({
        query: options.query,
        scopes: options.scopes ?? ['user', 'agent', 'project', 'conversation'],
        kind: options.kind,
        limit: options.limit ?? 10,
      }),
    }
  );
}

export async function forgetMemory(
  id: string
): Promise<{ ok: boolean; id: string; removed: boolean }> {
  return requestJson<{ ok: boolean; id: string; removed: boolean }>(
    `/api/memories/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
}
