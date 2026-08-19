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
 * Styling uses the Console's `.console-root` theme tokens — no
 * hard-coded `bg-white` / zinc utilities that ignore the active theme.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  listUsers,
  listRoles,
  listPermissions,
  assignRoleToUser,
  removeRoleFromUser,
  setUserDirectPermission,
  clearUserDirectPermission,
  createUserShell,
  type UserWithPermissions,
  type RoleWithPermissions,
  type Permission,
} from '../skills/rbac';
import { RefreshCw, ChevronDown, ChevronRight, Search, UserPlus, X } from 'lucide-react';

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
  const [creating, setCreating] = useState(false);

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
      setError(err instanceof Error ? err.message : 'Failed to load');
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
        setError(err instanceof Error ? err.message : 'Failed to assign');
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
        setError(err instanceof Error ? err.message : 'Failed to remove');
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
        setError(err instanceof Error ? err.message : 'Failed to set override');
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
        setError(err instanceof Error ? err.message : 'Failed to clear override');
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleCreate = useCallback(
    async (form: { displayName: string; email: string }): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await createUserShell({
          display_name: form.displayName.trim() || undefined,
          email: form.email.trim() || undefined,
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

  if (loading && users.length === 0) {
    return <p className="text-sm text-text-tertiary">Carregando usuários…</p>;
  }

  return (
    <div className="space-y-4">
      {creating && (
        <CreateUserForm
          busy={busy}
          onCancel={() => {
            setCreating(false);
          }}
          onSubmit={form => {
            void handleCreate(form);
          }}
        />
      )}

      <Toolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        loading={loading || busy}
        onRefresh={() => void refresh()}
        onCreate={() => {
          setCreating(true);
        }}
      />

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="text-xs text-text-tertiary">
        {filtered.length} de {users.length} usuários
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-surface-inset">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Usuário</th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Roles</th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">
                Permissões (via roles)
              </th>
              <th className="px-3 py-2 text-left font-medium text-text-secondary">Total</th>
              <th className="px-3 py-2 text-right font-medium text-text-secondary">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
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
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-text-tertiary">
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

interface ToolbarProps {
  search: string;
  onSearch: (v: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
}

function Toolbar(props: ToolbarProps): ReactElement {
  const { search, onSearch, filter, onFilter, loading, onRefresh, onCreate } = props;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[220px]">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
        />
        <input
          type="search"
          placeholder="Buscar email, nome ou role…"
          value={search}
          onChange={e => {
            onSearch(e.target.value);
          }}
          className="w-full rounded-md border border-border bg-surface-inset py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
        />
      </div>
      <div className="flex gap-1 text-xs">
        {(['all', 'admin', 'member', 'sandbox-user', 'viewer'] as Filter[]).map(f => (
          <button
            key={f}
            type="button"
            onClick={() => {
              onFilter(f);
            }}
            className={
              'rounded-md px-2.5 py-1 transition-colors ' +
              (filter === f
                ? 'bg-brand text-white'
                : 'bg-surface-elevated text-text-secondary hover:bg-surface-hover hover:text-text-primary')
            }
          >
            {f === 'all' ? 'Todos' : f}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        Atualizar
      </button>
      <button
        type="button"
        onClick={onCreate}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        <UserPlus size={12} />
        Novo usuário
      </button>
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
      <tr className="hover:bg-surface-hover">
        <td className="px-3 py-2 align-top">
          <div className="font-medium text-text-primary">{user.display_name ?? '(sem nome)'}</div>
          <div className="text-xs text-text-tertiary">{user.email ?? '—'}</div>
        </td>
        <td className="px-3 py-2 align-top">
          <div className="flex flex-wrap gap-1">
            {user.role_slugs.length === 0 ? (
              <span className="text-xs text-text-tertiary">sem role</span>
            ) : (
              user.role_slugs.map(slug => (
                <span
                  key={slug}
                  className="inline-flex items-center gap-1 rounded-md bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary"
                >
                  {slug}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onRemoveRole(slug);
                    }}
                    title="Remover role"
                    className="text-text-tertiary hover:text-red-400"
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
                className="rounded-md bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] text-blue-300"
              >
                {slug}
              </span>
            ))}
            {user.permission_slugs.length > 6 && (
              <span className="text-[10px] text-text-tertiary">
                +{user.permission_slugs.length - 6}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 align-top text-xs text-text-secondary">
          {user.permission_slugs.length} perms
        </td>
        <td className="px-3 py-2 text-right align-top">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-xs text-text-primary hover:bg-surface-hover"
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {isOpen ? 'Fechar' : 'Editar'}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={5} className="bg-surface-inset px-3 py-3">
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
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
          Adicionar role
        </div>
        {unassignedRoles.length === 0 ? (
          <p className="text-xs text-text-tertiary">
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
                className="rounded-md border border-blue-500/40 bg-surface-elevated px-2 py-1 text-xs text-blue-300 hover:bg-blue-500/15 disabled:opacity-50"
              >
                + {r.slug}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 text-[10px] text-text-tertiary">
          Roles de sistema (admin / member / sandbox-user / viewer) são únicas por usuário. Apenas
          roles customizadas podem ser adicionadas aqui.
        </div>
      </div>
      <div>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
          Permissões diretas (override)
        </div>
        <p className="mb-2 text-[10px] text-text-tertiary">
          Conceda ou revogue uma permissão individualmente. O grant/revoke direto tem prioridade
          sobre o conjunto herdado das roles.
        </p>
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-elevated p-2">
          {allPermissions.map(p => {
            const grantedByRole = isPermissionGrantedByAnyRole(p, rolesBySlug);
            const userHasIt = user.permission_slugs.includes(p.slug);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs hover:bg-surface-hover"
              >
                <div className="flex-1 truncate">
                  <span className="font-mono text-[11px] text-text-primary">{p.slug}</span>
                  {grantedByRole && (
                    <span className="ml-2 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-300">
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
                      className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-surface-hover disabled:opacity-50"
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
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                      >
                        + grant
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onSetOverride(p.slug, false);
                        }}
                        className="rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/20 disabled:opacity-50"
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

interface CreateUserFormProps {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (form: { displayName: string; email: string }) => void;
}

function CreateUserForm(props: CreateUserFormProps): ReactElement {
  const { busy, onCancel, onSubmit } = props;
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    onSubmit({ displayName, email });
  };

  const isValid = displayName.trim().length > 0 || email.trim().length > 0;

  return (
    <form
      onSubmit={submit}
      className="grid gap-2 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 text-sm md:grid-cols-[1fr_1fr_auto_auto]"
    >
      <input
        placeholder="Nome (ex: João Silva)"
        value={displayName}
        onChange={e => {
          setDisplayName(e.target.value);
        }}
        className="rounded-md border border-border bg-surface-inset px-2 py-1 text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
      />
      <input
        type="email"
        placeholder="Email (ex: joao@empresa.com)"
        value={email}
        onChange={e => {
          setEmail(e.target.value);
        }}
        className="rounded-md border border-border bg-surface-inset px-2 py-1 text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
      />
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover"
      >
        <X size={11} />
        Cancelar
      </button>
      <button
        type="submit"
        disabled={busy || !isValid}
        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        <UserPlus size={11} />
        Criar
      </button>
      <p className="md:col-span-4 text-[10px] text-text-tertiary">
        Cria um user shell sem senha. Pra entrar no sistema, a pessoa precisa fazer signup via
        Better Auth — você pode emitir um invite em /admin/invites (use o email cadastrado aqui).
      </p>
    </form>
  );
}
