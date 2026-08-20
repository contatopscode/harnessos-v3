import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Demand, type DemandStatus, ApiError } from '../lib/api';
import { Loader2, Plus, Search, Activity, History } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';
import { cn } from '../lib/cn';
import { DemandTimelineModal } from '../components/DemandTimelineModal';

const COLUMNS: { status: DemandStatus; label: string; accent: string }[] = [
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
  const [timelineFor, setTimelineFor] = useState<Demand | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['forge', 'demands', 'board', search],
    queryFn: () => api.demands.board({ search: search || undefined }),
  });

  const moveStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DemandStatus }) =>
      api.demands.updateStatus(id, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forge', 'demands'] });
    },
  });

  return (
    <div>
      <header className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Demandas</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Board único — cards avançam pelas fases da pipeline.
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
              className="w-[260px] rounded-md border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-8 pr-3 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none"
            />
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Nova demanda
          </button>
        </div>
      </header>

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
              onMove={(id, status) => {
                moveStatus.mutate({ id, status });
              }}
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
}

function Column({ label, accent, demands, onMove, onOpenTimeline }: ColumnProps): JSX.Element {
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
          demands.map(d => <Card key={d.id} demand={d} onMove={onMove} onOpenTimeline={onOpenTimeline} />)
        )}
      </div>
    </div>
  );
}

interface CardProps {
  demand: Demand;
  onMove: (id: string, status: DemandStatus) => void;
  onOpenTimeline: (demand: Demand) => void;
}

function Card({ demand, onMove, onOpenTimeline }: CardProps): JSX.Element {
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
      className={cn(
        'group cursor-pointer rounded-md border bg-[var(--surface)] p-2.5 transition hover:border-[var(--border-bright)] hover:bg-[var(--surface-elevated)]',
        isBlocked
          ? 'border-[var(--error)]/40 bg-[var(--error-soft)]/30'
          : 'border-[var(--border)]',
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
          <span className="inline-flex items-center gap-0.5">
            💬 {demand.messages_count}
          </span>
        )}
        {demand.last_run_status === 'failed' && (
          <span className="font-medium text-[var(--error)]">último run falhou</span>
        )}
        {demand.last_run_status === 'succeeded' && (
          <span className="font-medium text-[var(--success)]">último run OK</span>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-1.5 border-t border-[var(--border)] pt-2 text-[10.5px]">
          <div className="flex flex-wrap gap-1">
            {COLUMNS.filter(c => c.status !== demand.status).map(c => (
              <button
                key={c.status}
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onMove(demand.id, c.status);
                }}
                className="rounded-sm bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              >
                → {c.label.split(' ')[0]}
              </button>
            ))}
          </div>
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
