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
import { RefreshCw, Search } from 'lucide-react';

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
    return <p className="text-sm text-text-tertiary">Carregando catálogo…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            type="search"
            placeholder="Buscar por slug, nome ou descrição…"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
            }}
            className="w-full rounded-md border border-border bg-surface-inset py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
          />
        </div>
        <div className="flex gap-1 text-xs">
          {(['all', 'granted', 'orphan'] as Scope[]).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setScope(s);
              }}
              className={
                'rounded-md px-2.5 py-1 transition-colors ' +
                (scope === s
                  ? 'bg-brand text-white'
                  : 'bg-surface-elevated text-text-secondary hover:bg-surface-hover hover:text-text-primary')
              }
            >
              {s === 'all' ? 'Todas' : s === 'granted' ? 'Em uso' : 'Órfãs'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Atualizar
        </button>
      </div>

      <div className="flex flex-wrap gap-1 text-xs">
        <button
          type="button"
          onClick={() => {
            setActiveCategory('__all__');
          }}
          className={
            'rounded-md px-2.5 py-0.5 transition-colors ' +
            (activeCategory === '__all__'
              ? 'bg-brand text-white'
              : 'bg-surface-elevated text-text-secondary hover:bg-surface-hover hover:text-text-primary')
          }
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
            className={
              'rounded-md px-2.5 py-0.5 transition-colors ' +
              (activeCategory === cat
                ? 'bg-brand text-white'
                : 'bg-surface-elevated text-text-secondary hover:bg-surface-hover hover:text-text-primary')
            }
          >
            {cat === '__uncategorized__' ? 'Sem categoria' : cat}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="text-xs text-text-tertiary">
        {filtered.length} de {allPermissions.length} permissões
        {scope === 'orphan' && ' (não concedidas a nenhuma role)'}
      </div>

      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map(p => {
          const isGranted = grantedSet.has(p.slug);
          return (
            <div
              key={p.id}
              className={
                'rounded-lg border p-3 text-xs ' +
                (isGranted
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-border bg-surface-elevated')
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono text-[11px] font-medium text-text-primary">{p.slug}</div>
                {isGranted ? (
                  <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                    em uso
                  </span>
                ) : (
                  <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-tertiary">
                    órfã
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-text-secondary">{p.name}</div>
              {p.description && (
                <div className="mt-1 text-[11px] text-text-tertiary">{p.description}</div>
              )}
              {p.category && (
                <div className="mt-1 text-[10px] text-text-tertiary">categoria: {p.category}</div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-full text-center text-xs text-text-tertiary">
            Nenhuma permissão corresponde ao filtro.
          </p>
        )}
      </div>
    </div>
  );
}
