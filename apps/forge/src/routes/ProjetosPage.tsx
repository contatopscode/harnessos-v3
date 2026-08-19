import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type ProjectSummary, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { Loader2, FolderKanban, GitBranch } from 'lucide-react';

export function ProjetosPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['forge', 'projects'],
    queryFn: () => api.projects.list(),
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-[13px]">Carregando projetos…</span>
      </div>
    );
  }

  if (error) {
    return <ErrorState error={error as Error} />;
  }

  const projects = data?.projects ?? [];

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Projetos</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Codebases registrados no HarnessOS com contagens de demandas e runs.
          </p>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
          {projects.length} {projects.length === 1 ? 'projeto' : 'projetos'}
        </div>
      </header>

      {projects.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center">
          <FolderKanban className="mx-auto mb-3 h-8 w-8 text-[var(--text-tertiary)]" />
          <div className="text-[14px] font-medium text-[var(--text-secondary)]">
            Nenhum projeto ainda
          </div>
          <div className="mt-1 text-[12px] text-[var(--text-tertiary)]">
            Adicione um codebase no HarnessOS pra ele aparecer aqui.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map(p => <ProjectCard key={p.id} project={p} />)}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project: p }: { project: ProjectSummary }) {
  return (
    <Link
      to={`/projetos/${p.id}`}
      className="group relative flex flex-col gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--border-bright)] hover:bg-[var(--surface-elevated)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            {p.client_name ?? 'Sem cliente'}
          </div>
          <h3 className="mt-0.5 truncate text-[15px] font-semibold text-[var(--text-primary)]">
            {p.name}
          </h3>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {p.repository_url && (
        <div className="flex items-center gap-1.5 truncate text-[11.5px] text-[var(--text-tertiary)]">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {p.repository_url.replace('https://github.com/', '')}
          </span>
        </div>
      )}

      <div className="mt-auto flex items-center gap-4 border-t border-[var(--border)] pt-3 text-[11.5px]">
        <Stat label="demandas abertas" value={p.open_demands} accent={p.open_demands > 0} />
        <Stat label="demandas total" value={p.total_demands} />
        <Stat label="runs" value={p.runs_count} />
      </div>
    </Link>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'text-[15px] font-semibold',
          accent && value > 0 ? 'text-[var(--brand-magenta)]' : 'text-[var(--text-primary)]'
        )}
      >
        {value}
      </span>
      <span className="text-[10.5px] text-[var(--text-tertiary)]">{label}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    active: { label: 'Ativo', color: 'var(--success)' },
    inactive: { label: 'Inativo', color: 'var(--warning)' },
    archived: { label: 'Arquivado', color: 'var(--text-tertiary)' },
    repo: { label: 'Repo', color: 'var(--success)' },
    folder: { label: 'Pasta', color: 'var(--running)' },
  };
  const meta = map[status] ?? { label: status, color: 'var(--text-tertiary)' };
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider"
      style={{ background: `color-mix(in oklch, ${meta.color} 18%, transparent)`, color: meta.color }}
    >
      {meta.label}
    </span>
  );
}

function ErrorState({ error }: { error: Error }) {
  const isApiError = error instanceof ApiError;
  return (
    <div className="rounded-[12px] border border-[var(--error)]/40 bg-[var(--error-soft)] p-5">
      <div className="text-[13px] font-semibold text-[var(--error)]">
        {isApiError ? `Erro ${String(error.status)}` : 'Erro inesperado'}
      </div>
      <div className="mt-1 text-[12px] text-[var(--text-secondary)]">
        {isApiError ? error.message : error.message || String(error)}
      </div>
      {isApiError && error.status === 401 && (
        <div className="mt-2 text-[11.5px] text-[var(--text-tertiary)]">
          Sessão expirou — faça login novamente.
        </div>
      )}
    </div>
  );
}
