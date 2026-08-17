import { useState, type ReactElement } from 'react';
import { Beaker, Check, X } from 'lucide-react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import {
  createSandbox,
  discardSandbox,
  getSandboxDiff,
  listSandboxes,
  mergeSandbox,
  type SandboxDiff,
  type SandboxListResponse,
  type SandboxSummary,
} from '../skills/sandboxes';

interface SandboxStripProps {
  codebaseId: string;
}

/**
 * Console-side Sandbox Mode panel. Shows the list of active sandboxes for
 * a project, lets the user create a new one, and (per sandbox) view a
 * diff preview + merge into main or discard the experiment.
 *
 * Same constraints as GitTurboStrip: forbidden from prod web modules
 * (own skill layer under `skills/`) and from @tanstack/react-query
 * (uses the spike's own `useEntity`).
 *
 * Two-click confirm on the destructive actions (merge, discard) — the
 * first click swaps the label to "Confirma?" in the destructive color;
 * the second click fires. This matches the GitTurbo revert pattern
 * and keeps a stray misclick from nuking an experiment.
 */
export function SandboxStrip({ codebaseId }: SandboxStripProps): ReactElement {
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | 'merge' | 'discard'>(null);
  const [actionPending, setActionPending] = useState<null | 'merge' | 'discard'>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useEntity<SandboxListResponse>(
    K.sandboxes(codebaseId),
    (): Promise<SandboxListResponse> => listSandboxes(codebaseId)
  );

  const onCreate = async (): Promise<void> => {
    setCreatePending(true);
    setCreateError(null);
    try {
      await createSandbox(codebaseId, {});
      refetch();
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreatePending(false);
    }
  };

  const onAction = async (sandbox: SandboxSummary, action: 'merge' | 'discard'): Promise<void> => {
    if (confirmAction === action) {
      setActionPending(action);
      setActionError(null);
      try {
        if (action === 'merge') {
          await mergeSandbox(sandbox.id);
        } else {
          await discardSandbox(sandbox.id);
        }
        setConfirmAction(null);
        setExpandedId(null);
        refetch();
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setActionPending(null);
      }
    } else {
      setConfirmAction(action);
    }
  };

  // Defensive: if the user navigates away mid-confirm, reset.
  invalidate(K.sandboxes(codebaseId));

  const sandboxes = data?.sandboxes ?? [];
  const busy = createPending || actionPending !== null;

  return (
    <div className="mx-2 rounded-md border border-border bg-surface-elevated/40 px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-1.5 text-text-tertiary">
        <Beaker aria-hidden className="h-3 w-3" />
        <span className="font-mono">Sandboxes</span>
        <span className="flex-1" />
        <span className="text-text-tertiary">
          {sandboxes.length === 0
            ? 'nenhum'
            : `${String(sandboxes.length)} ativo${sandboxes.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {loading && <p className="mt-1 text-text-tertiary">Loading…</p>}
      {error !== undefined && !loading && (
        <p className="mt-1 text-error">list failed: {error.message}</p>
      )}

      {!loading && sandboxes.length > 0 && (
        <ul className="mt-1 space-y-1">
          {sandboxes.map(s => (
            <SandboxRow
              key={s.id}
              sandbox={s}
              expanded={expandedId === s.id}
              onToggle={(): void => {
                setExpandedId(expandedId === s.id ? null : s.id);
                setConfirmAction(null);
                setActionError(null);
              }}
              onAction={onAction}
              confirmAction={confirmAction}
              actionPending={actionPending}
              actionError={actionError}
            />
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={(): void => {
          void onCreate();
        }}
        disabled={busy}
        title="Cria sandbox/<slug> + worktree isolado a partir de main"
        className={`mt-1.5 flex w-full items-center justify-center gap-1 rounded px-1.5 py-1 transition-colors bg-primary text-primary-foreground hover:bg-accent-hover ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <Beaker aria-hidden className="h-3 w-3" />
        <span>{createPending ? 'Criando…' : 'Novo sandbox'}</span>
      </button>

      {createError !== null && <p className="mt-1 text-[10px] text-error">{createError}</p>}
    </div>
  );
}

interface SandboxRowProps {
  sandbox: SandboxSummary;
  expanded: boolean;
  onToggle: () => void;
  onAction: (s: SandboxSummary, action: 'merge' | 'discard') => Promise<void>;
  confirmAction: null | 'merge' | 'discard';
  actionPending: null | 'merge' | 'discard';
  actionError: string | null;
}

function SandboxRow({
  sandbox,
  expanded,
  onToggle,
  onAction,
  confirmAction,
  actionPending,
  actionError,
}: SandboxRowProps): ReactElement {
  // Lazy diff fetch — only when the row is expanded. useEntity handles
  // dedupe + loading/error, and the key is per-sandbox so a re-expand
  // re-fetches automatically.
  const {
    data: diff,
    loading: diffLoading,
    error: diffError,
  } = useEntity<SandboxDiff>(
    expanded ? K.sandboxDiff(sandbox.id) : '__sandbox-diff-idle__',
    (): Promise<SandboxDiff> => getSandboxDiff(sandbox.id)
  );

  return (
    <li className="rounded border border-border/50 bg-surface/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-1.5 py-1 text-left hover:bg-surface-elevated/60"
      >
        <span className="flex-1 truncate font-mono text-text-primary" title={sandbox.branch}>
          {sandbox.slug}
        </span>
        <span className="text-text-tertiary">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/50 px-1.5 py-1">
          <p className="text-[10px] text-text-tertiary">
            <span className="font-mono">{sandbox.worktreePath}</span>
          </p>
          {diffLoading && <p className="mt-1 text-text-tertiary">diff…</p>}
          {diffError !== undefined && !diffLoading && (
            <p className="mt-1 text-error">diff failed: {diffError.message}</p>
          )}
          {diff && (
            <>
              <p className="mt-1 text-[10px] text-text-tertiary">
                <span className={diff.aheadBy > 0 ? 'text-success' : ''}>
                  +{String(diff.aheadBy)}
                </span>{' '}
                /{' '}
                <span className={diff.behindBy > 0 ? 'text-warning' : ''}>
                  -{String(diff.behindBy)}
                </span>
                {' vs '}
                <span className="font-mono">{diff.baseBranch}</span>
              </p>
              {diff.stat.trim() !== '' && (
                <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1 text-[10px] text-text-secondary">
                  {diff.stat}
                </pre>
              )}
              {diff.preview.trim() !== '' && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1 font-mono text-[10px] text-text-secondary">
                  {diff.preview}
                </pre>
              )}
            </>
          )}
          <div className="mt-1.5 flex items-center gap-1">
            <button
              type="button"
              onClick={(): void => {
                void onAction(sandbox, 'merge');
              }}
              disabled={actionPending !== null}
              title={
                confirmAction === 'merge'
                  ? 'Clique de novo pra confirmar merge em main'
                  : 'Merge em main (FF ou no-ff)'
              }
              className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 transition-colors ${
                confirmAction === 'merge'
                  ? 'bg-success text-success-foreground hover:bg-success/90'
                  : 'bg-surface-elevated text-text-secondary hover:bg-surface-elevated/70'
              } ${actionPending !== null ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <Check aria-hidden className="h-3 w-3" />
              <span>
                {actionPending === 'merge'
                  ? '…'
                  : confirmAction === 'merge'
                    ? 'Confirma merge?'
                    : 'Aprovar'}
              </span>
            </button>
            <button
              type="button"
              onClick={(): void => {
                void onAction(sandbox, 'discard');
              }}
              disabled={actionPending !== null}
              title={
                confirmAction === 'discard'
                  ? 'Clique de novo pra confirmar descarte'
                  : 'Descartar sandbox (sem merge)'
              }
              className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 transition-colors ${
                confirmAction === 'discard'
                  ? 'bg-error text-error-foreground hover:bg-error/90'
                  : 'bg-surface-elevated text-text-secondary hover:bg-surface-elevated/70'
              } ${actionPending !== null ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <X aria-hidden className="h-3 w-3" />
              <span>
                {actionPending === 'discard'
                  ? '…'
                  : confirmAction === 'discard'
                    ? 'Confirma descarte?'
                    : 'Descartar'}
              </span>
            </button>
          </div>
          {actionError !== null && <p className="mt-1 text-[10px] text-error">{actionError}</p>}
        </div>
      )}
    </li>
  );
}
