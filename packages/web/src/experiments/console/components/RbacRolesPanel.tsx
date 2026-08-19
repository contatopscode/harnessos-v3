/**
 * Console RBAC roles admin panel.
 *
 * Lists every role (system + custom) with its granted permission slugs.
 * Mutations:
 *   - create new role (slug + name + description) → POST /api/admin/roles
 *   - update name / description → PATCH /api/admin/roles/:id
 *   - delete (refused by server for is_system=true) → DELETE /api/admin/roles/:id
 *   - toggle a permission binding → POST or DELETE /api/admin/roles/:id/permissions/:slug
 *
 * The expanded row of each role shows the full permissions matrix
 * grouped by category, with checkboxes that hit the toggle endpoints.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  listRoles,
  listPermissions,
  createRole,
  updateRole,
  deleteRole,
  assignPermissionToRole,
  removePermissionFromRole,
  type RoleWithPermissions,
  type Permission,
} from '../skills/rbac';
import { RefreshCw, Plus, ChevronDown, ChevronRight, Trash2, Pencil, Save, X } from 'lucide-react';

export function RbacRolesPanel(): ReactElement {
  const [roles, setRoles] = useState<RoleWithPermissions[]>([]);
  const [permissionsByCategory, setPermissionsByCategory] = useState<Record<string, Permission[]>>(
    {}
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [r, p] = await Promise.all([listRoles(), listPermissions()]);
      setRoles(r.roles);
      setPermissionsByCategory(p.permissions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allPermissions = useMemo<Permission[]>(
    () => Object.values(permissionsByCategory).flat(),
    [permissionsByCategory]
  );

  const handleCreate = useCallback(
    async (form: { slug: string; name: string; description: string }): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await createRole({
          slug: form.slug,
          name: form.name,
          description: form.description || null,
        });
        setCreating(false);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create');
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleUpdate = useCallback(
    async (id: string, patch: { name?: string; description?: string | null }): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await updateRole(id, patch);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update');
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await deleteRole(id);
        if (expanded === id) setExpanded(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete');
      } finally {
        setBusy(false);
      }
    },
    [refresh, expanded]
  );

  const handleToggle = useCallback(
    async (role: RoleWithPermissions, permSlug: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        if (role.permission_slugs.includes(permSlug)) {
          await removePermissionFromRole(role.id, permSlug);
        } else {
          await assignPermissionToRole(role.id, permSlug);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to toggle');
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  if (loading && roles.length === 0) {
    return <p className="text-sm text-text-tertiary">Carregando roles…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-text-tertiary">
          {roles.length} roles ({roles.filter(r => r.is_system).length} de sistema)
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy || loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            <Plus size={12} />
            Nova role
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {creating && (
        <CreateRoleForm
          busy={busy}
          onCancel={() => {
            setCreating(false);
          }}
          onSubmit={form => void handleCreate(form)}
        />
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-surface-inset">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Slug</th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Nome</th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Descrição</th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Permissões</th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Sistema</th>
              <th className="px-3 py-2 text-right font-medium text-text-secondary">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {roles.map(role => {
              const isOpen = expanded === role.id;
              return (
                <RoleRow
                  key={role.id}
                  role={role}
                  isOpen={isOpen}
                  busy={busy}
                  allPermissions={allPermissions}
                  permissionsByCategory={permissionsByCategory}
                  onToggle={() => {
                    setExpanded(isOpen ? null : role.id);
                  }}
                  onUpdate={patch => void handleUpdate(role.id, patch)}
                  onDelete={() => void handleDelete(role.id)}
                  onTogglePerm={slug => void handleToggle(role, slug)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CreateRoleFormProps {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (form: { slug: string; name: string; description: string }) => void;
}

function CreateRoleForm(props: CreateRoleFormProps): ReactElement {
  const { busy, onCancel, onSubmit } = props;
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    onSubmit({ slug: slug.trim(), name: name.trim(), description: description.trim() });
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-2 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 text-sm md:grid-cols-3"
    >
      <input
        required
        placeholder="slug (ex: custom-reviewer)"
        value={slug}
        onChange={e => {
          setSlug(e.target.value);
        }}
        className="rounded-md border border-border bg-surface-inset px-2 py-1 text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
      />
      <input
        required
        placeholder="Nome exibido"
        value={name}
        onChange={e => {
          setName(e.target.value);
        }}
        className="rounded-md border border-border bg-surface-inset px-2 py-1 text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
      />
      <input
        placeholder="Descrição (opcional)"
        value={description}
        onChange={e => {
          setDescription(e.target.value);
        }}
        className="rounded-md border border-border bg-surface-inset px-2 py-1 text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
      />
      <div className="md:col-span-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-surface-elevated px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy || !slug.trim() || !name.trim()}
          className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Criar
        </button>
      </div>
    </form>
  );
}

interface RoleRowProps {
  role: RoleWithPermissions;
  isOpen: boolean;
  busy: boolean;
  allPermissions: Permission[];
  permissionsByCategory: Record<string, Permission[]>;
  onToggle: () => void;
  onUpdate: (patch: { name?: string; description?: string | null }) => void;
  onDelete: () => void;
  onTogglePerm: (slug: string) => void;
}

function RoleRow(props: RoleRowProps): ReactElement {
  const { role, isOpen, busy, permissionsByCategory, onToggle, onUpdate, onDelete, onTogglePerm } =
    props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');

  const save = (): void => {
    onUpdate({
      name: name.trim() || role.name,
      description: description.trim() || null,
    });
    setEditing(false);
  };

  return (
    <>
      <tr className="hover:bg-surface-hover">
        <td className="px-3 py-2 align-top font-mono text-xs text-text-primary">{role.slug}</td>
        <td className="px-3 py-2 align-top text-text-primary">
          {editing ? (
            <input
              value={name}
              onChange={e => {
                setName(e.target.value);
              }}
              className="w-full rounded-md border border-border bg-surface-inset px-1.5 py-0.5 text-xs text-text-primary focus:border-border-bright focus:outline-none"
            />
          ) : (
            role.name
          )}
        </td>
        <td className="px-3 py-2 align-top text-xs text-text-secondary">
          {editing ? (
            <input
              value={description}
              onChange={e => {
                setDescription(e.target.value);
              }}
              className="w-full rounded-md border border-border bg-surface-inset px-1.5 py-0.5 text-xs text-text-primary focus:border-border-bright focus:outline-none"
            />
          ) : (
            (role.description ?? <span className="text-text-tertiary">—</span>)
          )}
        </td>
        <td className="px-3 py-2 align-top text-xs text-text-secondary">
          {role.permission_slugs.length} granted
        </td>
        <td className="px-3 py-2 align-top text-xs">
          {role.is_system ? (
            <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-300">sistema</span>
          ) : (
            <span className="text-text-tertiary">custom</span>
          )}
        </td>
        <td className="px-3 py-2 text-right align-top">
          <div className="flex justify-end gap-1">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setName(role.name);
                    setDescription(role.description ?? '');
                    setEditing(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-hover"
                >
                  <X size={11} />
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-0.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Save size={11} />
                  Salvar
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onToggle}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-primary hover:bg-surface-hover"
                >
                  {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {isOpen ? 'Fechar' : 'Permissões'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-primary hover:bg-surface-hover"
                >
                  <Pencil size={11} />
                  Editar
                </button>
                <button
                  type="button"
                  disabled={busy || role.is_system}
                  onClick={onDelete}
                  title={role.is_system ? 'Roles de sistema são imutáveis' : 'Excluir role'}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 size={11} />
                  Excluir
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={6} className="bg-surface-inset px-3 py-3">
            <PermissionsMatrix
              busy={busy}
              role={role}
              permissionsByCategory={permissionsByCategory}
              onToggle={onTogglePerm}
            />
          </td>
        </tr>
      )}
    </>
  );
}

interface PermissionsMatrixProps {
  busy: boolean;
  role: RoleWithPermissions;
  permissionsByCategory: Record<string, Permission[]>;
  onToggle: (slug: string) => void;
}

function PermissionsMatrix(props: PermissionsMatrixProps): ReactElement {
  const { busy, role, permissionsByCategory, onToggle } = props;
  return (
    <div className="space-y-3">
      <div className="text-xs text-text-tertiary">
        Marque / desmarque para conceder / revogar a permissão desta role. As alterações são
        aplicadas imediatamente.
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Object.entries(permissionsByCategory).map(([category, perms]) => (
          <div key={category} className="rounded-md border border-border bg-surface-elevated p-2">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
              {category === '__uncategorized__' ? 'Sem categoria' : category}
            </div>
            <div className="space-y-0.5">
              {perms.map(p => {
                const checked = role.permission_slugs.includes(p.slug);
                return (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-surface-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => {
                        onToggle(p.slug);
                      }}
                      className="mt-0.5 accent-brand"
                    />
                    <div className="flex-1">
                      <div className="font-mono text-[11px] text-text-primary">{p.slug}</div>
                      <div className="text-text-tertiary">{p.name}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
