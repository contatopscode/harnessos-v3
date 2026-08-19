import type { JSX } from 'react';
import { Link } from 'react-router';
import { Compass } from 'lucide-react';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="flex h-64 flex-col items-center justify-center text-center">
      <Compass className="mb-3 h-8 w-8 text-[var(--text-tertiary)]" />
      <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">404</h1>
      <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
        Essa rota não existe no FORGE.
      </p>
      <Link
        to="/projetos"
        className="mt-4 inline-flex items-center justify-center rounded-md bg-[var(--brand-magenta)] px-4 py-2 text-[12.5px] font-medium text-white transition hover:bg-[var(--accent-hover)]"
      >
        Ir pra Projetos
      </Link>
    </div>
  );
}
