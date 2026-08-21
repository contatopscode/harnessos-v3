/**
 * Console `/console/admin/audit` — global audit log viewer.
 *
 * Paulo pediu (FORGE sprint, 19/ago/2026): "tudo, absolutamente
 * tudo tem que ser registrado". This page is the operator view of
 * that requirement — every login, every CRUD, every RBAC change is
 * listed here, filterable by action / entity / actor.
 *
 * UX:
 *   - Top bar: filter pills (all / login / CRUD / RBAC) + search
 *   - Table: time, action badge (colored), actor (email + ID link),
 *     entity (type + ID link), source badge, metadata preview
 *   - Empty state: "Nenhum evento ainda — aguarde o primeiro login"
 *
 * Theme: `.console-root` OKLCH tokens (no raw Tailwind bg-white).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { History, Search, Filter } from 'lucide-react';
import { listAuditLog, actionLabel, type AuditLogEntry } from '../skills/audit-log';

const FILTER_GROUPS: { id: string; label: string; match: (a: string) => boolean }[] = [
  { id: 'all', label: 'Tudo', match: () => true },
  { id: 'login', label: 'Login', match: a => a.startsWith('login.') || a === 'logout' },
  {
    id: 'crud',
    label: 'CRUD',
    match: a => a.endsWith('.created') || a.endsWith('.updated') || a.endsWith('.deleted'),
  },
  { id: 'rbac', label: 'RBAC', match: a => a.startsWith('rbac.') },
  { id: 'invite', label: 'Convites', match: a => a.startsWith('invite.') },
];

export function AuditLogPage(): ReactElement {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Refetch when filter changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAuditLog({ limit: 200 })
      .then(res => {
        if (cancelled) return;
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // FILTER_GROUPS is a module-level constant populated with 5 entries
  // (see top of file) — [0] is the "all" fallback. We use a runtime
  // guard so the type stays non-undefined without a non-null assertion
  // (which is forbidden by the ESLint config).
  const fallbackGroup: (typeof FILTER_GROUPS)[number] = FILTER_GROUPS[0]
    ? FILTER_GROUPS[0]
    : { id: 'all', label: 'Tudo', match: () => true };
  const group = FILTER_GROUPS.find(g => g.id === filter) ?? fallbackGroup;
  const filtered = entries
    .filter(e => group.match(e.action))
    .filter(e => {
      if (!search.trim()) return true;
      const s = search.toLowerCase();
      return (
        e.action.toLowerCase().includes(s) ||
        (e.actor_email ?? '').toLowerCase().includes(s) ||
        (e.entity_type ?? '').toLowerCase().includes(s) ||
        (e.entity_id ?? '').toLowerCase().includes(s) ||
        (e.ip ?? '').toLowerCase().includes(s)
      );
    });

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <History size={20} aria-hidden />
            Audit Log
          </h1>
          <span className="rounded-full border border-border-bright bg-surface-elevated px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
            {String(total)} eventos
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Tudo, absolutamente tudo: logins, CRUD, RBAC, convites. Filtros abaixo ajudam a encontrar
          o evento que você procura.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
          {FILTER_GROUPS.map(g => {
            const isActive = filter === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  setFilter(g.id);
                }}
                className={
                  'rounded px-3 py-1 text-xs font-medium transition-colors ' +
                  (isActive
                    ? 'bg-brand text-text-inverse'
                    : 'text-text-tertiary hover:bg-surface-elevated hover:text-text-primary')
                }
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            type="search"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
            }}
            placeholder="Buscar por ação, ator, entity ou IP..."
            className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-brand focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 text-xs text-text-tertiary">
          <Filter size={12} aria-hidden />
          {String(filtered.length)} de {String(entries.length)}
        </div>
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-surface">
        {loading && (
          <div className="flex h-32 items-center justify-center text-sm text-text-tertiary">
            Carregando…
          </div>
        )}
        {error && !loading && (
          <div className="flex h-32 flex-col items-center justify-center gap-1 text-sm text-text-tertiary">
            <span className="text-[color:var(--danger,#f87171)]">Erro ao carregar audit log</span>
            <span className="text-xs">{error}</span>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-text-tertiary">
            {entries.length === 0
              ? 'Nenhum evento registrado ainda — aguarde o primeiro login.'
              : 'Nenhum evento corresponde aos filtros.'}
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-elevated text-text-tertiary">
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 font-medium">Quando</th>
                <th className="px-3 py-2 font-medium">Ação</th>
                <th className="px-3 py-2 font-medium">Ator</th>
                <th className="px-3 py-2 font-medium">Entidade</th>
                <th className="px-3 py-2 font-medium">Origem</th>
                <th className="px-3 py-2 font-medium">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => {
                const meta = actionLabel(e.action);
                return (
                  <tr
                    key={e.id}
                    className="border-b border-border-subtle hover:bg-surface-elevated"
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 text-text-secondary">
                      {formatTime(e.created_at)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                        style={{ backgroundColor: meta.color }}
                        title={e.action}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-text-primary">
                      {e.actor_email ? (
                        <div>
                          <div className="font-medium">{e.actor_email}</div>
                          {e.ip && <div className="text-[10px] text-text-tertiary">IP {e.ip}</div>}
                        </div>
                      ) : (
                        <span className="text-text-tertiary">system</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-text-secondary">
                      {e.entity_type ? (
                        <div>
                          <div className="font-medium text-text-primary">{e.entity_type}</div>
                          {e.entity_id && (
                            <div className="text-[10px] text-text-tertiary">
                              {e.entity_id.slice(0, 8)}…
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {e.source}
                      </span>
                    </td>
                    <td className="max-w-xs truncate px-3 py-1.5 text-text-tertiary">
                      {summarizeMeta(e.metadata)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function formatTime(iso: string): string {
  // Compact "DD/MM HH:MM:SS" — drop the year and timezone for readability
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}:${ss}`;
}

function summarizeMeta(meta: Record<string, unknown>): string {
  const keys = Object.keys(meta);
  if (keys.length === 0) return '—';
  // Pick the first 2 most informative keys
  const interesting = keys.filter(k => k !== 'event' && k !== 'source').slice(0, 2);
  return interesting
    .map(k => {
      const v = meta[k];
      const valStr = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${valStr}`;
    })
    .join(' · ');
}
