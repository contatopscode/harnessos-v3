/**
 * Console RBAC users admin panel.
 *
 * Renders the list of users with their current role slugs + permission
 * slugs (computed via the aggregated view server-side), and lets the
 * operator:
 *   - assign / remove roles per user
 *   - set / clear a direct permission override per user
 *
 * Mutation surface goes through the 12 endpoints in @archon/server
 * (api.admin-rbac.ts), wrapped by packages/web/.../skills/rbac.ts.
 *
 * Layout: a flat table (responsive: stacked cards on narrow viewports).
 * Search box filters by email / display_name / role slug.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  listUsers,
  listRoles,
  assignRoleToUser,
  removeRoleFromUser,
  setUserDirectPermission,
  clearUserDirectPermission,
  type UserWithPermissions,
  type RoleWithPermissions,
  type Permission,
} from '../skills/rbac';
import { listPermissions } from '../skills/rbac';

type Filter = 'all' | 'admin' | 'member' | 'sandbox-user' | 'viewer';

function isPermissionGrantedByAnyRole(
  perm: Permission,
  rolesBySlug: ReadonlyMap<string, RoleWithPermissions>
): boolean {
  for (const r of rolesBySlug.values()) {
    if (r.permission_slugs.includes(perm.slug)) return true;
  }
  return false;
}

export function RbacUsersPanel(): ReactElement {
  const [users, setUsers] = useState<UserWithPermissions[]>([]);
  const [roles, setRoles] = useState<RoleWithPermissions[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rolesBySlug = useMemo<ReadonlyMap<string, RoleWithPermissions>>(
    () => new Map(roles.map(r => [r.slug, r])),
    [roles]
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [u, r, p] = await Promise.all([listUsers(), listRoles(), listPermissions()]);
      setUsers(u.users);
      setRoles(r.roles);
      setPermissions(Object.values(p.permissions).flat());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo<UserWithPermissions[]>(() => {
    const term = search.trim().toLowerCase();
    return users.filter(u => {
      if (filter !== 'all' && !u.role_slugs.includes(filter)) return false;
      if (!term) return true;
      const haystack =
        `${u.email ?? ''} ${u.display_name ?? ''} ${u.role_slugs.join(' ')}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [users, filter, search]);

  const handleAssignRole = useCallback(
    async (userId: string, roleSlug: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await assignRoleToUser(userId, roleSlug);
        await refresh();
      } catch (err) {
        setError(formatHttp(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleRemoveRole = useCallback(
    async (userId: string, roleSlug: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await removeRoleFromUser(userId, roleSlug);
        await refresh();
      } catch (err) {
        setError(formatHttp(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleSetOverride = useCallback(
    async (userId: string, slug: string, granted: boolean): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await setUserDirectPermission(userId, slug, granted);
        await refresh();
      } catch (err) {
        setError(formatHttp(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleClearOverride = useCallback(
    async (userId: string, slug: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await clearUserDirectPermission(userId, slug);
        await refresh();
      } catch (err) {
        setError(formatHttp(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  if (loading && users.length === 0) {
    return <p className="text-sm text-zinc-500">Carregando usuários…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Buscar email, nome ou role…"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
          }}
          className="flex-1 min-w-[200px] rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex gap-1 text-xs">
          {(['all', 'admin', 'member', 'sandbox-user', 'viewer'] as Filter[]).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setFilter(f);
              }}
              className={`rounded px-2 py-1 ${
                filter === f
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {f === 'all' ? 'Todos' : f}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || loading}
          className="rounded bg-zinc-100 px-3 py-1.5 text-xs hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          {loading ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="text-xs text-zinc-500">
        {filtered.length} de {users.length} usuários
      </div>

      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Usuário</th>
              <th className="px-3 py-2 text-left font-medium">Roles</th>
              <th className="px-3 py-2 text-left font-medium">Permissões (via roles)</th>
              <th className="px-3 py-2 text-left font-medium">Total</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {filtered.map(u => {
              const isOpen = expanded === u.id;
              return (
                <UserRow
                  key={u.id}
                  user={u}
                  isOpen={isOpen}
                  busy={busy}
                  rolesBySlug={rolesBySlug}
                  allPermissions={permissions}
                  onToggle={() => {
                    setExpanded(isOpen ? null : u.id);
                  }}
                  onAssignRole={roleSlug => void handleAssignRole(u.id, roleSlug)}
                  onRemoveRole={roleSlug => void handleRemoveRole(u.id, roleSlug)}
                  onSetOverride={(slug, granted) => void handleSetOverride(u.id, slug, granted)}
                  onClearOverride={slug => void handleClearOverride(u.id, slug)}
                />
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-zinc-500">
                  Nenhum usuário corresponde ao filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface UserRowProps {
  user: UserWithPermissions;
  isOpen: boolean;
  busy: boolean;
  rolesBySlug: ReadonlyMap<string, RoleWithPermissions>;
  allPermissions: Permission[];
  onToggle: () => void;
  onAssignRole: (roleSlug: string) => void;
  onRemoveRole: (roleSlug: string) => void;
  onSetOverride: (slug: string, granted: boolean) => void;
  onClearOverride: (slug: string) => void;
}

function UserRow(props: UserRowProps): ReactElement {
  const {
    user,
    isOpen,
    busy,
    rolesBySlug,
    allPermissions,
    onToggle,
    onAssignRole,
    onRemoveRole,
    onSetOverride,
    onClearOverride,
  } = props;

  const unassignedRoles = useMemo<RoleWithPermissions[]>(
    () =>
      Array.from(rolesBySlug.values()).filter(
        r => !user.role_slugs.includes(r.slug) && !r.is_system
      ),
    [rolesBySlug, user.role_slugs]
  );

  return (
    <>
      <tr>
        <td className="px-3 py-2 align-top">
          <div className="font-medium">{user.display_name ?? '(sem nome)'}</div>
          <div className="text-xs text-zinc-500">{user.email ?? '—'}</div>
        </td>
        <td className="px-3 py-2 align-top">
          <div className="flex flex-wrap gap-1">
            {user.role_slugs.length === 0 ? (
              <span className="text-xs text-zinc-400">sem role</span>
            ) : (
              user.role_slugs.map(slug => (
                <span
                  key={slug}
                  className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800"
                >
                  {slug}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onRemoveRole(slug);
                    }}
                    title="Remover role"
                    className="text-zinc-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
        </td>
        <td className="px-3 py-2 align-top">
          <div className="flex flex-wrap gap-1">
            {user.permission_slugs.slice(0, 6).map(slug => (
              <span
                key={slug}
                className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              >
                {slug}
              </span>
            ))}
            {user.permission_slugs.length > 6 && (
              <span className="text-[10px] text-zinc-400">+{user.permission_slugs.length - 6}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
          {user.permission_slugs.length} perms
        </td>
        <td className="px-3 py-2 text-right align-top">
          <button
            type="button"
            onClick={onToggle}
            className="rounded bg-zinc-100 px-2 py-1 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            {isOpen ? 'Fechar' : 'Editar'}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={5} className="bg-zinc-50 px-3 py-3 dark:bg-zinc-900">
            <UserEditor
              busy={busy}
              user={user}
              rolesBySlug={rolesBySlug}
              unassignedRoles={unassignedRoles}
              allPermissions={allPermissions}
              onAssignRole={onAssignRole}
              onSetOverride={onSetOverride}
              onClearOverride={onClearOverride}
            />
          </td>
        </tr>
      )}
    </>
  );
}

interface UserEditorProps {
  busy: boolean;
  user: UserWithPermissions;
  rolesBySlug: ReadonlyMap<string, RoleWithPermissions>;
  unassignedRoles: RoleWithPermissions[];
  allPermissions: Permission[];
  onAssignRole: (roleSlug: string) => void;
  onSetOverride: (slug: string, granted: boolean) => void;
  onClearOverride: (slug: string) => void;
}

function UserEditor(props: UserEditorProps): ReactElement {
  const {
    busy,
    user,
    rolesBySlug,
    unassignedRoles,
    allPermissions,
    onAssignRole,
    onSetOverride,
    onClearOverride,
  } = props;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Adicionar role
        </div>
        {unassignedRoles.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Todas as roles disponíveis já estão atribuídas (roles de sistema não podem ser
            duplicadas).
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {unassignedRoles.map(r => (
              <button
                key={r.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  onAssignRole(r.slug);
                }}
                className="rounded border border-blue-300 bg-white px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:bg-zinc-900 dark:text-blue-300"
              >
                + {r.slug}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 text-[10px] text-zinc-500">
          Roles de sistema (admin / member / sandbox-user / viewer) são únicas por usuário e
          aparecem na lista de roles já atribuídas. Apenas roles customizadas podem ser adicionadas
          aqui.
        </div>
      </div>
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Permissões diretas (override)
        </div>
        <p className="mb-2 text-[10px] text-zinc-500">
          Conceda ou revogue uma permissão individualmente. O grant/revoke direto tem prioridade
          sobre o conjunto herdado das roles.
        </p>
        <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-zinc-200 p-2 dark:border-zinc-800">
          {allPermissions.map(p => {
            const grantedByRole = isPermissionGrantedByAnyRole(p, rolesBySlug);
            const userHasIt = user.permission_slugs.includes(p.slug);
            return (
              <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex-1 truncate">
                  <span className="font-mono text-[11px]">{p.slug}</span>
                  {grantedByRole && (
                    <span className="ml-2 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      via role
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  {userHasIt ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        onClearOverride(p.slug);
                      }}
                      className="rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      Limpar override
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onSetOverride(p.slug, true);
                        }}
                        className="rounded border border-emerald-400 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      >
                        + grant
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onSetOverride(p.slug, false);
                        }}
                        className="rounded border border-red-400 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:bg-red-950 dark:text-red-300"
                      >
                        − deny
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatHttp(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Erro';
}
