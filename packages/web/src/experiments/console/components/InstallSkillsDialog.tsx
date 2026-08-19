import { useEffect, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { Project } from '../primitives/project';

interface InstallSkillsDialogProps {
  project: Project | null;
  onClose: () => void;
}

type InstallState =
  | { kind: 'running' }
  | { kind: 'ok'; fileCount: number; skillsRoots: string[]; targetPath: string }
  | { kind: 'error'; message: string };

/**
 * Per-project "Install skills" feedback dialog. The Web UI never writes files
 * directly — the server's `POST /api/codebases/{id}/skills` does the work
 * and returns the absolute paths + file count. This dialog just surfaces
 * the result so the user can confirm before restarting Claude Code / Codex.
 */
export function InstallSkillsDialog({
  project,
  onClose,
}: InstallSkillsDialogProps): ReactElement | null {
  const [state, setState] = useState<InstallState>({ kind: 'running' });

  // Auto-run the install as soon as the dialog opens with a valid project.
  useEffect(() => {
    if (project === null) return;
    let cancelled = false;
    setState({ kind: 'running' });
    void (async (): Promise<void> => {
      try {
        const res = await skill.installProjectSkills(project.id);
        if (cancelled) return;
        setState({
          kind: 'ok',
          fileCount: res.fileCount,
          skillsRoots: res.skillsRoots,
          targetPath: res.targetPath,
        });
      } catch (err: unknown) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Falha ao instalar skills',
        });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [project]);

  if (project === null) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Instalar skills em ${project.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-[520px] overflow-hidden rounded-2xl border bg-surface-elevated p-[22px] text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />
        <header className="mb-[18px]">
          <h2 className="text-[18px] font-extrabold tracking-[-0.3px] text-text-primary">
            Instalar skills
          </h2>
          <p className="mt-1 text-[13px] text-text-tertiary">
            Os skills <code>archon</code> e <code>manage-run</code> serão gravados em{' '}
            <code className="font-mono">{project.path}</code> para que Claude Code e Codex carreguem
            na próxima sessão.
          </p>
        </header>

        {state.kind === 'running' ? (
          <p className="font-mono text-[12px] text-text-tertiary">Gravando arquivos…</p>
        ) : state.kind === 'error' ? (
          <p className="rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[12px] text-error">
            {state.message}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-[12px] text-success">
              {state.fileCount} arquivos gravados em cada destino.
            </p>
            <ul className="space-y-1 rounded-[11px] border bg-surface p-3 font-mono text-[11.5px] text-text-secondary">
              {state.skillsRoots.map((root: string) => (
                <li key={root} className="truncate">
                  • {root}
                </li>
              ))}
            </ul>
            <p className="font-mono text-[11px] text-text-tertiary">
              Reinicie o Claude Code ou Codex para carregar os skills atualizados.
            </p>
          </div>
        )}

        <div className="mt-[22px] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[10px] border bg-transparent px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
