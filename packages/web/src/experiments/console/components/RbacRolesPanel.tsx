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
    return <p className="text-sm text-zinc-500">Carregando roles…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-zinc-500">
          {roles.length} roles ({roles.filter(r => r.is_system).length} de sistema)
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy || loading}
            className="rounded bg-zinc-100 px-3 py-1.5 text-xs hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
            }}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
          >
            + Nova role
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
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

      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Slug</th>
              <th className="px-3 py-2 text-left font-medium">Nome</th>
              <th className="px-3 py-2 text-left font-medium">Descrição</th>
              <th className="px-3 py-2 text-left font-medium">Permissões</th>
              <th className="px-3 py-2 text-left font-medium">Sistema</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
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
      className="grid gap-2 rounded border border-blue-300 bg-blue-50/40 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/30 md:grid-cols-3"
    >
      <input
        required
        placeholder="slug (ex: custom-reviewer)"
        value={slug}
        onChange={e => {
          setSlug(e.target.value);
        }}
        className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <input
        required
        placeholder="Nome exibido"
        value={name}
        onChange={e => {
          setName(e.target.value);
        }}
        className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <input
        placeholder="Descrição (opcional)"
        value={description}
        onChange={e => {
          setDescription(e.target.value);
        }}
        className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="md:col-span-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded bg-zinc-100 px-3 py-1 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy || !slug.trim() || !name.trim()}
          className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
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
      <tr>
        <td className="px-3 py-2 align-top font-mono text-xs">{role.slug}</td>
        <td className="px-3 py-2 align-top">
          {editing ? (
            <input
              value={name}
              onChange={e => {
                setName(e.target.value);
              }}
              className="w-full rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          ) : (
            role.name
          )}
        </td>
        <td className="px-3 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
          {editing ? (
            <input
              value={description}
              onChange={e => {
                setDescription(e.target.value);
              }}
              className="w-full rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          ) : (
            (role.description ?? <span className="text-zinc-400">—</span>)
          )}
        </td>
        <td className="px-3 py-2 align-top text-xs">{role.permission_slugs.length} granted</td>
        <td className="px-3 py-2 align-top text-xs">
          {role.is_system ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
              sistema
            </span>
          ) : (
            <span className="text-zinc-400">custom</span>
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
                  className="rounded bg-zinc-100 px-2 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Salvar
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onToggle}
                  className="rounded bg-zinc-100 px-2 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                >
                  {isOpen ? 'Fechar' : 'Permissões'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                  }}
                  className="rounded bg-zinc-100 px-2 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                >
                  Editar
                </button>
                <button
                  type="button"
                  disabled={busy || role.is_system}
                  onClick={onDelete}
                  title={role.is_system ? 'Roles de sistema são imutáveis' : 'Excluir role'}
                  className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900"
                >
                  Excluir
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={6} className="bg-zinc-50 px-3 py-3 dark:bg-zinc-900">
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
      <div className="text-xs text-zinc-500">
        Marque / desmarque para conceder / revogar a permissão desta role. As alterações são
        aplicadas imediatamente.
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Object.entries(permissionsByCategory).map(([category, perms]) => (
          <div key={category} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {category === '__uncategorized__' ? 'Sem categoria' : category}
            </div>
            <div className="space-y-1">
              {perms.map(p => {
                const checked = role.permission_slugs.includes(p.slug);
                return (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-start gap-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => {
                        onToggle(p.slug);
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="font-mono text-[11px]">{p.slug}</div>
                      <div className="text-zinc-500">{p.name}</div>
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
