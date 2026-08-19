import { NavLink } from 'react-router';
import {
  Users,
  FolderKanban,
  Trello,
  Workflow,
  Bot,
  Sparkles,
  Receipt,
  Activity,
  MessageSquare,
  LogOut,
  Flame,
} from 'lucide-react';
import { useSession, signOut } from '../lib/auth-client';
import { cn } from '../lib/cn';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Users;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/clientes', label: 'Clientes', icon: Users },
  { to: '/projetos', label: 'Projetos', icon: FolderKanban },
  { to: '/demandas', label: 'Demandas', icon: Trello },
  { to: '/pipelines', label: 'Pipelines', icon: Workflow },
  { to: '/subagents', label: 'SubAgents', icon: Bot },
  { to: '/skills', label: 'Skills', icon: Sparkles },
  { to: '/custos', label: 'Custos', icon: Receipt },
  { to: '/traces', label: 'Traces', icon: Activity },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
];

interface SidebarProps {
  currentPath: string;
}

export function Sidebar({ currentPath: _currentPath }: SidebarProps) {
  const { data: session } = useSession();

  const userName = (session?.user as { name?: string } | undefined)?.name ?? '—';
  const userEmail = session?.user?.email ?? '';

  return (
    <aside
      className="flex w-[240px] flex-col border-r border-[var(--border)] bg-[var(--surface-inset)]"
      aria-label="Navegação principal"
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-5">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md"
          style={{ background: 'var(--brand-gradient)' }}
        >
          <Flame className="h-4 w-4 text-white" aria-hidden />
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
            VOLUND
          </div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">FORGE</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-2 pt-2">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* User card */}
      <div className="border-t border-[var(--border)] p-3">
        <div className="mb-2 truncate rounded-md bg-[var(--surface-elevated)] px-2.5 py-2">
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {userName}
          </div>
          <div className="truncate text-[10.5px] text-[var(--text-tertiary)]">
            {userEmail}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void signOut().then(() => {
              window.location.href = '/login';
            });
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden />
          Sair
        </button>
      </div>
    </aside>
  );
}
