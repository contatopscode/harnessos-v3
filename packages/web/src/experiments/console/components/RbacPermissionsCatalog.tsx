/**
 * Console RBAC permissions catalog — read-only view of the closed set
 * of permission slugs. New permissions are added via the seed
 * (`packages/core/src/db/rbac-seed.ts`) and cannot be created from the
 * admin UI — this panel only renders what the gate helper knows about.
 *
 * Layout: permissions grouped by category (a human label, not used by
 * the gate). Filter chips on top let the operator narrow by category
 * or by "currently granted to a role" status.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  listPermissions,
  listRoles,
  type Permission,
  type RoleWithPermissions,
} from '../skills/rbac';

type Scope = 'all' | 'granted' | 'orphan';

export function RbacPermissionsCatalog(): ReactElement {
  const [permsByCategory, setPermsByCategory] = useState<Record<string, Permission[]>>({});
  const [roles, setRoles] = useState<RoleWithPermissions[]>([]);
  const [scope, setScope] = useState<Scope>('all');
  const [activeCategory, setActiveCategory] = useState<string>('__all__');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([listPermissions(), listRoles()]);
      setPermsByCategory(p.permissions);
      setRoles(r.roles);
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
    () => Object.values(permsByCategory).flat(),
    [permsByCategory]
  );

  const grantedSet = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const r of roles) for (const p of r.permission_slugs) s.add(p);
    return s;
  }, [roles]);

  const categories = useMemo<string[]>(
    () => Object.keys(permsByCategory).sort((a, b) => a.localeCompare(b)),
    [permsByCategory]
  );

  const filtered = useMemo<Permission[]>(() => {
    const term = search.trim().toLowerCase();
    return allPermissions.filter(p => {
      if (activeCategory !== '__all__' && p.category !== activeCategory) return false;
      if (scope === 'granted' && !grantedSet.has(p.slug)) return false;
      if (scope === 'orphan' && grantedSet.has(p.slug)) return false;
      if (!term) return true;
      const haystack = `${p.slug} ${p.name} ${p.description ?? ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [allPermissions, scope, grantedSet, activeCategory, search]);

  if (loading && allPermissions.length === 0) {
    return <p className="text-sm text-zinc-500">Carregando catálogo…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Buscar por slug, nome ou descrição…"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
          }}
          className="flex-1 min-w-[200px] rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex gap-1 text-xs">
          {(['all', 'granted', 'orphan'] as Scope[]).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setScope(s);
              }}
              className={`rounded px-2 py-1 ${
                scope === s
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {s === 'all' ? 'Todas' : s === 'granted' ? 'Em uso' : 'Órfãs'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded bg-zinc-100 px-3 py-1.5 text-xs hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          Atualizar
        </button>
      </div>

      <div className="flex flex-wrap gap-1 text-xs">
        <button
          type="button"
          onClick={() => {
            setActiveCategory('__all__');
          }}
          className={`rounded px-2 py-0.5 ${
            activeCategory === '__all__'
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
          }`}
        >
          Todas as categorias
        </button>
        {categories.map(cat => (
          <button
            key={cat}
            type="button"
            onClick={() => {
              setActiveCategory(cat);
            }}
            className={`rounded px-2 py-0.5 ${
              activeCategory === cat
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
            }`}
          >
            {cat === '__uncategorized__' ? 'Sem categoria' : cat}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="text-xs text-zinc-500">
        {filtered.length} de {allPermissions.length} permissões
        {scope === 'orphan' && ' (não concedidas a nenhuma role)'}
      </div>

      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map(p => {
          const isGranted = grantedSet.has(p.slug);
          return (
            <div
              key={p.id}
              className={`rounded border p-3 text-xs ${
                isGranted
                  ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20'
                  : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono text-[11px] font-medium">{p.slug}</div>
                {isGranted ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                    em uso
                  </span>
                ) : (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    órfã
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-zinc-600 dark:text-zinc-300">{p.name}</div>
              {p.description && (
                <div className="mt-1 text-[11px] text-zinc-500">{p.description}</div>
              )}
              {p.category && (
                <div className="mt-1 text-[10px] text-zinc-400">categoria: {p.category}</div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-full text-center text-xs text-zinc-500">
            Nenhuma permissão corresponde ao filtro.
          </p>
        )}
      </div>
    </div>
  );
}
