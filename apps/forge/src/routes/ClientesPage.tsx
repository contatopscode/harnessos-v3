/**
 * HarnessOS Projetos — Clientes (CRUD completo).
 *
 * Top-level customer / org registry. 1 cliente = 1 razão social.
 * Cada codebase (Projeto) e cada demanda pertence a um cliente.
 *
 * Operações: criar, editar (nome/descrição/contato/status), excluir.
 * Delete é recusado pelo backend se o cliente ainda tem projetos ou
 * demandas vinculados (FK safety net).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { JSX } from 'react';
import {
  Loader2,
  Plus,
  Search,
  Pencil,
  Trash2,
  Mail,
  Archive,
  CheckCircle2,
  PauseCircle,
  X,
} from 'lucide-react';
import { api, type Client, type ClientStatus, ApiError, PermissionError } from '../lib/api';
import { cn } from '../lib/cn';

const STATUS_META: Record<
  ClientStatus,
  { label: string; color: string; icon: typeof CheckCircle2 }
> = {
  active: { label: 'Ativo', color: 'var(--success)', icon: CheckCircle2 },
  inactive: { label: 'Inativo', color: 'var(--text-tertiary)', icon: PauseCircle },
  archived: { label: 'Arquivado', color: 'var(--warning)', icon: Archive },
};

export function ClientesPage(): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['forge', 'clients'],
    queryFn: () => api.clients.list(),
  });

  const clients = (data?.clients ?? []).filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.slug.toLowerCase().includes(q) ||
      (c.description ?? '').toLowerCase().includes(q) ||
      (c.contact_email ?? '').toLowerCase().includes(q)
    );
  });

  const create = useMutation({
    mutationFn: api.clients.create,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forge', 'clients'] });
      setCreating(false);
    },
  });

  const update = useMutation({
    mutationFn: (args: { id: string; body: Parameters<typeof api.clients.update>[1] }) =>
      api.clients.update(args.id, args.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forge', 'clients'] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.clients.delete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['forge', 'clients'] });
    },
  });

  return (
    <div>
      <header className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Clientes</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Empresas e organizações clientes. Cada projeto e cada demanda pertence a um cliente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type="search"
              placeholder="Buscar por nome, slug, e-mail…"
              value={search}
              onChange={e => {
                setSearch(e.target.value);
              }}
              className="w-[280px] rounded-md border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-8 pr-3 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Novo cliente
          </button>
        </div>
      </header>

      {isLoading ? (
        <div className="flex h-64 items-center justify-center gap-2 text-[var(--text-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-[13px]">Carregando clientes…</span>
        </div>
      ) : error ? (
        <ErrorState error={error} />
      ) : clients.length === 0 ? (
        <EmptyState
          onCreate={() => {
            setCreating(true);
          }}
          hasSearch={Boolean(search)}
        />
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full text-[12.5px]">
            <thead className="bg-[var(--surface-inset)] text-[var(--text-tertiary)]">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Nome</th>
                <th className="px-4 py-2.5 text-left font-medium">Slug</th>
                <th className="px-4 py-2.5 text-left font-medium">Contato</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="w-24 px-4 py-2.5 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr
                  key={c.id}
                  className="border-t border-[var(--border)] transition-colors hover:bg-[var(--surface-elevated)]"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--text-primary)]">{c.name}</div>
                    {c.description && (
                      <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-tertiary)]">
                        {c.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11.5px] text-[var(--text-secondary)]">
                    {c.slug}
                  </td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">
                    {c.contact_email ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3 w-3 text-[var(--text-tertiary)]" />
                        {c.contact_email}
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(c);
                        }}
                        className="rounded p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                        title="Editar"
                        aria-label={`Editar ${c.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <DeleteButton
                        client={c}
                        onConfirm={() => {
                          remove.mutate(c.id);
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <ClientModal
          client={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={body => {
            if (editing) {
              update.mutate({ id: editing.id, body });
            } else {
              create.mutate(body as Parameters<typeof api.clients.create>[0]);
            }
          }}
          saving={create.isPending || update.isPending}
          error={create.error || update.error || remove.error}
        />
      )}

      {remove.isSuccess && (
        <div className="mt-3 rounded-md border border-[var(--success)]/40 bg-[var(--success-soft)] px-3 py-2 text-[12px] text-[var(--success)]">
          Cliente removido.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ClientStatus }): JSX.Element {
  const meta = STATUS_META[status];
  // PascalCase required for React component usage
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const StatusIcon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium"
      style={{ borderColor: 'var(--border)', color: meta.color }}
    >
      <StatusIcon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function DeleteButton({
  client,
  onConfirm,
}: {
  client: Client;
  onConfirm: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
        className="rounded p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--error)]"
        title="Excluir"
        aria-label={`Excluir ${client.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onConfirm}
        className="rounded bg-[var(--error)] px-2 py-1 text-[10.5px] font-medium text-white hover:bg-[var(--error)]/90"
      >
        Confirmar
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
        }}
        className="rounded border border-[var(--border)] px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
      >
        Cancelar
      </button>
    </div>
  );
}

function EmptyState({
  onCreate,
  hasSearch,
}: {
  onCreate: () => void;
  hasSearch: boolean;
}): JSX.Element {
  return (
    <div className="rounded-[12px] border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
      <Users className="mx-auto h-8 w-8 text-[var(--text-tertiary)]" aria-hidden />
      <h3 className="mt-3 text-[14px] font-medium text-[var(--text-primary)]">
        {hasSearch ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
      </h3>
      <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
        {hasSearch
          ? 'Tente outro termo de busca.'
          : 'Crie o primeiro cliente pra começar a organizar projetos e demandas.'}
      </p>
      {!hasSearch && (
        <button
          type="button"
          onClick={onCreate}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm hover:bg-[var(--accent-hover)]"
        >
          <Plus className="h-3.5 w-3.5" />
          Novo cliente
        </button>
      )}
    </div>
  );
}

function ErrorState({ error }: { error: Error }): JSX.Element {
  const isApiError = error instanceof ApiError;
  const isForbidden = error instanceof PermissionError;
  return (
    <div className="rounded-[12px] border border-[var(--error)]/40 bg-[var(--error-soft)] p-5">
      <div className="text-[13px] font-semibold text-[var(--error)]">
        {isForbidden
          ? 'Sem permissão'
          : isApiError
            ? `Erro ${String(error.status)}`
            : 'Erro inesperado'}
      </div>
      <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{error.message}</div>
    </div>
  );
}

interface ClientModalProps {
  client: Client | null;
  onClose: () => void;
  onSave: (body: {
    slug?: string;
    name?: string;
    description?: string | null;
    contact_email?: string | null;
    status?: ClientStatus;
  }) => void;
  saving: boolean;
  error: Error | null;
}

function ClientModal({ client, onClose, onSave, saving, error }: ClientModalProps): JSX.Element {
  const [name, setName] = useState(client?.name ?? '');
  const [slug, setSlug] = useState(client?.slug ?? '');
  const [description, setDescription] = useState(client?.description ?? '');
  const [contactEmail, setContactEmail] = useState(client?.contact_email ?? '');
  const [status, setStatus] = useState<ClientStatus>(client?.status ?? 'active');
  const isEdit = Boolean(client);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const body: {
      name: string;
      description: string | null;
      contact_email: string | null;
      status: ClientStatus;
      slug?: string;
    } = {
      name: name.trim(),
      description: description.trim() || null,
      contact_email: contactEmail.trim() || null,
      status,
    };
    if (!isEdit) body.slug = slug.trim();
    onSave(body);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
            {isEdit ? 'Editar cliente' : 'Novo cliente'}
          </h2>
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
          {!isEdit && (
            <Field
              label="Slug"
              required
              value={slug}
              onChange={setSlug}
              placeholder="acme-corp"
              hint="Identificador URL-friendly. Letras minúsculas, números e hífens."
            />
          )}
          <Field
            label="Nome"
            required
            value={name}
            onChange={setName}
            placeholder="ACME Corporation"
          />
          <Field
            label="Descrição"
            value={description}
            onChange={setDescription}
            placeholder="Breve descrição do cliente (opcional)"
          />
          <Field
            label="E-mail de contato"
            type="email"
            value={contactEmail}
            onChange={setContactEmail}
            placeholder="contato@empresa.com"
          />
          <div>
            <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
              Status
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(['active', 'inactive', 'archived'] as const).map(s => {
                const meta = STATUS_META[s];
                // PascalCase required for React component usage
                // eslint-disable-next-line @typescript-eslint/naming-convention
                const StatusIcon = meta.icon;
                const selected = status === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setStatus(s);
                    }}
                    className={cn(
                      'inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors',
                      selected
                        ? 'border-[var(--brand-magenta)] bg-[var(--brand-magenta)]/10 text-[var(--text-primary)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                    )}
                  >
                    <StatusIcon className="h-3.5 w-3.5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-[12px] text-[var(--error)]">
            {error instanceof ApiError && error.status === 409
              ? 'Este slug já está em uso por outro cliente.'
              : error.message}
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
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-sm hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? 'Salvando…' : isEdit ? 'Salvar alterações' : 'Criar cliente'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  hint?: string;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  hint,
}: FieldProps): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
        {label}
        {required && <span className="ml-0.5 text-[var(--error)]">*</span>}
      </span>
      <input
        type={type}
        value={value}
        required={required}
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

// Users icon inline (avoids an extra import in the header)
function Users(props: React.SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <circle cx="12" cy="8" r="3.5" />
      <path d="M3 20a9 9 0 0 1 18 0" />
    </svg>
  );
}
