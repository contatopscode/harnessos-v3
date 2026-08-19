/**
 * Console `/console/admin/rbac` — unified RBAC management surface.
 *
 * Three tabs in one screen so the operator can move between users
 * and roles without losing context:
 *   1. Users  — list + per-user role & direct-override editor
 *   2. Roles  — CRUD roles + per-role permission matrix
 *   3. Perms  — read-only catalog (closed set, defined in the seed)
 *
 * Styling follows the Console's `.console-root` theme tokens
 * (surface, border, text-primary, etc.) — never a hard-coded
 * `bg-white` that would clash with the dark sidebar.
 */
import { useState, type ReactElement } from 'react';
import { Users, Shield, BookOpen } from 'lucide-react';
import { RbacUsersPanel } from '../components/RbacUsersPanel';
import { RbacRolesPanel } from '../components/RbacRolesPanel';
import { RbacPermissionsCatalog } from '../components/RbacPermissionsCatalog';
import type { LucideIcon } from 'lucide-react';

type Tab = 'users' | 'roles' | 'permissions';

const TABS: readonly {
  id: Tab;
  label: string;
  description: string;
  Icon: LucideIcon;
}[] = [
  {
    id: 'users',
    label: 'Usuários',
    description: 'Atribuir roles e overrides diretos por usuário.',
    Icon: Users,
  },
  {
    id: 'roles',
    label: 'Roles',
    description: 'CRUD de roles e matriz de permissões por role.',
    Icon: Shield,
  },
  {
    id: 'permissions',
    label: 'Permissões',
    description: 'Catálogo fechado de slugs reconhecidos pelo gate helper.',
    Icon: BookOpen,
  },
];

export function RbacAdminPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-text-primary">Gestão de Usuários · RBAC</h1>
          <span className="rounded-full border border-border-bright bg-surface-elevated px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
            admin
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Crie roles, atribua roles a usuários e defina quais funcionalidades cada combinação
          libera. Permissões e roles de sistema são gerenciadas aqui; o catálogo é fechado (definido
          no seed).
        </p>
      </header>

      <nav aria-label="RBAC tabs" className="flex gap-1 border-b border-border">
        {TABS.map(t => {
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
              }}
              className={
                '-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm transition-colors ' +
                (isActive
                  ? 'border-brand text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary')
              }
              title={t.description}
            >
              <t.Icon size={14} />
              {t.label}
            </button>
          );
        })}
      </nav>

      <section className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'users' && <RbacUsersPanel />}
        {tab === 'roles' && <RbacRolesPanel />}
        {tab === 'permissions' && <RbacPermissionsCatalog />}
      </section>
    </div>
  );
}
