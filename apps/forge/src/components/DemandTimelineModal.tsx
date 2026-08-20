/**
 * HarnessOS Projetos — Demand timeline modal.
 *
 * Shows the full chronological story of a single demand:
 *   - Status changes (manual or auto from a workflow run)
 *   - Priority changes
 *   - Workflow run start / complete / fail
 *   - Chat messages attributed to this demand
 *   - Cost rows (LLM calls)
 *   - Manual notes from humans
 *
 * Used by DemandasPage when the user clicks "Ver timeline" on a
 * demand card. Single source of truth for "where is this demand and
 * what happened to it".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { JSX } from 'react';
import {
  X,
  Activity,
  PlayCircle,
  MessageSquare,
  Receipt,
  Loader2,
  RefreshCcw,
} from 'lucide-react';
import { api, type Demand, type DemandStatus, type DemandPriority, type DemandTimeline } from '../lib/api';
import { cn } from '../lib/cn';

interface DemandTimelineModalProps {
  demand: Demand;
  open: boolean;
  onClose: () => void;
}

export function DemandTimelineModal({ demand, open, onClose }: DemandTimelineModalProps): JSX.Element | null {
  const qc = useQueryClient();
  const [noteText, setNoteText] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery<DemandTimeline>({
    queryKey: ['forge', 'demand-timeline', demand.id],
    queryFn: () => api.demands.timeline(demand.id, 200),
    enabled: open,
  });

  const addActivity = useMutation({
    mutationFn: (body: { note: string; action?: 'note' | 'status_change' | 'priority_change' }) =>
      api.demands.addActivity(demand.id, body),
    onSuccess: () => {
      setNoteText('');
      void qc.invalidateQueries({ queryKey: ['forge', 'demand-timeline', demand.id] });
      void qc.invalidateQueries({ queryKey: ['forge', 'demands'] });
    },
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[920px] flex-col rounded-[12px] border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[var(--brand-magenta)]" aria-hidden />
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Timeline da demanda</h2>
              <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">
                {demand.slug}
              </span>
            </div>
            <h3 className="mt-0.5 truncate text-[18px] font-semibold text-[var(--text-primary)]">
              {demand.title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-tertiary)]">
              <span className={cn('rounded-full border px-2 py-0.5', statusBadgeClass(demand.status))}>
                {demand.status}
              </span>
              <span>·</span>
              <span>{demand.priority}</span>
              <span>·</span>
              <span>{demand.runs_count} runs</span>
              <span>·</span>
              <span>{demand.messages_count} mensagens</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* Totals bar */}
        {data && (
          <div className="grid grid-cols-2 gap-2 border-b border-[var(--border)] bg-[var(--surface-inset)] p-3 sm:grid-cols-4">
            <TotalCell label="Atividades" value={String(data.totals.activities)} />
            <TotalCell label="Runs" value={String(data.totals.runs)} />
            <TotalCell label="Custo (USD)" value={data.totals.cost_total_usd.toFixed(4)} />
            <TotalCell label="Custo (BRL)" value={data.totals.cost_total_brl.toFixed(2)} />
          </div>
        )}

        {/* Body — list of timeline entries */}
        <div className="flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-[var(--text-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-[12.5px]">Carregando timeline…</span>
            </div>
          ) : !data || data.entries.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center text-[var(--text-tertiary)]">
              <Activity className="h-6 w-6 opacity-40" aria-hidden />
              <p className="mt-2 text-[12.5px]">Nenhuma atividade registrada ainda.</p>
            </div>
          ) : (
            <ol className="space-y-1.5">
              {data.entries.map((entry, i) => (
                <TimelineRow key={`${entry.kind}-${entry.at}-${i}`} entry={entry} />
              ))}
            </ol>
          )}
        </div>

        {/* Add-note footer */}
        <div className="border-t border-[var(--border)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
              Adicionar nota
            </span>
            <button
              type="button"
              onClick={() => {
                void refetch();
              }}
              disabled={isFetching}
              className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <RefreshCcw className={cn('h-3 w-3', isFetching && 'animate-spin')} aria-hidden />
              Atualizar
            </button>
          </div>
          <form
            onSubmit={e => {
              e.preventDefault();
              if (noteText.trim() && !addActivity.isPending) {
                addActivity.mutate({ note: noteText.trim(), action: 'note' });
              }
            }}
            className="flex gap-2"
          >
            <textarea
              value={noteText}
              onChange={e => {
                setNoteText(e.target.value);
              }}
              placeholder="Ex: cliente pediu pra mudar o prazo..."
              rows={2}
              className="flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!noteText.trim() || addActivity.isPending}
              className="self-end rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {addActivity.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                'Adicionar'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: import('../lib/api').DemandTimelineEntry }): JSX.Element {
  const { kind, at, title, detail } = entry;
  // PascalCase for React component references (icon lookup returns a component type)
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const IconComponent = kindToIcon(kind);
  const colorClass = kindToColor(kind);

  return (
    <li className="flex gap-3 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] p-2.5">
      <div className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', colorClass)}>
        <IconComponent className="h-3 w-3" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{title}</span>
          <time className="shrink-0 font-mono text-[10.5px] text-[var(--text-tertiary)]">
            {formatTime(at)}
          </time>
        </div>
        {detail && (
          <p className="mt-0.5 line-clamp-2 text-[11.5px] text-[var(--text-secondary)]">{detail}</p>
        )}
      </div>
    </li>
  );
}

function TotalCell({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function kindToIcon(kind: 'activity' | 'run' | 'cost' | 'message'): typeof Activity {
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

function kindToColor(kind: 'activity' | 'run' | 'cost' | 'message'): string {
  switch (kind) {
    case 'activity':
      return 'bg-[var(--text-tertiary)]/10 text-[var(--text-tertiary)]';
    case 'run':
      return 'bg-[var(--info)]/10 text-[var(--info)]';
    case 'cost':
      return 'bg-[var(--warning)]/10 text-[var(--warning)]';
    case 'message':
      return 'bg-[var(--brand-magenta)]/10 text-[var(--brand-magenta)]';
  }
}

function statusBadgeClass(status: DemandStatus): string {
  switch (status) {
    case 'concluido':
      return 'border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]';
    case 'bloqueada':
      return 'border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]';
    case 'em_andamento':
      return 'border-[var(--brand-magenta)]/30 bg-[var(--brand-magenta)]/10 text-[var(--brand-magenta)]';
    case 'cancelado':
      return 'border-[var(--text-tertiary)]/30 bg-[var(--text-tertiary)]/10 text-[var(--text-tertiary)]';
    default:
      return 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]';
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

// Re-export for the parent page
export type { Demand, DemandStatus, DemandPriority };
