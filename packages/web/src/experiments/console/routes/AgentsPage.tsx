/**
 * Console `/console/agents` page — install / show / uninstall personas that the
 * orchestrator routes chat messages to. Three sections:
 *   1. List of installed agents (bundled / local / installed) with counts
 *   2. Detail panel for the selected agent (system prompt, keywords, examples, tools)
 *   3. Recent routing decisions (audit) from agent_runs
 *
 * Path A — Agents. Paired with `archon agent …` on the CLI; the same backend
 * data drives both.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { components } from '@/lib/api.generated';
import { EmptyState } from '../components/EmptyState';

type Agent = components['schemas']['Agent'];
type AgentRun = components['schemas']['AgentRun'];
type AgentSource = components['schemas']['AgentSource'];
type RoutingDecision = components['schemas']['RoutingDecision'];

interface ListAgentsResponse {
  total: number;
  counts: { all: number; bundled: number; local: number; installed: number };
  agents: Agent[];
}

interface ListAgentRunsResponse {
  total: number;
  runs: AgentRun[];
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

const SOURCES: AgentSource[] = ['bundled', 'local', 'installed'];
const SOURCE_LABELS: Record<AgentSource, string> = {
  bundled: 'Bundled',
  local: 'Local',
  installed: 'Instalado',
};

const DECISION_LABELS: Record<RoutingDecision, string> = {
  override: 'Override',
  codebase_default: 'Codebase default',
  auto_heuristic: 'Auto (heurística)',
  auto_llm: 'Auto (LLM)',
  default_fallback: 'Fallback padrão',
};

/**
 * Read a JSON-as-TEXT column from the API wire shape. The backend parses these
 * into string[] before sending, so this is just a safety net.
 */
function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  return [];
}

export function AgentsPage(): ReactElement {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [counts, setCounts] = useState<ListAgentsResponse['counts'] | null>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [filterSource, setFilterSource] = useState<AgentSource | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installPath, setInstallPath] = useState('');
  const [installBusy, setInstallBusy] = useState(false);
  const [installResult, setInstallResult] = useState<{ ok: boolean; message: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterSource !== 'all') params.set('source', filterSource);
      params.set('limit', '100');
      const data = await fetchJSON<ListAgentsResponse>(`/api/agents?${params.toString()}`);
      setAgents(data.agents);
      setCounts(data.counts);
      // Keep the selected agent fresh if it still exists
      if (selected) {
        const refreshed = data.agents.find((a: Agent) => a.id === selected.id) ?? null;
        setSelected(refreshed);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterSource, selected]);

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJSON<ListAgentRunsResponse>('/api/agents/runs?limit=20');
      setRuns(data.runs);
    } catch {
      // Audit is best-effort; don't block the page on a failure
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshRuns();
  }, [refresh, refreshRuns]);

  const handleSelect = useCallback(async (slug: string): Promise<void> => {
    try {
      const data = await fetchJSON<{ agent: Agent }>(`/api/agents/${encodeURIComponent(slug)}`);
      setSelected(data.agent);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleUninstall = useCallback(
    async (slug: string): Promise<void> => {
      if (!confirm(`Desinstalar o agente "${slug}"?`)) return;
      try {
        await fetchJSON<{ ok: boolean; removed: boolean }>(
          `/api/agents/${encodeURIComponent(slug)}`,
          {
            method: 'DELETE',
          }
        );
        setSelected(null);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refresh]
  );

  const handleInstall = useCallback(async (): Promise<void> => {
    if (!installPath.trim()) return;
    setInstallBusy(true);
    setInstallResult(null);
    try {
      const result = await fetchJSON<{ ok: boolean; slug: string }>('/api/agents/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: installPath.trim() }),
      });
      setInstallResult({ ok: true, message: `Instalado ${result.slug}.` });
      setInstallPath('');
      await refresh();
    } catch (err) {
      setInstallResult({ ok: false, message: (err as Error).message });
    } finally {
      setInstallBusy(false);
    }
  }, [installPath, refresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-10 pt-[22px]">
        <h1 className="text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">Agentes</h1>
        <p className="mt-1 text-xs text-text-tertiary">
          Personas para as quais o orchestrator roteia mensagens de chat. Agentes{' '}
          <code className="text-text-secondary">bundled</code> vêm com o app; agentes{' '}
          <code className="text-text-secondary">local</code> são overrides por projeto; agentes{' '}
          <code className="text-text-secondary">installed</code> vêm de um registry futuro.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        {error !== null ? (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {/* ── Install bar ────────────────────────────────────────────── */}
        <section className="mx-auto mb-6 flex max-w-[1080px] flex-col gap-2 rounded-md border border-border-subtle bg-surface-elevated p-4">
          <h2 className="text-sm font-semibold text-text-primary">Instalar a partir de YAML</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={installPath}
              onChange={e => {
                setInstallPath(e.target.value);
              }}
              placeholder="/caminho/para/agent.yaml"
              className="flex-1 rounded border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={() => void handleInstall()}
              disabled={installBusy || !installPath.trim()}
              className="rounded bg-accent-primary px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-50"
            >
              {installBusy ? 'Instalando…' : 'Instalar'}
            </button>
          </div>
          {installResult !== null ? (
            <p className={`text-xs ${installResult.ok ? 'text-green-300' : 'text-red-300'}`}>
              {installResult.message}
            </p>
          ) : null}
        </section>

        {/* ── Source filter chips ────────────────────────────────────── */}
        <div className="mx-auto mb-3 flex max-w-[1080px] items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setFilterSource('all');
            }}
            className={`rounded-full px-3 py-1 text-xs ${
              filterSource === 'all'
                ? 'bg-accent-primary text-on-accent'
                : 'border border-border-subtle text-text-secondary'
            }`}
          >
            Todos {counts !== null ? `(${counts.all})` : ''}
          </button>
          {SOURCES.map(src => (
            <button
              key={src}
              type="button"
              onClick={() => {
                setFilterSource(src);
              }}
              className={`rounded-full px-3 py-1 text-xs ${
                filterSource === src
                  ? 'bg-accent-primary text-on-accent'
                  : 'border border-border-subtle text-text-secondary'
              }`}
            >
              {SOURCE_LABELS[src]} {counts !== null ? `(${counts[src]})` : ''}
            </button>
          ))}
        </div>

        {/* ── Agents + Detail two-pane ───────────────────────────────── */}
        <div className="mx-auto grid max-w-[1080px] grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
          <section className="rounded-md border border-border-subtle bg-surface-elevated">
            <header className="border-b border-border-subtle px-4 py-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Agentes instalados
              </h2>
            </header>
            {loading ? (
              <div className="px-4 py-6 text-sm text-text-tertiary">Carregando…</div>
            ) : agents.length === 0 ? (
              <EmptyState
                title="Nenhum agente neste filtro"
                hint="Mude a fonte acima ou instale a partir de um arquivo YAML."
              />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {agents.map(agent => (
                  <li
                    key={agent.id}
                    className={`cursor-pointer px-4 py-3 transition-colors hover:bg-surface-hover ${
                      selected?.id === agent.id ? 'bg-surface-hover' : ''
                    }`}
                    onClick={() => void handleSelect(agent.slug)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-sm text-text-primary">
                        {agent.slug}
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
                        {SOURCE_LABELS[agent.source]}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-text-secondary">{agent.name}</p>
                    <p className="mt-1 line-clamp-2 text-[11px] text-text-tertiary">
                      {agent.description}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-md border border-border-subtle bg-surface-elevated">
            {selected === null ? (
              <EmptyState
                title="Escolha um agente à esquerda"
                hint="Clique em qualquer slug para ver o system prompt, keywords, examples e ferramentas permitidas."
              />
            ) : (
              <AgentDetail
                agent={selected}
                onUninstall={() => void handleUninstall(selected.slug)}
              />
            )}
          </section>
        </div>

        {/* ── Recent routing decisions ───────────────────────────────── */}
        <section className="mx-auto mt-6 max-w-[1080px] rounded-md border border-border-subtle bg-surface-elevated">
          <header className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              Decisões de roteamento recentes
            </h2>
            <button
              type="button"
              onClick={() => void refreshRuns()}
              className="text-[11px] text-text-secondary hover:text-text-primary"
            >
              Atualizar
            </button>
          </header>
          {runs.length === 0 ? (
            <div className="px-4 py-6 text-sm text-text-tertiary">
              Nenhuma decisão de roteamento ainda. Envie uma mensagem de chat e o orchestrator
              registrará a decisão aqui.
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {runs.map(run => (
                <li key={run.id} className="px-4 py-2.5 text-xs">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-text-primary">{run.agent_slug}</span>
                    <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
                      {DECISION_LABELS[run.decision]}
                    </span>
                    <span className="text-text-tertiary">
                      conf {(run.confidence * 100).toFixed(0)}% · {run.latency_ms}ms
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-text-tertiary">
                      {new Date(run.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-text-secondary">“{run.user_message_preview}”</p>
                  <p className="mt-0.5 text-[10px] text-text-tertiary">{run.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent detail panel
// ---------------------------------------------------------------------------

interface AgentDetailProps {
  agent: Agent;
  onUninstall: () => void;
}

function AgentDetail({ agent, onUninstall }: AgentDetailProps): ReactElement {
  const keywords = useMemo(() => asArray(agent.keywords), [agent.keywords]);
  const examples = useMemo(() => asArray(agent.examples), [agent.examples]);
  const tools = useMemo(() => asArray(agent.allowed_tools), [agent.allowed_tools]);
  const tags = useMemo(() => asArray(agent.tags), [agent.tags]);
  const canUninstall = agent.source !== 'bundled';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{agent.name}</h2>
          <p className="mt-0.5 font-mono text-xs text-text-tertiary">
            {agent.slug} · v{agent.version} · {SOURCE_LABELS[agent.source]}
          </p>
          <p className="mt-2 text-sm text-text-secondary">{agent.description}</p>
        </div>
        {canUninstall ? (
          <button
            type="button"
            onClick={onUninstall}
            className="shrink-0 rounded border border-red-500/40 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/10"
          >
            Desinstalar
          </button>
        ) : (
          <span
            className="shrink-0 rounded border border-border-subtle px-3 py-1 text-[10px] uppercase tracking-wider text-text-tertiary"
            title="Agentes bundled são recriados a cada boot do servidor."
          >
            Bundled — protegido
          </span>
        )}
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Block label="System prompt" mono>
          <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">
            {agent.system_prompt}
          </pre>
        </Block>

        {agent.model !== null ? (
          <Block label="Modelo">
            <code className="text-xs text-text-primary">{agent.model}</code>
          </Block>
        ) : null}

        {agent.author !== null ? (
          <Block label="Autor">
            <span className="text-xs text-text-primary">{agent.author}</span>
          </Block>
        ) : null}

        {tags.length > 0 ? (
          <Block label="Tags">
            <div className="flex flex-wrap gap-1.5">
              {tags.map(t => (
                <span
                  key={t}
                  className="rounded bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary"
                >
                  {t}
                </span>
              ))}
            </div>
          </Block>
        ) : null}

        {keywords.length > 0 ? (
          <Block label={`Keywords (${keywords.length})`}>
            <p className="text-xs text-text-secondary">{keywords.join(', ')}</p>
          </Block>
        ) : null}

        {tools.length > 0 ? (
          <Block label={`Ferramentas permitidas (${tools.length})`}>
            <div className="flex flex-wrap gap-1.5">
              {tools.map(t => (
                <code
                  key={t}
                  className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-primary"
                >
                  {t}
                </code>
              ))}
            </div>
          </Block>
        ) : null}

        {examples.length > 0 ? (
          <Block label={`Exemplos (${examples.length})`}>
            <ul className="space-y-1">
              {examples.map((ex, i) => (
                <li key={i} className="text-xs italic text-text-secondary">
                  “{ex}”
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
      </div>
    </div>
  );
}

interface BlockProps {
  label: string;
  children: ReactElement;
  mono?: boolean;
}

function Block({ label, children }: BlockProps): ReactElement {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label}
      </h3>
      {children}
    </section>
  );
}
