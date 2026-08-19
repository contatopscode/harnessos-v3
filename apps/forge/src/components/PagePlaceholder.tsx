import { Construction } from 'lucide-react';

interface PagePlaceholderProps {
  title: string;
  description: string;
  bullets?: string[];
}

/**
 * Placeholder for a FORGE page that's not yet implemented.
 * PR2 (skeleton) uses this for every route so the navigation works
 * end-to-end; subsequent PRs replace each placeholder with the real
 * implementation.
 */
export function PagePlaceholder({ title, description, bullets = [] }: PagePlaceholderProps) {
  return (
    <div className="max-w-[760px]">
      <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
        <Construction className="h-3 w-3" aria-hidden />
        Em construção
      </div>
      <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">{title}</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
        {description}
      </p>
      {bullets.length > 0 && (
        <ul className="mt-5 space-y-1.5 text-[13px] text-[var(--text-secondary)]">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-magenta)]" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
