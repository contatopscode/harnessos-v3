import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Demand, type Client, type ProjectSummary, ApiError } from '../lib/api';
import { Loader2, Plus, Search, Activity, History, Filter, X, AlertCircle } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';
import { cn } from '../lib/cn';
import { DemandTimelineModal } from '../components/DemandTimelineModal';

const COLUMNS: { status: Demand['status']; label: string; accent: string }[] = [
  { status: 'backlog', label: 'Backlog', accent: 'var(--text-tertiary)' },
  { status: 'triagem', label: 'Triagem / Análise', accent: 'var(--running)' },
  { status: 'requisitos', label: 'Requisitos', accent: 'var(--brand-violet)' },
  { status: 'aprovacao_cliente', label: 'Aprovação Cliente', accent: 'var(--warning)' },
  { status: 'em_andamento', label: 'Em andamento', accent: 'var(--success)' },
  { status: 'bloqueada', label: 'Bloqueada', accent: 'var(--error)' },
  { status: 'concluido', label: 'Concluído', accent: 'var(--success)' },
  { status: 'cancelado', label: 'Cancelado', accent: 'var(--text-tertiary)' },
];

export function DemandasPage(): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState<string>('');
  const [codebaseId, setCodebaseId] = useState<string>('');
  const [timelineFor, setTimelineFor] = useState<Demand | null>(null);
  // Create-demand modal state. The backend forces status='backlog' for all
  // new demands (the schema has no `status` field on POST), so FORGE-created
  // demands always land in the Backlog column. Project managers move them
  // through the pipeline from the HarnessOS Console; the FORGE view stays
  // read-only for status.
  const [createOpen, setCreateOpen] = useState(false);

  const { data: clients } = useQuery({
    queryKey: ['forge', 'clients', 'all'],
    queryFn: () => api.clients.list(),
  });
  const { data: projects } = useQuery({
    queryKey: ['forge', 'projects', 'all'],
    queryFn: () => api.projects.list(),
  });

  // Available projects for the selected client (so the user can pick
  // project-after-client without scrolling through every project in the
  // system). Falls back to all projects when no client is picked.
  const filteredProjects = clientId
    ? (projects?.projects ?? []).filter(p => p.client_id === clientId)
    : (projects?.projects ?? []);

  // Create-demand mutation. The backend forces status='backlog' so the new
  // card always lands in the Backlog column. After success we close the
  // modal + invalidate the board query so the new card appears.
  const createDemand = useMutation({
    mutationFn: api.demands.create,
    onSuccess: () => {
      setCreateOpen(false);
      void qc.invalidateQueries({ queryKey: ['forge', 'demands'] });
    },
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['forge', 'demands', 'board', search, clientId, codebaseId],
    queryFn: () =>
      api.demands.board({
        search: search || undefined,
        clientId: clientId || undefined,
        codebaseId: codebaseId || undefined,
      }),
  });

  const filtersActive = clientId !== '' || codebaseId !== '' || search !== '';

  return (
    <div>
      <header className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Demandas</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Board somente-leitura — cards avançam pelas fases conforme o Builder trabalha no
            HarnessOS.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type="search"
              placeholder="Buscar slug, título…"
              value={search}
              onChange={e => {
                setSearch(e.target.value);
              }}
              className="w-[220px] rounded-md border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-8 pr-3 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setCreateOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Nova demanda
          </button>
        </div>
      </header>

      {/* Filter strip: Cliente + Projeto. Reset button limpa todos os filtros
          de uma vez — útil quando o board fica vazio após um filtro agressivo. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
          <Filter className="h-3.5 w-3.5" aria-hidden />
          Filtros
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <select
            value={clientId}
            onChange={e => {
              setClientId(e.target.value);
              // Reset project when the client changes (the old project might
              // not belong to the new client — keeps the filter consistent).
              setCodebaseId('');
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--brand-magenta)] focus:outline-none"
          >
            <option value="">Todos os clientes</option>
            {(clients?.clients ?? []).map(c => (
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
            className="rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--brand-magenta)] focus:outline-none"
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
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
              title="Limpar filtros"
            >
              <X className="h-3 w-3" aria-hidden />
              Limpar
            </button>
          )}
        </div>
        <div className="text-[11px] text-[var(--text-tertiary)]">
          {data?.total ?? 0} demanda{data?.total === 1 ? '' : 's'}
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-64 items-center justify-center gap-2 text-[var(--text-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-[13px]">Carregando board…</span>
        </div>
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {data?.columns.map(col => (
            <Column
              key={col.status}
              status={col.status}
              label={COLUMNS.find(c => c.status === col.status)?.label ?? col.status}
              accent={COLUMNS.find(c => c.status === col.status)?.accent ?? 'var(--text-tertiary)'}
              demands={col.demands}
              onOpenTimeline={d => {
                setTimelineFor(d);
              }}
            />
          ))}
        </div>
      )}

      <DemandTimelineModal
        demand={timelineFor ?? data?.columns[0]?.demands[0] ?? ({} as Demand)}
        open={timelineFor !== null}
        onClose={() => {
          setTimelineFor(null);
        }}
      />

      <CreateDemandModal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        clients={clients?.clients ?? []}
        projects={projects?.projects ?? []}
        onSubmit={body => {
          createDemand.mutate(body);
        }}
        isSubmitting={createDemand.isPending}
        errorMessage={
          createDemand.error
            ? createDemand.error instanceof ApiError
              ? createDemand.error.message
              : 'Erro inesperado ao criar demanda'
            : null
        }
      />
    </div>
  );
}

interface ColumnProps {
  status: Demand['status'];
  label: string;
  accent: string;
  demands: Demand[];
  onOpenTimeline: (demand: Demand) => void;
}

function Column({ label, accent, demands, onOpenTimeline }: ColumnProps): JSX.Element {
  return (
    <div className="flex min-h-[120px] flex-col rounded-[10px] bg-[var(--surface-inset)]/60 p-2">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} aria-hidden />
          <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
            {label}
          </span>
        </div>
        <span className="rounded-md bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--text-tertiary)]">
          {demands.length}
        </span>
      </div>
      <div className="flex-1 space-y-1.5">
        {demands.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border)] py-6 text-center text-[10.5px] text-[var(--text-tertiary)]">
            vazio
          </div>
        ) : (
          demands.map(d => <Card key={d.id} demand={d} onOpenTimeline={onOpenTimeline} />)
        )}
      </div>
    </div>
  );
}

interface CardProps {
  demand: Demand;
  onOpenTimeline: (demand: Demand) => void;
}

function Card({ demand, onOpenTimeline }: CardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const priorityColor =
    demand.priority === 'urgente'
      ? 'var(--error)'
      : demand.priority === 'alta'
        ? 'var(--warning)'
        : 'var(--text-tertiary)';
  const isBlocked = demand.status === 'bloqueada';
  // FORGE é somente-leitura: status muda no HarnessOS Builder.
  // O card mostra o estado atual e abre um modal de timeline ao clicar.
  return (
    <div
      onClick={() => {
        setOpen(o => !o);
      }}
      className={cn(
        'group cursor-pointer rounded-md border bg-[var(--surface)] p-2.5 transition hover:border-[var(--border-bright)] hover:bg-[var(--surface-elevated)]',
        isBlocked ? 'border-[var(--error)]/40 bg-[var(--error-soft)]/30' : 'border-[var(--border)]',
        open && 'ring-1 ring-[var(--accent-ring)]'
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="truncate font-mono text-[10.5px] text-[var(--text-tertiary)]">
          {demand.slug}
        </span>
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: priorityColor }}
          title={`prioridade ${demand.priority}`}
          aria-label={`prioridade ${demand.priority}`}
        />
      </div>
      <h4 className="mt-1 line-clamp-2 text-[12.5px] font-medium leading-tight text-[var(--text-primary)]">
        {demand.title}
      </h4>
      {/* Counter strip — shows at-a-glance activity from the audit trail */}
      <div className="mt-1.5 flex items-center gap-2 text-[9.5px] text-[var(--text-tertiary)]">
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
          <span className="font-medium text-[var(--error)]">último run falhou</span>
        )}
        {demand.last_run_status === 'succeeded' && (
          <span className="font-medium text-[var(--success)]">último run OK</span>
        )}
      </div>
      {open && (
        <div className="mt-2 border-t border-[var(--border)] pt-2 text-[10.5px]">
          <p className="px-1 pb-1.5 text-[10px] text-[var(--text-tertiary)]">
            Status controlado pelo Builder no HarnessOS. Abra a timeline para acompanhar.
          </p>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onOpenTimeline(demand);
            }}
            className="flex w-full items-center justify-center gap-1 rounded-sm bg-[var(--brand-magenta)]/10 px-2 py-1 text-[10px] font-medium text-[var(--brand-magenta)] transition hover:bg-[var(--brand-magenta)]/20"
          >
            <History className="h-3 w-3" aria-hidden />
            Ver timeline ({demand.runs_count + demand.messages_count} eventos)
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorState({ error }: { error: Error }): JSX.Element {
  const isApiError = error instanceof ApiError;
  return (
    <div className="rounded-[12px] border border-[var(--error)]/40 bg-[var(--error-soft)] p-5">
      <div className="text-[13px] font-semibold text-[var(--error)]">
        {isApiError ? `Erro ${String(error.status)}` : 'Erro inesperado'}
      </div>
      <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{error.message}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateDemandModal — New demand form. FORGE creates always land in the
// Backlog column (backend forces status='backlog' on POST; the schema
// has no `status` field). Project managers move them through the
// pipeline from the HarnessOS Console; the FORGE view stays read-only
// for status (per "Status controlado pelo Builder" rule).
// ---------------------------------------------------------------------------
interface CreateDemandModalProps {
  open: boolean;
  onClose: () => void;
  clients: Client[];
  projects: ProjectSummary[];
  onSubmit: (body: {
    slug: string;
    title: string;
    description?: string;
    client_id: string;
    codebase_id?: string;
    priority?: 'baixa' | 'media' | 'alta' | 'urgente';
    due_date?: string;
  }) => void;
  isSubmitting: boolean;
  errorMessage: string | null;
}

function CreateDemandModal({
  open,
  onClose,
  clients,
  projects,
  onSubmit,
  isSubmitting,
  errorMessage,
}: CreateDemandModalProps): JSX.Element | null {
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const [codebaseId, setCodebaseId] = useState('');
  const [priority, setPriority] = useState<'baixa' | 'media' | 'alta' | 'urgente'>('media');
  const [dueDate, setDueDate] = useState('');

  if (!open) return null;

  // Projects filtered by selected client (so a PSCODE demand can't
  // accidentally get pointed at an "Another Client" project).
  const filteredProjects = clientId ? projects.filter(p => p.client_id === clientId) : projects;

  const canSubmit = slug.trim().length >= 3 && title.trim().length > 0 && clientId !== '';

  function onSubmitForm(e: React.FormEvent): void {
    e.preventDefault();
    if (!canSubmit || isSubmitting) return;
    onSubmit({
      slug: slug.trim().toUpperCase(),
      title: title.trim(),
      ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      client_id: clientId,
      ...(codebaseId ? { codebase_id: codebaseId } : {}),
      priority,
      ...(dueDate ? { due_date: new Date(dueDate).toISOString() } : {}),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col rounded-[12px] border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-[var(--brand-magenta)]" aria-hidden />
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Nova demanda</h2>
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--text-tertiary)]">
              Criada como <span className="font-mono text-[var(--brand-magenta)]">backlog</span>. O
              Builder do HarnessOS move a demanda pelas etapas do Kanban.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={onSubmitForm} className="flex flex-col overflow-hidden">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
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
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-1.5 font-mono text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-magenta)]"
                />
              </label>
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                  Prioridade
                </span>
                <select
                  value={priority}
                  onChange={e => {
                    setPriority(e.target.value as typeof priority);
                  }}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-magenta)]"
                >
                  <option value="baixa">baixa</option>
                  <option value="media">média</option>
                  <option value="alta">alta</option>
                  <option value="urgente">urgente</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                Título
              </span>
              <input
                value={title}
                onChange={e => {
                  setTitle(e.target.value);
                }}
                placeholder="Implementar feature X no projeto Y"
                required
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-magenta)]"
              />
            </label>

            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                Descrição
              </span>
              <textarea
                value={description}
                onChange={e => {
                  setDescription(e.target.value);
                }}
                rows={3}
                placeholder="Contexto, critérios de aceitação, links…"
                className="mt-1 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)]"
              />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                  Cliente
                </span>
                <select
                  value={clientId}
                  onChange={e => {
                    setClientId(e.target.value);
                    setCodebaseId('');
                  }}
                  required
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-magenta)]"
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
                <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                  Projeto
                </span>
                <select
                  value={codebaseId}
                  onChange={e => {
                    setCodebaseId(e.target.value);
                  }}
                  disabled={filteredProjects.length === 0}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-magenta)] disabled:opacity-50"
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
              <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                Data limite (opcional)
              </span>
              <input
                type="date"
                value={dueDate}
                onChange={e => {
                  setDueDate(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-magenta)]"
              />
            </label>

            {errorMessage && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-[12px] text-[var(--error)]">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{errorMessage}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] p-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (
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
