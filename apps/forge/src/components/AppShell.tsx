import { Outlet, useLocation } from 'react-router';
import { Sidebar } from './Sidebar';
import { useSession } from '../lib/auth-client';

/**
 * AppShell — left rail + main content. Renders a 401-ish splash when
 * the user is not signed in (FORGE requires Better Auth — same cookie
 * as the HarnessOS web UI but consumed cross-origin).
 */
export function AppShell() {
  const location = useLocation();
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-[var(--text-tertiary)] text-sm">Verificando sessão…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)]">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
            FORGE — sessão necessária
          </h1>
          <p className="mt-3 text-sm text-[var(--text-secondary)]">
            Você precisa estar autenticado no HarnessOS pra acessar o
            FORGE. O login é compartilhado entre os dois apps.
          </p>
          <a
            href="/login"
            className="mt-6 inline-flex items-center justify-center rounded-[10px] bg-[var(--brand-magenta)] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
          >
            Ir pra tela de login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--background)]">
      <Sidebar currentPath={location.pathname} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-8 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
