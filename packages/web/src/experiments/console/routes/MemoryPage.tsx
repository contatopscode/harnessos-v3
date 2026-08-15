/**
 * Console `/console/memory` page — inspect, search, add, and forget the
 * memories the orchestrator stores across user/agent/project/conversation
 * scopes. Mirrors `archon memory …` on the CLI; the same backend
 * (FTS5 + bm25 → 0-1 confidence) drives both.
 *
 * Two sections:
 *   1. Search bar + recall preview — what the orchestrator would inject for
 *      a given message (useful for tuning the signal phrases).
 *   2. List of stored memories (scope/kind filters, add, forget).
 *
 * Path B — Memory + RAG. Paired with `archon memory list/add/search/forget`
 * on the CLI and the orchestrator's `detectMemorySignal` on the success path.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { components } from '@/lib/api.generated';
import { EmptyState } from '../components/EmptyState';

type Memory = components['schemas']['Memory'];
type MemoryRecallHit = components['schemas']['MemoryRecallHit'];
type MemoryScope = components['schemas']['MemoryScope'];
type MemoryKind = components['schemas']['MemoryKind'];
type MemorySource = components['schemas']['MemorySource'];

const SCOPES: readonly MemoryScope[] = ['user', 'agent', 'project', 'conversation'] as const;
const KINDS: readonly MemoryKind[] = [
  'note',
  'preference',
  'fact',
  'project_context',
  'feedback',
] as const;

const SCOPE_LABELS: Record<MemoryScope, string> = {
  user: 'Usuário',
  agent: 'Agente',
  project: 'Projeto',
  conversation: 'Conversa',
};
const KIND_LABELS: Record<MemoryKind, string> = {
  note: 'Nota',
  preference: 'Preferência',
  fact: 'Fato',
  project_context: 'Contexto do projeto',
  feedback: 'Feedback',
};
const SOURCE_LABELS: Record<MemorySource, string> = {
  chat: 'Chat',
  manual: 'Manual',
  imported: 'Importado',
};

const SCOPE_COLORS: Record<MemoryScope, string> = {
  user: 'bg-accent-bright/15 text-accent-bright',
  agent: 'bg-warning/15 text-warning',
  project: 'bg-success/15 text-success',
  conversation: 'bg-text-tertiary/15 text-text-secondary',
};

interface ListMemoriesResponse {
  total: number;
  memories: Memory[];
}

interface RecallResponse {
  query: string;
  total: number;
  hits: MemoryRecallHit[];
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  return [];
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MemoryPage(): ReactElement {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [filterScope, setFilterScope] = useState<MemoryScope | 'all'>('all');
  const [filterKind, setFilterKind] = useState<MemoryKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Recall preview (FTS5 search)
  const [recallQuery, setRecallQuery] = useState('');
  const [recallHits, setRecallHits] = useState<MemoryRecallHit[]>([]);
  const [recallBusy, setRecallBusy] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);

  // Add form
  const [addContent, setAddContent] = useState('');
  const [addScope, setAddScope] = useState<MemoryScope>('user');
  const [addKind, setAddKind] = useState<MemoryKind>('note');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterScope !== 'all') params.set('scope', filterScope);
      if (filterKind !== 'all') params.set('kind', filterKind);
      if (search.trim() !== '') params.set('search', search.trim());
      params.set('limit', '100');
      const data = await fetchJSON<ListMemoriesResponse>(`/api/memories?${params.toString()}`);
      setMemories(data.memories);
      setTotal(data.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterScope, filterKind, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRecall = useCallback(async (): Promise<void> => {
    const q = recallQuery.trim();
    if (q === '') {
      setRecallHits([]);
      setRecallError(null);
      return;
    }
    setRecallBusy(true);
    setRecallError(null);
    try {
      const data = await fetchJSON<RecallResponse>('/api/memories/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          scopes: [...SCOPES],
          limit: 10,
        }),
      });
      setRecallHits(data.hits);
    } catch (err) {
      setRecallError((err as Error).message);
      setRecallHits([]);
    } finally {
      setRecallBusy(false);
    }
  }, [recallQuery]);

  const handleAdd = useCallback(async (): Promise<void> => {
    const content = addContent.trim();
    if (content === '') {
      setAddError('Conteúdo é obrigatório');
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await fetchJSON<{ ok: boolean; memory: Memory }>('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          scope: addScope,
          kind: addKind,
          source: 'manual',
        }),
      });
      setAddContent('');
      await refresh();
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAddBusy(false);
    }
  }, [addContent, addScope, addKind, refresh]);

  const handleForget = useCallback(
    async (id: string, preview: string): Promise<void> => {
      if (
        !confirm(
          `Esquecer esta memória?\n\n"${preview.slice(0, 80)}${preview.length > 80 ? '…' : ''}"`
        )
      ) {
        return;
      }
      try {
        await fetchJSON<{ ok: boolean }>(`/api/memories/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refresh]
  );

  const filteredTotalLabel = useMemo(() => {
    if (loading) return 'Carregando…';
    return `${total} memória${total === 1 ? '' : 's'}`;
  }, [total, loading]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-10 pt-[22px]">
        <h1 className="text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">Memória</h1>
        <p className="mt-1 text-xs text-text-tertiary">
          Fatos que o orchestrator guarda por usuário, agente, projeto ou conversa. O sistema injeta
          as memórias relevantes no system prompt automaticamente — você também pode salvar e
          procurar manualmente aqui. Use <code className="text-text-secondary">lembre que…</code> ou{' '}
          <code className="text-text-secondary">minha preferência é…</code> no chat para persistir
          uma memória por turno.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        {error !== null ? (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {/* ── Recall preview ─────────────────────────────────────── */}
        <section className="mx-auto mb-6 flex max-w-[1080px] flex-col gap-3 rounded-md border border-border-subtle bg-surface-elevated p-4">
          <h2 className="text-sm font-semibold text-text-primary">Testar recall (FTS5)</h2>
          <p className="text-xs text-text-tertiary">
            Digite uma query pra ver o que o orchestrator injetaria no system prompt. Mesma busca
            OR-acento-stripped, top-10 hits.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={recallQuery}
              onChange={e => {
                setRecallQuery(e.target.value);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleRecall();
              }}
              placeholder="ex: postgres setup local, jvm args do servidor, prompt que eu uso…"
              className="flex-1 rounded border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={() => void handleRecall()}
              disabled={recallBusy || recallQuery.trim() === ''}
              className="rounded bg-accent-primary px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-50"
            >
              {recallBusy ? 'Buscando…' : 'Buscar'}
            </button>
          </div>
          {recallError !== null ? (
            <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 font-mono text-[10.5px] text-red-200">
              {recallError}
            </p>
          ) : null}
          {recallHits.length > 0 ? (
            <ul className="divide-y divide-border-subtle">
              {recallHits.map(hit => (
                <li key={hit.id} className="flex items-start gap-3 py-2 text-xs">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${SCOPE_COLORS[hit.scope]}`}
                    title={`Escopo: ${SCOPE_LABELS[hit.scope]}`}
                  >
                    {SCOPE_LABELS[hit.scope]}
                  </span>
                  <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
                    {KIND_LABELS[hit.kind]}
                  </span>
                  <span className="min-w-0 flex-1 text-text-secondary">{hit.content}</span>
                  <span
                    className="shrink-0 font-mono text-[10px] text-text-tertiary"
                    title="Confiança (0-1, derivada do rank bm25)"
                  >
                    conf {hit.rank_confidence.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ── Add memory form ─────────────────────────────────────── */}
        <section className="mx-auto mb-6 flex max-w-[1080px] flex-col gap-2 rounded-md border border-border-subtle bg-surface-elevated p-4">
          <h2 className="text-sm font-semibold text-text-primary">Adicionar memória manualmente</h2>
          <div className="grid grid-cols-[1fr_180px_180px] gap-2">
            <input
              type="text"
              value={addContent}
              onChange={e => {
                setAddContent(e.target.value);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) void handleAdd();
              }}
              placeholder="Conteúdo da memória"
              className="rounded border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <select
              value={addScope}
              onChange={e => {
                setAddScope(e.target.value as MemoryScope);
              }}
              className="rounded border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary"
            >
              {SCOPES.map(s => (
                <option key={s} value={s}>
                  {SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              value={addKind}
              onChange={e => {
                setAddKind(e.target.value as MemoryKind);
              }}
              className="rounded border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary"
            >
              {KINDS.map(k => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            {addError !== null ? (
              <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 font-mono text-[10.5px] text-red-200">
                {addError}
              </p>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={addBusy || addContent.trim() === ''}
              className="rounded bg-accent-primary px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-50"
            >
              {addBusy ? 'Adicionando…' : 'Adicionar'}
            </button>
          </div>
        </section>

        {/* ── Filters + list ─────────────────────────────────────── */}
        <div className="mx-auto mb-3 flex max-w-[1080px] items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setFilterScope('all');
            }}
            className={`rounded-full px-3 py-1 text-xs ${
              filterScope === 'all'
                ? 'bg-accent-primary text-on-accent'
                : 'border border-border-subtle text-text-secondary'
            }`}
          >
            Todos
          </button>
          {SCOPES.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setFilterScope(s);
              }}
              className={`rounded-full px-3 py-1 text-xs ${
                filterScope === s
                  ? 'bg-accent-primary text-on-accent'
                  : 'border border-border-subtle text-text-secondary'
              }`}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
          <span className="mx-2 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setFilterKind('all');
            }}
            className={`rounded-full px-3 py-1 text-xs ${
              filterKind === 'all'
                ? 'bg-accent-bright/30 text-text-primary'
                : 'border border-border-subtle text-text-secondary'
            }`}
          >
            Todos os tipos
          </button>
          {KINDS.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setFilterKind(k);
              }}
              className={`rounded-full px-3 py-1 text-xs ${
                filterKind === k
                  ? 'bg-accent-bright/30 text-text-primary'
                  : 'border border-border-subtle text-text-secondary'
              }`}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
          <input
            type="text"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
            }}
            placeholder="Buscar no conteúdo…"
            className="ml-auto w-[260px] rounded border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary"
          />
        </div>

        <div className="mx-auto max-w-[1080px]">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
            {filteredTotalLabel}
          </p>
          {loading ? (
            <EmptyState title="Carregando…" />
          ) : memories.length === 0 ? (
            <EmptyState
              title="Nenhuma memória neste filtro"
              hint={
                filterScope === 'all' && filterKind === 'all' && search === ''
                  ? 'Comece adicionando uma memória acima ou usando "lembre que…" no chat.'
                  : 'Tente ajustar os filtros ou limpar a busca.'
              }
            />
          ) : (
            <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-elevated">
              {memories.map(m => (
                <li key={m.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono ${SCOPE_COLORS[m.scope]}`}
                        title={
                          m.scope_id
                            ? `Escopo: ${SCOPE_LABELS[m.scope]} (${m.scope_id})`
                            : `Escopo: ${SCOPE_LABELS[m.scope]}`
                        }
                      >
                        {SCOPE_LABELS[m.scope]}
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 text-text-tertiary">
                        {KIND_LABELS[m.kind]}
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 text-text-tertiary">
                        {SOURCE_LABELS[m.source]}
                      </span>
                      <span className="ml-auto font-mono normal-case tracking-normal text-text-tertiary">
                        {formatTimestamp(m.created_at)}
                        {m.last_used_at !== null && m.last_used_at !== m.created_at
                          ? ` · usada ${formatTimestamp(m.last_used_at)}`
                          : ''}
                        {m.use_count > 0 ? ` · ${m.use_count}×` : ''}
                      </span>
                    </div>
                    <p className="text-text-primary">{m.content}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleForget(m.id, m.content);
                    }}
                    className="shrink-0 rounded border border-red-500/40 px-2 py-1 text-[11px] font-semibold text-red-300 hover:bg-red-500/10"
                    title="Esquecer esta memória"
                  >
                    Esquecer
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** Local copy of the api.ts fetchJSON helper — that one is unexported. */
async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const path = new URL(url, window.location.origin).pathname;
    throw Object.assign(new Error(`API error ${res.status} (${path}): ${truncated}`), {
      status: res.status,
    });
  }
  return res.json() as Promise<T>;
}

// Suppress unused warning if a future version drops `asArray`.
void asArray;
