import { useState, type ReactElement } from 'react';
import { GitBranch, GitCommit, RotateCcw } from 'lucide-react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { getGitLog, revertLastCommit, type GitLogResult } from '../skills/gitLog';

interface GitTurboStripProps {
  codebaseId: string;
}

function relativeTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'never';
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = nowSec - seconds;
  if (delta < 60) return `${String(delta)}s`;
  if (delta < 3600) return `${String(Math.floor(delta / 60))}m`;
  if (delta < 86400) return `${String(Math.floor(delta / 3600))}h`;
  return `${String(Math.floor(delta / 86400))}d`;
}

/**
 * Console-side Git Turbo strip. Two rows: branch + dirty flag + last
 * commit subject, then revert + publish buttons. Lives between the
 * project list and the bottom nav links in ProjectRail.
 *
 * Mirrors the legacy UI's GitTurboPanel; kept in `experiments/console/`
 * because the Console spike is forbidden from importing production
 * web modules (per its README "Isolated" contract) and from
 * @tanstack/react-query (uses the spike's own reactive store).
 */
export function GitTurboStrip({ codebaseId }: GitTurboStripProps): ReactElement {
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [revertPending, setRevertPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useEntity<GitLogResult>(
    K.gitLog(codebaseId),
    (): Promise<GitLogResult> => getGitLog(codebaseId)
  );

  const onRevert = async (): Promise<void> => {
    if (confirmRevert) {
      setRevertPending(true);
      setActionError(null);
      try {
        await revertLastCommit(codebaseId);
        setConfirmRevert(false);
        refetch();
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setRevertPending(false);
      }
    } else {
      setConfirmRevert(true);
    }
  };

  // Defensive: if the user navigates away mid-confirm, reset.
  invalidate(K.gitLog(codebaseId));

  const top = data?.commits[0];
  const busy = revertPending;

  return (
    <div className="mx-2 rounded-md border border-border bg-surface-elevated/40 px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-1.5 text-text-tertiary">
        <GitBranch aria-hidden className="h-3 w-3" />
        <span className="font-mono">{data?.branch ?? '—'}</span>
        <span className="flex-1" />
        {data && (
          <span className={data.dirty ? 'text-warning' : 'text-success'}>
            {data.dirty ? '● dirty' : '● clean'}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-start gap-1.5">
        <GitCommit aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-text-tertiary" />
        <div className="min-w-0 flex-1">
          {loading && <span className="text-text-tertiary">Loading…</span>}
          {error !== undefined && !loading && <span className="text-error">git log failed</span>}
          {top && (
            <>
              <p className="line-clamp-2 text-text-primary" title={top.subject}>
                {top.subject}
              </p>
              <p className="text-[10px] text-text-tertiary">
                <span className="font-mono">{top.shortSha}</span> · {relativeTime(top.timestamp)}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={(): void => {
            void onRevert();
          }}
          disabled={busy || !top}
          title={confirmRevert ? 'Clique de novo pra confirmar' : 'Reverter último commit'}
          className={`flex w-full items-center justify-center gap-1 rounded px-1.5 py-1 transition-colors ${
            confirmRevert
              ? 'bg-error text-error-foreground hover:bg-error/90'
              : 'bg-surface-elevated text-text-secondary hover:bg-surface-elevated/70'
          } ${busy || !top ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <RotateCcw aria-hidden className="h-3 w-3" />
          <span>{revertPending ? '…' : confirmRevert ? 'Confirma?' : 'Reverter'}</span>
        </button>
      </div>

      {actionError !== null && <p className="mt-1 text-[10px] text-error">{actionError}</p>}
    </div>
  );
}
