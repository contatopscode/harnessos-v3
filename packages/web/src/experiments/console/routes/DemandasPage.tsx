/**
 * HarnessOS Console — Demandas (Kanban).
 *
 * Read+write Kanban for the FORGE demand table, surfaced inside the
 * Console so the same person who runs the Builder can also see and
 * move demands across the pipeline. The FORGE webapp shows the same
 * board as **read-only** (only the Builder changes status); the
 * Console lets a project manager / admin override the status when
 * the auto-pipeline needs a hand.
 *
 * Filters: client + project (drives `clientId` and `codebaseId` query
 * params on `/api/forge/demands/board`, both supported by the backend).
 *
 * Theme: uses `.console-root` OKLCH tokens so the page sits natively
 * inside the Console shell — no Tailwind zinc/raw white.
 *
 * Data fetching: uses the console's own `useState + useEffect` pattern
 * (see AuditLogPage) instead of React Query — the console spike's
 * ESLint config restricts React Query in favor of its own store/cache
 * system, and the new page is small enough that manual fetch + state
 * is clearer than wiring the cache for one page.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Loader2,
  Search,
  Activity,
  History,
  Filter,
  X,
  Plus,
  MessageSquare,
  PlayCircle,
  Receipt,
  type LucideIcon,
} from 'lucide-react';
import {
  listClients,
  listForgeProjects,
  getDemandBoard,
  updateDemandStatus,
  getDemandTimeline,
  addNote,
  createDemand as apiCreateDemand,
  runDemand as apiRunDemand,
  type CreateDemandBody,
  type RunDemandBody,
  type Demand,
  type DemandStatus,
  type Client,
  type ProjectSummary,
  type DemandBoard,
  type DemandTimeline,
  type DemandTimelineEntry,
} from '../skills/forge';

const COLUMNS: { status: DemandStatus; label: string; accent: string }[] = [
  { status: 'backlog', label: 'Backlog', accent: 'var(--text-tertiary)' },
  { status: 'triagem', label: 'Triagem', accent: 'var(--running)' },
  { status: 'requisitos', label: 'Requisitos', accent: 'var(--brand-violet)' },
  { status: 'aprovacao_cliente', label: 'Aprovação', accent: 'var(--warning)' },
  { status: 'em_andamento', label: 'Em andamento', accent: 'var(--success)' },
  { status: 'bloqueada', label: 'Bloqueada', accent: 'var(--error)' },
  { status: 'concluido', label: 'Concluído', accent: 'var(--success)' },
  { status: 'cancelado', label: 'Cancelado', accent: 'var(--text-tertiary)' },
];

export function DemandasPage(): ReactElement {
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [codebaseId, setCodebaseId] = useState('');
  const [timelineFor, setTimelineFor] = useState<Demand | null>(null);
  // "+ Nova" modal — opens a CreateDemandModal. New demands always start
  // in the Backlog column (backend forces status='backlog' on POST).
  const [createOpen, setCreateOpen] = useState(false);
  // "Disparar RUN" modal — opens a RunDemandModal for the clicked demand.
  // The run is fire-and-forget; the user follows progress via the
  // auto-advance hooks (completeWorkflowRun / failWorkflowRun) and the
  // demand_activities table surfaced in the timeline.
  const [runFor, setRunFor] = useState<Demand | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [board, setBoard] = useState<DemandBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movePendingId, setMovePendingId] = useState<string | null>(null);

  // Load clients + projects once (dropdowns). The `cancelledRef` wrapper
  // satisfies the `prefer-const` rule while still letting the cleanup
  // flip a mutable flag that the .then/.catch closures check.
  useEffect(() => {
    const cancelledRef = { value: false };
    void Promise.all([listClients(), listForgeProjects()])
      .then(([c, p]): void => {
        if (cancelledRef.value) return;
        setClients(c);
        setProjects(p);
      })
      .catch((e: unknown): void => {
        if (cancelledRef.value) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return (): void => {
      cancelledRef.value = true;
    };
  }, []);

  // Refetch the board whenever any filter changes. Uses a `cancelledRef`
  // so a fast filter flip doesn't land an old result on top of the new one.
  useEffect(() => {
    const cancelledRef = { value: false };
    setLoading(true);
    setError(null);
    getDemandBoard({
      search: search || undefined,
      clientId: clientId || undefined,
      codebaseId: codebaseId || undefined,
    })
      .then((b): void => {
        if (cancelledRef.value) return;
        setBoard(b);
      })
      .catch((e: unknown): void => {
        if (cancelledRef.value) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally((): void => {
        if (cancelledRef.value) return;
        setLoading(false);
      });
    return (): void => {
      cancelledRef.value = true;
    };
  }, [search, clientId, codebaseId]);

  // Manual refetch helper used after a status mutation — same fetch path.
  const refetchBoard = useCallback((): void => {
    const cancelledRef = { value: false };
    setLoading(true);
    setError(null);
    getDemandBoard({
      search: search || undefined,
      clientId: clientId || undefined,
      codebaseId: codebaseId || undefined,
    })
      .then((b): void => {
        if (cancelledRef.value) return;
        setBoard(b);
      })
      .catch((e: unknown): void => {
        if (cancelledRef.value) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally((): void => {
        if (cancelledRef.value) return;
        setLoading(false);
      });
  }, [search, clientId, codebaseId]);

  const onMove = useCallback(
    (id: string, status: DemandStatus): void => {
      setMovePendingId(id);
      updateDemandStatus(id, status)
        .then(() => {
          refetchBoard();
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          setMovePendingId(null);
        });
    },
    [refetchBoard]
  );

  // Project options for the current client filter (so the user can pick
  // project-after-client without scrolling through every project). Reset
  // the project when the client changes — the old project might not
  // belong to the new client.
  const filteredProjects = clientId ? projects.filter(p => p.client_id === clientId) : projects;

  const filtersActive = clientId !== '' || codebaseId !== '' || search !== '';

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-[20px] font-semibold tracking-tight text-text-primary">
            Demandas
          </h1>
          <p className="mt-1 text-[12.5px] text-text-tertiary">
            Kanban read+write — card avança quando o Builder termina ou quando você move
            manualmente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
            <input
              type="search"
              placeholder="Buscar slug, título…"
              value={search}
              onChange={e => {
                setSearch(e.target.value);
              }}
              className="w-[220px] rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setCreateOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-bright px-2.5 py-1.5 text-[11.5px] font-medium text-white shadow-sm transition hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            Nova
          </button>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
          <Filter className="h-3.5 w-3.5" aria-hidden />
          Filtros
        </div>
        <select
          value={clientId}
          onChange={e => {
            setClientId(e.target.value);
            setCodebaseId('');
          }}
          className="rounded-md border border-border bg-surface-inset px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent-bright"
        >
          <option value="">Todos os clientes</option>
          {clients.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={codebaseId}
          onChange={e => {
            setCodebaseId(e.target.value);
          }}
          className="rounded-md border border-border bg-surface-inset px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent-bright"
        >
          <option value="">Todos os projetos</option>
          {filteredProjects.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setClientId('');
              setCodebaseId('');
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-inset px-2 py-1 text-[11px] font-medium text-text-secondary transition hover:text-text-primary"
          >
            <X className="h-3 w-3" aria-hidden />
            Limpar
          </button>
        )}
        <div className="ml-auto font-mono text-[11px] text-text-tertiary">
          {board?.total ?? 0} demanda{board?.total === 1 ? '' : 's'}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-[13px]">Carregando board…</span>
        </div>
      ) : error ? (
        <ErrorState error={new Error(error)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
          {board?.columns.map(col => (
            <Column
              key={col.status}
              status={col.status}
              label={COLUMNS.find(c => c.status === col.status)?.label ?? col.status}
              accent={COLUMNS.find(c => c.status === col.status)?.accent ?? 'var(--text-tertiary)'}
              demands={col.demands}
              onMove={onMove}
              onOpenTimeline={d => {
                setTimelineFor(d);
              }}
              onOpenRun={d => {
                setRunFor(d);
              }}
              movePendingId={movePendingId}
            />
          ))}
        </div>
      )}

      <DemandTimelineModal
        demand={timelineFor}
        open={timelineFor !== null}
        onClose={() => {
          setTimelineFor(null);
        }}
      />

      <CreateDemandModal
        open={createOpen}
        clients={clients}
        projects={projects}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={() => {
          setCreateOpen(false);
          refetchBoard();
        }}
      />

      <RunDemandModal
        demand={runFor}
        open={runFor !== null}
        onClose={() => {
          setRunFor(null);
        }}
        onDispatched={() => {
          setRunFor(null);
          // Refetch is not strictly required (the run is fire-and-forget),
          // but a quick re-read makes the latest activity counters feel
          // snappy. The run_started activity lands within ~1s of dispatch.
          refetchBoard();
        }}
      />
    </div>
  );
}

interface ColumnProps {
  status: DemandStatus;
  label: string;
  accent: string;
  demands: Demand[];
  onMove: (id: string, status: DemandStatus) => void;
  onOpenTimeline: (demand: Demand) => void;
  onOpenRun: (demand: Demand) => void;
  movePendingId: string | null;
}

function Column({
  status,
  label,
  accent,
  demands,
  onMove,
  onOpenTimeline,
  onOpenRun,
  movePendingId,
}: ColumnProps): ReactElement {
  return (
    <div className="flex min-h-[180px] flex-col rounded-[10px] border border-border/60 bg-surface-inset/40 p-2">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} aria-hidden />
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-secondary">
            {label}
          </span>
        </div>
        <span className="rounded-md bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-tertiary">
          {demands.length}
        </span>
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {demands.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 py-6 text-center text-[10px] text-text-tertiary">
            vazio
          </div>
        ) : (
          demands.map(d => (
            <Card
              key={d.id}
              demand={d}
              currentStatus={status}
              onMove={onMove}
              onOpenTimeline={onOpenTimeline}
              onOpenRun={onOpenRun}
              movePending={movePendingId === d.id}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface CardProps {
  demand: Demand;
  currentStatus: DemandStatus;
  onMove: (id: string, status: DemandStatus) => void;
  onOpenTimeline: (demand: Demand) => void;
  onOpenRun: (demand: Demand) => void;
  movePending: boolean;
}

function Card({
  demand,
  currentStatus,
  onMove,
  onOpenTimeline,
  onOpenRun,
  movePending,
}: CardProps): ReactElement {
  const [open, setOpen] = useState(false);
  const priorityColor =
    demand.priority === 'urgente'
      ? 'var(--error)'
      : demand.priority === 'alta'
        ? 'var(--warning)'
        : 'var(--text-tertiary)';
  const isBlocked = demand.status === 'bloqueada';
  return (
    <div
      onClick={() => {
        setOpen(o => !o);
      }}
      className={`group cursor-pointer rounded-md border p-2 transition ${
        isBlocked
          ? 'border-error/40 bg-error/5 hover:border-error/70'
          : 'border-border bg-surface hover:border-accent-bright/40 hover:bg-surface-elevated'
      } ${open ? 'ring-1 ring-accent-bright/60' : ''}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="truncate font-mono text-[10px] text-text-tertiary">{demand.slug}</span>
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: priorityColor }}
          title={`prioridade ${demand.priority}`}
          aria-label={`prioridade ${demand.priority}`}
        />
      </div>
      <h4 className="mt-1 line-clamp-2 text-[12px] font-medium leading-tight text-text-primary">
        {demand.title}
      </h4>
      <div className="mt-1.5 flex items-center gap-2 text-[9.5px] text-text-tertiary">
        {demand.runs_count > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <Activity className="h-2.5 w-2.5" aria-hidden />
            {demand.runs_count}
          </span>
        )}
        {demand.messages_count > 0 && (
          <span className="inline-flex items-center gap-0.5">💬 {demand.messages_count}</span>
        )}
        {demand.last_run_status === 'failed' && (
          <span className="font-medium text-error">último run falhou</span>
        )}
        {demand.last_run_status === 'succeeded' && (
          <span className="font-medium text-success">último run OK</span>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-1.5 border-t border-border/60 pt-2 text-[10px]">
          <div className="flex flex-wrap gap-1">
            {COLUMNS.filter(c => c.status !== currentStatus).map(c => (
              <button
                key={c.status}
                type="button"
                disabled={movePending}
                onClick={e => {
                  e.stopPropagation();
                  onMove(demand.id, c.status);
                }}
                className="rounded-sm border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] text-text-secondary transition hover:border-accent-bright/40 hover:text-text-primary disabled:opacity-50"
              >
                {movePending ? (
                  <Loader2 className="inline h-2.5 w-2.5 animate-spin" />
                ) : (
                  `→ ${c.label}`
                )}
              </button>
            ))}
          </div>
          {/* "Disparar RUN" — dispatches a workflow run linked to this demand.
              Disabled when the demand has no codebase (the run needs a target
              repo). Auto-progress (completeWorkflowRun hook) advances the
              card on completion, so the user does NOT need to move it. */}
          <button
            type="button"
            disabled={!demand.codebase_id}
            onClick={e => {
              e.stopPropagation();
              onOpenRun(demand);
            }}
            title={
              demand.codebase_id
                ? 'Disparar workflow run (auto-avança o card)'
                : 'Demanda sem projeto — associe um projeto primeiro'
            }
            className="flex w-full items-center justify-center gap-1 rounded-sm border border-success/40 bg-success/10 px-2 py-1 text-[10px] font-medium text-success transition hover:bg-success/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlayCircle className="h-3 w-3" aria-hidden />
            Disparar RUN
          </button>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onOpenTimeline(demand);
            }}
            className="flex w-full items-center justify-center gap-1 rounded-sm border border-accent-bright/30 bg-accent-bright/10 px-2 py-1 text-[10px] font-medium text-accent-bright transition hover:bg-accent-bright/20"
          >
            <History className="h-3 w-3" aria-hidden />
            Ver timeline
          </button>
        </div>
      )}
    </div>
  );
}

interface DemandTimelineModalProps {
  demand: Demand | null;
  open: boolean;
  onClose: () => void;
}

function DemandTimelineModal({
  demand,
  open,
  onClose,
}: DemandTimelineModalProps): ReactElement | null {
  const [data, setData] = useState<DemandTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Refetch timeline whenever the modal opens or the demand changes.
  // Modal is single-instance per page — no need for a cache layer.
  useEffect(() => {
    if (!open || !demand) return;
    const cancelledRef = { value: false };
    setLoading(true);
    getDemandTimeline(demand.id, 200)
      .then((t): void => {
        if (cancelledRef.value) return;
        setData(t);
      })
      .catch((e: unknown): void => {
        if (cancelledRef.value) return;
        setNoteError(e instanceof Error ? e.message : String(e));
      })
      .finally((): void => {
        if (cancelledRef.value) return;
        setLoading(false);
      });
    return (): void => {
      cancelledRef.value = true;
    };
  }, [open, demand]);

  const onSubmitNote = useCallback(
    (e: React.FormEvent): void => {
      e.preventDefault();
      if (!demand || !note.trim() || addingNote) return;
      setAddingNote(true);
      setNoteError(null);
      addNote(demand.id, note.trim())
        .then(() => {
          setNote('');
          // Re-fetch the timeline so the new note shows up immediately
          return getDemandTimeline(demand.id, 200);
        })
        .then(t => {
          setData(t);
        })
        .catch((err: unknown) => {
          setNoteError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setAddingNote(false);
        });
    },
    [demand, note, addingNote]
  );

  if (!open || !demand) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[920px] flex-col rounded-[12px] border border-border bg-surface shadow-2xl"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent-bright" aria-hidden />
              <h2 className="text-[15px] font-semibold text-text-primary">Timeline da demanda</h2>
              <span className="font-mono text-[10.5px] text-text-tertiary">{demand.slug}</span>
            </div>
            <h3 className="mt-0.5 truncate text-[17px] font-semibold text-text-primary">
              {demand.title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-text-tertiary">
              <span className="rounded-full border border-border bg-surface-inset px-2 py-0.5 font-mono text-[10.5px]">
                {demand.status}
              </span>
              <span>· {demand.priority}</span>
              <span>· {demand.runs_count} runs</span>
              <span>· {demand.messages_count} mensagens</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-tertiary transition hover:bg-surface-hover hover:text-text-primary"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {data && (
          <div className="grid grid-cols-2 gap-2 border-b border-border bg-surface-inset p-3 sm:grid-cols-4">
            <TotalCell label="Atividades" value={String(data.totals.activities)} />
            <TotalCell label="Runs" value={String(data.totals.runs)} />
            <TotalCell label="Custo USD" value={data.totals.cost_total_usd.toFixed(4)} />
            <TotalCell label="Custo BRL" value={data.totals.cost_total_brl.toFixed(2)} />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-[12.5px]">Carregando timeline…</span>
            </div>
          ) : !data || data.entries.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center text-text-tertiary">
              <Activity className="h-6 w-6 opacity-40" aria-hidden />
              <p className="mt-2 text-[12.5px]">Nenhuma atividade registrada ainda.</p>
            </div>
          ) : (
            <ol className="space-y-1.5">
              {data.entries.map((entry, i) => (
                <TimelineRow key={`${entry.kind}-${entry.at}-${String(i)}`} entry={entry} />
              ))}
            </ol>
          )}
        </div>

        <div className="border-t border-border p-3">
          <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
            Adicionar nota
          </div>
          <form onSubmit={onSubmitNote} className="flex gap-2">
            <textarea
              value={note}
              onChange={e => {
                setNote(e.target.value);
              }}
              placeholder="Ex: cliente pediu pra mudar o prazo..."
              rows={2}
              className="flex-1 resize-none rounded-md border border-border bg-surface-inset px-3 py-2 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright"
            />
            <button
              type="submit"
              disabled={!note.trim() || addingNote}
              className="self-end rounded-md bg-accent-bright px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {addingNote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Adicionar'}
            </button>
          </form>
          {noteError && <p className="mt-1 text-[11px] text-error">{noteError}</p>}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: DemandTimelineEntry }): ReactElement {
  // PascalCase icon lookup: `kindToIcon` returns a React component type,
  // not a value, so the camelCase rule doesn't apply. Same pattern as
  // the FORGE DemandTimelineModal.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const IconComponent: LucideIcon = kindToIcon(entry.kind);
  return (
    <li className="flex gap-3 rounded-md border border-border/60 bg-surface-inset p-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-secondary">
        <IconComponent className="h-3 w-3" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-medium text-text-primary">
            {entry.title}
          </span>
          <time className="shrink-0 font-mono text-[10.5px] text-text-tertiary">
            {formatTime(entry.at)}
          </time>
        </div>
        {entry.detail && (
          <p className="mt-0.5 line-clamp-2 text-[11.5px] text-text-secondary">{entry.detail}</p>
        )}
      </div>
    </li>
  );
}

function TotalCell({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-md border border-border/60 bg-surface px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function kindToIcon(kind: DemandTimelineEntry['kind']): LucideIcon {
  switch (kind) {
    case 'activity':
      return Activity;
    case 'run':
      return PlayCircle;
    case 'cost':
      return Receipt;
    case 'message':
      return MessageSquare;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function ErrorState({ error }: { error: Error }): ReactElement {
  return (
    <div className="m-6 rounded-[12px] border border-error/40 bg-error/5 p-5">
      <div className="text-[13px] font-semibold text-error">Erro ao carregar demandas</div>
      <div className="mt-1 text-[12px] text-text-secondary">{error.message}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateDemandModal — "+ Nova" modal.
//
// New demands always start in the Backlog column (backend forces
// status='backlog' on POST; the schema has no `status` field on create).
// From the Backlog the user clicks "Disparar RUN" on the card to advance
// the demand through the pipeline — the auto-progress hooks
// (`completeWorkflowRun` / `failWorkflowRun`) update the status
// forward-only as the Builder works.
// ---------------------------------------------------------------------------
interface CreateDemandModalProps {
  open: boolean;
  clients: Client[];
  projects: ProjectSummary[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateDemandModal({
  open,
  clients,
  projects,
  onClose,
  onCreated,
}: CreateDemandModalProps): ReactElement | null {
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const [codebaseId, setCodebaseId] = useState('');
  const [priority, setPriority] = useState<'baixa' | 'media' | 'alta' | 'urgente'>('media');
  const [dueDate, setDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form whenever the modal closes — keeps stale input from
  // leaking into the next open.
  useEffect(() => {
    if (open) return;
    setSlug('');
    setTitle('');
    setDescription('');
    setClientId('');
    setCodebaseId('');
    setPriority('media');
    setDueDate('');
    setSubmitError(null);
  }, [open]);

  if (!open) return null;

  // Filter projects to the selected client so a PSCODE demand can't
  // accidentally point at an "Another Client" project.
  const filteredProjects = clientId ? projects.filter(p => p.client_id === clientId) : projects;

  const canSubmit = slug.trim().length >= 3 && title.trim().length > 0 && clientId !== '';

  function onSubmitForm(e: React.FormEvent): void {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const body: CreateDemandBody = {
      slug: slug.trim().toUpperCase(),
      title: title.trim(),
      client_id: clientId,
      ...(codebaseId ? { codebase_id: codebaseId } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      priority,
      ...(dueDate ? { due_date: new Date(dueDate).toISOString() } : {}),
    };
    apiCreateDemand(body)
      .then(() => {
        onCreated();
      })
      .catch((err: unknown) => {
        setSubmitError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col rounded-[12px] border border-border bg-surface shadow-2xl"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-accent-bright" aria-hidden />
              <h2 className="text-[15px] font-semibold text-text-primary">Nova demanda</h2>
            </div>
            <p className="mt-1 text-[11.5px] text-text-tertiary">
              Criada como <span className="font-mono text-accent-bright">backlog</span>. O Builder
              do HarnessOS move a demanda pelas etapas do Kanban conforme trabalha.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-tertiary transition hover:bg-surface-hover hover:text-text-primary"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={onSubmitForm} className="flex flex-col overflow-hidden">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                  Slug
                </span>
                <input
                  value={slug}
                  onChange={e => {
                    setSlug(e.target.value);
                  }}
                  placeholder="PSCODE-EC-FSM-2026-013"
                  required
                  minLength={3}
                  pattern="[A-Z0-9][A-Z0-9-]*"
                  className="mt-1 w-full rounded-md border border-border bg-surface-inset px-3 py-1.5 font-mono text-[12.5px] text-text-primary outline-none focus:border-accent-bright"
                />
              </label>
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                  Prioridade
                </span>
                <select
                  value={priority}
                  onChange={e => {
                    setPriority(e.target.value as typeof priority);
                  }}
                  className="mt-1 w-full rounded-md border border-border bg-surface-inset px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none focus:border-accent-bright"
                >
                  <option value="baixa">baixa</option>
                  <option value="media">média</option>
                  <option value="alta">alta</option>
                  <option value="urgente">urgente</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                Título
              </span>
              <input
                value={title}
                onChange={e => {
                  setTitle(e.target.value);
                }}
                placeholder="Implementar feature X no projeto Y"
                required
                className="mt-1 w-full rounded-md border border-border bg-surface-inset px-3 py-1.5 text-[12.5px] text-text-primary outline-none focus:border-accent-bright"
              />
            </label>

            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                Descrição
              </span>
              <textarea
                value={description}
                onChange={e => {
                  setDescription(e.target.value);
                }}
                rows={3}
                placeholder="Contexto, critérios de aceitação, links…"
                className="mt-1 w-full resize-none rounded-md border border-border bg-surface-inset px-3 py-2 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright"
              />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                  Cliente
                </span>
                <select
                  value={clientId}
                  onChange={e => {
                    setClientId(e.target.value);
                    setCodebaseId('');
                  }}
                  required
                  className="mt-1 w-full rounded-md border border-border bg-surface-inset px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none focus:border-accent-bright"
                >
                  <option value="">Selecione um cliente…</option>
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                  Projeto
                </span>
                <select
                  value={codebaseId}
                  onChange={e => {
                    setCodebaseId(e.target.value);
                  }}
                  disabled={filteredProjects.length === 0}
                  className="mt-1 w-full rounded-md border border-border bg-surface-inset px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none disabled:opacity-50"
                >
                  <option value="">(sem projeto)</option>
                  {filteredProjects.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                Data limite (opcional)
              </span>
              <input
                type="date"
                value={dueDate}
                onChange={e => {
                  setDueDate(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-border bg-surface-inset px-3 py-1.5 text-[12.5px] text-text-primary outline-none focus:border-accent-bright"
              />
            </label>

            {submitError && (
              <p className="rounded-md border border-error/30 bg-error/5 px-3 py-2 text-[12px] text-error">
                {submitError}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border p-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-text-secondary transition hover:text-text-primary disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit || submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-bright px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Criar como backlog
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunDemandModal — "Disparar RUN" modal.
//
// Triggers a workflow run linked to the demand via
// `workflow_run.demand_id`. The run is fire-and-forget: the HTTP
// response returns immediately, and the demand's status auto-advances
// as the run moves through its lifecycle:
//   - run_started      → activity row logged
//   - run_completed    → demand status advances forward
//   - run_failed       → demand status set to 'bloqueada'
// The user does NOT need to move the card manually after this.
// ---------------------------------------------------------------------------
interface RunDemandModalProps {
  demand: Demand | null;
  open: boolean;
  onClose: () => void;
  onDispatched: () => void;
}

function RunDemandModal({
  demand,
  open,
  onClose,
  onDispatched,
}: RunDemandModalProps): ReactElement | null {
  const [workflow, setWorkflow] = useState('implement');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form whenever the modal closes — each demand is its own scope.
  useEffect(() => {
    if (open) return;
    setWorkflow('implement');
    setMessage('');
    setSubmitError(null);
  }, [open]);

  if (!open || !demand) return null;

  const canSubmit = workflow.trim().length > 0 && message.trim().length > 0;

  function onSubmitForm(e: React.FormEvent): void {
    e.preventDefault();
    if (!canSubmit || submitting || !demand) return;
    setSubmitting(true);
    setSubmitError(null);
    const body: RunDemandBody = {
      workflow: workflow.trim(),
      message: message.trim(),
      triggered_by: 'manual',
    };
    apiRunDemand(demand.id, body)
      .then(() => {
        onDispatched();
      })
      .catch((err: unknown) => {
        setSubmitError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col rounded-[12px] border border-border bg-surface shadow-2xl"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <PlayCircle className="h-4 w-4 text-success" aria-hidden />
              <h2 className="text-[15px] font-semibold text-text-primary">Disparar RUN</h2>
            </div>
            <p className="mt-1 truncate font-mono text-[11.5px] text-text-tertiary">
              {demand.slug} — {demand.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-tertiary transition hover:bg-surface-hover hover:text-text-primary"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={onSubmitForm} className="flex flex-col overflow-hidden">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                Workflow
              </span>
              <input
                value={workflow}
                onChange={e => {
                  setWorkflow(e.target.value);
                }}
                placeholder="implement"
                required
                className="mt-1 w-full rounded-md border border-border bg-surface-inset px-3 py-1.5 font-mono text-[12.5px] text-text-primary outline-none focus:border-accent-bright"
              />
            </label>
            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-text-tertiary">
                Mensagem inicial
              </span>
              <textarea
                value={message}
                onChange={e => {
                  setMessage(e.target.value);
                }}
                rows={4}
                required
                placeholder="Contexto, objetivo da run, referências…"
                className="mt-1 w-full resize-none rounded-md border border-border bg-surface-inset px-3 py-2 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright"
              />
            </label>
            <p className="text-[11px] text-text-tertiary">
              A run é disparada em segundo plano — o card avança automaticamente conforme o Builder
              trabalha.
            </p>
            {submitError && (
              <p className="rounded-md border border-error/30 bg-error/5 px-3 py-2 text-[12px] text-error">
                {submitError}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border p-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-text-secondary transition hover:text-text-primary disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit || submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              Disparar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
