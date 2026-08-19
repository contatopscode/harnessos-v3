/**
 * HarnessOS Projetos — Projetos (PMO view of codebases) com CRUD.
 *
 * A "project" in the FORGE surface is a `remote_agent_codebases` row
 * enriched with PMO counts (open demands, total demands, runs).
 * The card grid shows each codebase; clicking the pencil opens a
 * modal to edit client binding, default_branch, repository_url, kind.
 * Deletion is refused by the backend if the project still has
 * demands or runs (FK safety net).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { JSX } from 'react';
import {
  Loader2,
  FolderKanban,
  GitBranch,
  Pencil,
  Trash2,
  X,
  Building2,
  ExternalLink,
} from 'lucide-react';
import { api, type ProjectSummary, type Client, ApiError } from '../lib/api';
import { cn } from '../lib/cn';

export function ProjetosPage(): JSX.Element {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ProjectSummary | null>(null);

  const projects = useQuery({
    queryKey: ['forge', 'projects'],
    queryFn: () => api.projects.list(),
  });

  const clients = useQuery({
    queryKey: ['forge', 'clients'],
    queryFn: () => api.clients.list(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forge', 'projects'] });
    },
  });

  if (projects.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-[13px]">Carregando projetos…</span>
      </div>
    );
  }

  if (projects.error) {
    return <ErrorState error={projects.error} />;
  }

  const list = projects.data?.projects ?? [];

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
          {list.length} {list.length === 1 ? 'projeto' : 'projetos'}
        </div>
      </header>

      {list.length === 0 ? (
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
          {list.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              onEdit={() => {
                setEditing(p);
              }}
              onDelete={() => {
                remove.mutate(p.id);
              }}
              deletePending={remove.isPending && remove.variables === p.id}
            />
          ))}
        </div>
      )}

      {remove.isSuccess && (
        <div className="mt-3 rounded-md border border-[var(--success)]/40 bg-[var(--success-soft)] px-3 py-2 text-[12px] text-[var(--success)]">
          Projeto removido.
        </div>
      )}

      {editing && (
        <ProjectEditModal
          project={editing}
          clients={clients.data?.clients ?? []}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void projects.refetch();
            void clients.refetch();
          }}
        />
      )}
    </div>
  );
}

interface ProjectCardProps {
  project: ProjectSummary;
  onEdit: () => void;
  onDelete: () => void;
  deletePending: boolean;
}

function ProjectCard({
  project: p,
  onEdit,
  onDelete,
  deletePending,
}: ProjectCardProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="group relative flex flex-col gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--border-bright)] hover:bg-[var(--surface-elevated)]">
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
        <a
          href={p.repository_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 truncate text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{p.repository_url.replace('https://github.com/', '')}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      )}

      {p.default_branch && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10.5px]">
            {p.default_branch}
          </span>
        </div>
      )}

      <div className="mt-auto flex items-center gap-4 border-t border-[var(--border)] pt-3 text-[11.5px]">
        <Stat label="demandas abertas" value={p.open_demands} accent={p.open_demands > 0} />
        <Stat label="demandas total" value={p.total_demands} />
        <Stat label="runs" value={p.runs_count} />
      </div>

      {/* Hover actions (always visible on touch) */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onEdit}
          className="rounded p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          title="Editar"
          aria-label={`Editar ${p.name}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={onDelete}
              disabled={deletePending}
              className="rounded bg-[var(--error)] px-2 py-1 text-[10.5px] font-medium text-white hover:bg-[var(--error)]/90 disabled:opacity-60"
            >
              {deletePending ? '…' : 'Confirmar'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className="rounded border border-[var(--border)] px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              Não
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            className="rounded p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--error)]"
            title="Excluir"
            aria-label={`Excluir ${p.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

interface ProjectEditModalProps {
  project: ProjectSummary;
  clients: Client[];
  onClose: () => void;
  onSaved: () => void;
}

function ProjectEditModal({
  project: p,
  clients,
  onClose,
  onSaved,
}: ProjectEditModalProps): JSX.Element {
  const [clientId, setClientId] = useState<string>(p.client_id ?? '');
  const [defaultBranch, setDefaultBranch] = useState<string>(p.default_branch ?? '');
  const [repositoryUrl, setRepositoryUrl] = useState<string>(p.repository_url ?? '');
  const [kind, setKind] = useState<'repo' | 'folder'>(p.status === 'folder' ? 'folder' : 'repo');

  const update = useMutation({
    mutationFn: () =>
      api.projects.update(p.id, {
        client_id: clientId || null,
        default_branch: defaultBranch || null,
        repository_url: repositoryUrl || null,
        kind,
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={e => {
          e.preventDefault();
          update.mutate();
        }}
        className="w-full max-w-lg rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Editar projeto</h2>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {p.name} · <span className="font-mono">{p.slug}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5">
          <div>
            <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
              <Building2 className="mr-1 inline h-3 w-3" /> Cliente
            </span>
            <select
              value={clientId}
              onChange={e => {
                setClientId(e.target.value);
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 text-[13px] text-[var(--text-primary)] focus:border-[var(--brand-magenta)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-ring)]"
            >
              <option value="">— Sem cliente —</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Branch padrão"
            value={defaultBranch}
            onChange={setDefaultBranch}
            placeholder="main"
            hint="Branch que o HarnessOS usa como base pra abrir issues, abrir PRs etc."
          />
          <Field
            label="URL do repositório"
            type="url"
            value={repositoryUrl}
            onChange={setRepositoryUrl}
            placeholder="https://github.com/contatopscode/harnessos.git"
          />
          <div>
            <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
              Tipo
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(['repo', 'folder'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                  }}
                  className={cn(
                    'rounded-md border px-3 py-2 text-[12.5px] font-medium transition-colors',
                    kind === k
                      ? 'border-[var(--brand-magenta)] bg-[var(--brand-magenta)]/10 text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                  )}
                >
                  {k === 'repo' ? 'Repositório Git' : 'Pasta local'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {update.error && (
          <div className="mt-4 rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-[12px] text-[var(--error)]">
            {update.error.message}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={update.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-sm hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {update.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {update.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}): JSX.Element {
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

function StatusBadge({ status }: { status: string }): JSX.Element {
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
      style={{
        background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
        color: meta.color,
      }}
    >
      {meta.label}
    </span>
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

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
}: FieldProps): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={e => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-ring)]"
      />
      {hint && <span className="mt-1 block text-[10.5px] text-[var(--text-tertiary)]">{hint}</span>}
    </label>
  );
}
