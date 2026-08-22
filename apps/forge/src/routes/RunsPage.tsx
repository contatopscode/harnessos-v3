/**
 * HarnessOS Projetos — Runs view.
 *
 * Live feed of every workflow run (running, completed, failed, cancelled).
 * Backed by GET /api/dashboard/runs (the same enriched payload the Command
 * Center uses) — gives us project name, client (via projects lookup),
 * workflow name, current step, agent progress, all in one shot.
 *
 * Polled every 3s so the cards visibly move as runs progress. No
 * WebSocket dependency — the polling cadence matches the Kanban board
 * so the user gets the same "feels live" feel across both pages.
 */
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Filter,
  GitBranch,
  Loader2,
  Play,
  Search,
  Tag,
  XCircle,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { api, type DashboardRun, type ProjectSummary, type WorkflowRunStatus } from '../lib/api';
import { cn } from '../lib/cn';

const STATUS_OPTIONS: { value: '' | WorkflowRunStatus; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'running', label: 'Rodando' },
  { value: 'completed', label: 'Concluído' },
  { value: 'failed', label: 'Falhou' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'paused', label: 'Pausado' },
];

export function RunsPage(): JSX.Element {
  const [status, setStatus] = useState<'' | WorkflowRunStatus>('');
  const [codebaseId, setCodebaseId] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  // Projects (codebases) — used to enrich runs with client_name. Cached
  // by React Query; same query key as ProjetosPage so we don't double-fetch.
  const { data: projectsData } = useQuery({
    queryKey: ['forge', 'projects'],
    queryFn: () => api.projects.list(),
    // Projects change rarely; 60s is plenty.
    staleTime: 60_000,
  });
  const projects = projectsData?.projects ?? [];
  const projectById = useMemo(() => {
    const map = new Map<string, ProjectSummary>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['forge', 'runs', 'dashboard', status, codebaseId, search],
    queryFn: () =>
      api.runs.dashboardList({
        ...(status ? { status } : {}),
        ...(codebaseId ? { codebaseId } : {}),
        ...(search ? { search } : {}),
        limit: 100,
      }),
    // Live feel — 3s poll. Pauses when tab is hidden (React Query default).
    refetchInterval: 3000,
  });

  const runs = data?.runs ?? [];
  const counts = data?.counts;

  const filtersActive = status !== '' || codebaseId !== '' || search !== '';

  return (
    <div>
      <header className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Runs</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Feed ao vivo de todas as execuções de workflow — projeto, cliente, etapa atual e
            progresso.
          </p>
        </div>
        <div className="text-[11px] text-[var(--text-tertiary)]">
          {data?.total ?? 0} run{data?.total === 1 ? '' : 's'} no total
        </div>
      </header>

      {/* Counts strip — quick glance at the queue health */}
      {counts && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <CountChip
            label="Rodando"
            value={counts.running}
            icon={Loader2}
            color="var(--running)"
            spin={counts.running > 0}
            active={status === 'running'}
            onClick={() => {
              setStatus(status === 'running' ? '' : 'running');
            }}
          />
          <CountChip
            label="Concluído"
            value={counts.completed}
            icon={CheckCircle2}
            color="var(--success)"
            active={status === 'completed'}
            onClick={() => {
              setStatus(status === 'completed' ? '' : 'completed');
            }}
          />
          <CountChip
            label="Falhou"
            value={counts.failed}
            icon={XCircle}
            color="var(--error)"
            active={status === 'failed'}
            onClick={() => {
              setStatus(status === 'failed' ? '' : 'failed');
            }}
          />
          <CountChip
            label="Cancelado"
            value={counts.cancelled}
            icon={AlertCircle}
            color="var(--text-tertiary)"
            active={status === 'cancelled'}
            onClick={() => {
              setStatus(status === 'cancelled' ? '' : 'cancelled');
            }}
          />
          <CountChip
            label="Pausado"
            value={counts.paused}
            icon={Clock}
            color="var(--warning)"
            active={status === 'paused'}
            onClick={() => {
              setStatus(status === 'paused' ? '' : 'paused');
            }}
          />
        </div>
      )}

      {/* Filter strip */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
          <Filter className="h-3.5 w-3.5" aria-hidden />
          Filtros
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <select
            value={status}
            onChange={e => {
              setStatus(e.target.value as '' | WorkflowRunStatus);
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--brand-magenta)] focus:outline-none"
          >
            {STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
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
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type="search"
              placeholder="Buscar workflow, mensagem…"
              value={search}
              onChange={e => {
                setSearch(e.target.value);
              }}
              className="w-[260px] rounded-md border border-[var(--border)] bg-[var(--surface-inset)] py-1.5 pl-8 pr-3 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none"
            />
          </div>
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setStatus('');
                setCodebaseId('');
                setSearch('');
              }}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            >
              Limpar
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-64 items-center justify-center gap-2 text-[var(--text-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-[13px]">Carregando runs…</span>
        </div>
      ) : error ? (
        <ErrorState error={error} />
      ) : runs.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center">
          <Activity className="mx-auto mb-3 h-8 w-8 text-[var(--text-tertiary)]" />
          <div className="text-[14px] font-medium text-[var(--text-secondary)]">
            Nenhuma run com esses filtros
          </div>
          <div className="mt-1 text-[12px] text-[var(--text-tertiary)]">
            Ajuste os filtros ou dispare uma nova run pelo HarnessOS Console / FORGE Kanban.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map(run => (
            <RunCard
              key={run.id}
              run={run}
              project={run.codebase_id ? (projectById.get(run.codebase_id) ?? null) : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CountChipProps {
  label: string;
  value: number;
  icon: typeof Activity;
  color: string;
  spin?: boolean;
  active: boolean;
  onClick: () => void;
}
function CountChip({
  label,
  value,
  icon,
  color,
  spin,
  active,
  onClick,
}: CountChipProps): JSX.Element {
  // PascalCase required for React component usage
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition',
        active
          ? 'border-[var(--brand-magenta)] bg-[var(--brand-magenta)]/8'
          : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-bright)] hover:bg-[var(--surface-elevated)]'
      )}
    >
      <Icon
        className={cn('h-4 w-4 shrink-0', spin && 'animate-spin')}
        style={{ color }}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-[16px] font-semibold tabular-nums text-[var(--text-primary)]">
          {value}
        </div>
        <div className="truncate text-[10.5px] uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </div>
      </div>
    </button>
  );
}

interface RunCardProps {
  run: DashboardRun;
  project: ProjectSummary | null;
}
function RunCard({ run, project }: RunCardProps): JSX.Element {
  const isActive = run.status === 'running';
  const isFailed = run.status === 'failed';
  const isCancelled = run.status === 'cancelled';

  // Border accent on the left to make running/failed runs pop visually.
  const accentColor = isActive
    ? 'var(--running)'
    : isFailed
      ? 'var(--error)'
      : isCancelled
        ? 'var(--text-tertiary)'
        : 'var(--success)';

  const stepInfo = formatStepInfo(run);
  const progressPct = computeProgressPct(run);
  const age = formatAge(run.started_at, run.last_activity_at);
  const clientLabel = project?.client_name ?? 'Sem cliente';
  const projectLabel = run.codebase_name ?? project?.name ?? 'Sem projeto';

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-[10px] border bg-[var(--surface)] transition hover:border-[var(--border-bright)] hover:bg-[var(--surface-elevated)]',
        isFailed ? 'border-[var(--error)]/30' : 'border-[var(--border)]'
      )}
    >
      {/* Status accent strip on the left */}
      <div
        className="absolute left-0 top-0 h-full w-[3px]"
        style={{ background: accentColor }}
        aria-hidden
      />

      <div className="px-4 py-3 pl-5">
        {/* Top row: status + workflow + age */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
            <Zap className="h-3 w-3 text-[var(--text-tertiary)]" aria-hidden />
            <span className="font-mono">{run.workflow_name}</span>
          </div>
          {run.triggered_by && (
            <span className="rounded border border-[var(--border)] bg-[var(--surface-inset)] px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-[var(--text-tertiary)]">
              {run.triggered_by}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
            <Clock className="h-3 w-3" aria-hidden />
            <span>{age}</span>
          </div>
        </div>

        {/* Project / client chips */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <Chip icon={Tag} label={projectLabel} />
          <Chip icon={GitBranch} label={clientLabel} muted />
          {run.demand_id && (
            <Chip
              icon={Activity}
              label={`Demanda ${run.demand_id.slice(0, 8)}`}
              accent="var(--brand-magenta)"
            />
          )}
        </div>

        {/* User message — the "what is being done" preview */}
        <p className="mt-2 line-clamp-2 text-[12.5px] leading-snug text-[var(--text-secondary)]">
          {run.user_message}
        </p>

        {/* Progress block — only for running or completed runs with step info */}
        {(stepInfo || progressPct !== null) && (
          <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2">
            {stepInfo && (
              <div className="flex items-center justify-between gap-2 text-[11.5px]">
                <div className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                  <Play className="h-3 w-3 text-[var(--running)]" aria-hidden />
                  <span className="font-medium">{stepInfo}</span>
                </div>
                {run.agents_total !== null && run.agents_total > 0 && (
                  <div className="font-mono text-[10.5px] tabular-nums text-[var(--text-tertiary)]">
                    {run.agents_completed ?? 0}/{run.agents_total} agents
                    {run.agents_failed !== null && run.agents_failed > 0 && (
                      <span className="ml-1.5 text-[var(--error)]">
                        ({run.agents_failed} falhou)
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {progressPct !== null && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--surface)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${String(progressPct)}%`,
                    background: isFailed ? 'var(--error)' : 'var(--running)',
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Working path / branch info (debug-y but useful for the PMO) */}
        {run.working_path && (
          <div className="mt-2 truncate font-mono text-[10px] text-[var(--text-tertiary)]">
            {run.working_path}
          </div>
        )}
      </div>
    </div>
  );
}

interface ChipProps {
  icon: typeof Activity;
  label: string;
  accent?: string;
  muted?: boolean;
}
function Chip({ icon: Icon, label, accent, muted }: ChipProps): JSX.Element {
  const color = muted ? 'var(--text-tertiary)' : (accent ?? 'var(--text-secondary)');
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{
        color,
        borderColor: muted
          ? 'var(--border)'
          : 'color-mix(in oklch, ' + color + ' 25%, transparent)',
        background: muted ? 'transparent' : 'color-mix(in oklch, ' + color + ' 8%, transparent)',
      }}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: WorkflowRunStatus }): JSX.Element {
  const map: Record<WorkflowRunStatus, { label: string; color: string; icon: typeof Activity }> = {
    running: { label: 'Rodando', color: 'var(--running)', icon: Loader2 },
    completed: { label: 'OK', color: 'var(--success)', icon: CheckCircle2 },
    failed: { label: 'Falhou', color: 'var(--error)', icon: XCircle },
    cancelled: { label: 'Cancelado', color: 'var(--text-tertiary)', icon: AlertCircle },
    paused: { label: 'Pausado', color: 'var(--warning)', icon: Clock },
    pending: { label: 'Pendente', color: 'var(--text-tertiary)', icon: Clock },
  };
  const meta = map[status];
  // PascalCase required for React component usage
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const Icon = meta.icon;
  const isRunning = status === 'running';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider"
      style={{
        background: 'color-mix(in oklch, ' + meta.color + ' 18%, transparent)',
        color: meta.color,
      }}
    >
      <Icon className={cn('h-3 w-3', isRunning && 'animate-spin')} aria-hidden />
      {meta.label}
    </span>
  );
}

function formatStepInfo(run: DashboardRun): string | null {
  if (!run.current_step_name) return null;
  if (run.total_steps !== null && run.total_steps > 0) {
    const idx = (run.current_step_index ?? 0) + 1;
    return `Etapa ${String(idx)}/${String(run.total_steps)} · ${run.current_step_name}`;
  }
  return run.current_step_name;
}

function computeProgressPct(run: DashboardRun): number | null {
  // Prefer agent-level progress (more granular) when we have it.
  if (run.agents_total !== null && run.agents_total > 0) {
    const done = (run.agents_completed ?? 0) + (run.agents_failed ?? 0);
    return Math.min(100, Math.round((done / run.agents_total) * 100));
  }
  // Fall back to step-level progress.
  if (run.total_steps !== null && run.total_steps > 0 && run.current_step_index !== null) {
    return Math.min(100, Math.round(((run.current_step_index + 1) / run.total_steps) * 100));
  }
  return null;
}

function formatAge(startedAt: string, lastActivityAt: string | null): string {
  const ref = lastActivityAt ?? startedAt;
  const start = new Date(ref).getTime();
  if (Number.isNaN(start)) return '—';
  const diffMs = Date.now() - start;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `há ${String(mins)} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const remMins = mins % 60;
    return remMins > 0 ? `há ${String(hours)}h ${String(remMins)}m` : `há ${String(hours)}h`;
  }
  const days = Math.floor(hours / 24);
  return `há ${String(days)}d`;
}

function ErrorState({ error }: { error: Error }): JSX.Element {
  return (
    <div className="rounded-[12px] border border-[var(--error)]/40 bg-[var(--error-soft)] p-5">
      <div className="text-[13px] font-semibold text-[var(--error)]">Erro ao carregar runs</div>
      <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{error.message}</div>
    </div>
  );
}
