/**
 * Console `/console/admin/rbac` — unified RBAC management surface.
 *
 * Three tabs in one screen so the operator can move between users
 * and roles without losing context:
 *   1. Users  — list + per-user role & direct-override editor
 *   2. Roles  — CRUD roles + per-role permission matrix
 *   3. Perms  — read-only catalog (closed set, defined in the seed)
 *
 * All three tabs share the same fetch / mutation cadence; each panel
 * has its own refresh button so a single mutation in one tab doesn't
 * force a full re-render of the others.
 */
import { useState, type ReactElement } from 'react';
import { RbacUsersPanel } from '../components/RbacUsersPanel';
import { RbacRolesPanel } from '../components/RbacRolesPanel';
import { RbacPermissionsCatalog } from '../components/RbacPermissionsCatalog';

type Tab = 'users' | 'roles' | 'permissions';

const TABS: readonly { id: Tab; label: string; description: string }[] = [
  {
    id: 'users',
    label: 'Usuários',
    description: 'Atribuir roles e overrides diretos por usuário.',
  },
  {
    id: 'roles',
    label: 'Roles',
    description: 'CRUD de roles e matriz de permissões por role.',
  },
  {
    id: 'permissions',
    label: 'Permissões',
    description: 'Catálogo fechado de slugs reconhecidos pelo gate helper.',
  },
];

export function RbacAdminPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-semibold">Gestão de Usuários · RBAC</h1>
        <p className="text-xs text-zinc-500">
          Crie roles, atribua roles a usuários, e defina quais funcionalidades cada combinação
          libera.
        </p>
      </header>

      <nav
        aria-label="RBAC tabs"
        className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
      >
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
            }}
            className={`-mb-px rounded-t border-x border-t px-3 py-1.5 text-sm ${
              tab === t.id
                ? 'border-zinc-200 border-b-white bg-white font-medium dark:border-zinc-800 dark:border-b-zinc-950 dark:bg-zinc-950'
                : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
            title={t.description}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <section className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        {tab === 'users' && <RbacUsersPanel />}
        {tab === 'roles' && <RbacRolesPanel />}
        {tab === 'permissions' && <RbacPermissionsCatalog />}
      </section>
    </div>
  );
}
