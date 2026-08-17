import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCodebaseGitLog,
  publishCodebase,
  revertCodebaseLastCommit,
  type GitLogResult,
} from '@/lib/api';
import { cn } from '@/lib/utils';

interface GitTurboPanelProps {
  codebaseId: string;
}

function relativeTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'never';
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = nowSec - seconds;
  if (delta < 60) return `${String(delta)}s ago`;
  if (delta < 3600) return `${String(Math.floor(delta / 60))}m ago`;
  if (delta < 86400) return `${String(Math.floor(delta / 3600))}h ago`;
  return `${String(Math.floor(delta / 86400))}d ago`;
}

/**
 * Sidebar card for the "Git Turbo" workflow (legacy UI). Shows the most
 * recent commit (subject + relative time + branch) and gives one-click
 * access to revert the last commit and publish the current branch to
 * origin.
 *
 * The Console (new UI) renders the compact variant in ProjectRail instead.
 */
export function GitTurboPanel({ codebaseId }: GitTurboPanelProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [confirmRevert, setConfirmRevert] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['git-log', { codebaseId }],
    queryFn: (): Promise<GitLogResult> => getCodebaseGitLog(codebaseId),
    refetchInterval: 10_000,
  });

  const revert = useMutation({
    mutationFn: (): Promise<{ reverted: { sha: string; subject: string } }> =>
      revertCodebaseLastCommit(codebaseId),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['git-log', { codebaseId }] });
      setConfirmRevert(false);
    },
  });

  const publish = useMutation({
    mutationFn: (): Promise<{ branch: string; remote: string; ref: string }> =>
      publishCodebase(codebaseId),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['git-log', { codebaseId }] });
    },
  });

  const top = data?.commits[0];
  const busy = revert.isPending || publish.isPending;

  return (
    <div className="rounded-md border border-border bg-surface-elevated/40 px-2 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-wider text-[10px] text-text-tertiary">
          Histórico
        </span>
        {data && (
          <span
            className={cn(
              'shrink-0 text-[10px] font-mono',
              data.dirty ? 'text-warning' : 'text-text-tertiary'
            )}
          >
            {data.dirty ? '● dirty' : '● clean'} · {data.branch}
          </span>
        )}
      </div>

      <div className="mt-1.5 min-h-[2.25rem]">
        {isLoading && <p className="text-text-tertiary">Loading…</p>}
        {isError && <p className="text-error">Failed to load git log</p>}
        {top && (
          <>
            <p className="line-clamp-2 text-text-primary" title={top.subject}>
              {top.subject}
            </p>
            <p className="mt-0.5 text-[10px] text-text-tertiary">
              <span className="font-mono">{top.shortSha}</span> · {top.author} ·{' '}
              {relativeTime(top.timestamp)}
            </p>
          </>
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={(): void => {
            if (confirmRevert) {
              revert.mutate();
            } else {
              setConfirmRevert(true);
            }
          }}
          disabled={busy || !top}
          className={cn(
            'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            confirmRevert
              ? 'bg-error text-error-foreground hover:bg-error/90'
              : 'bg-surface-elevated text-text-secondary hover:bg-surface-elevated/70',
            (busy || !top) && 'opacity-50 cursor-not-allowed'
          )}
        >
          {revert.isPending
            ? 'Reverting…'
            : confirmRevert
              ? 'Confirm revert?'
              : 'Reverter último commit'}
        </button>
        <button
          onClick={(): void => {
            publish.mutate();
          }}
          disabled={busy}
          className={cn(
            'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            'bg-primary text-primary-foreground hover:bg-accent-hover',
            busy && 'opacity-50 cursor-not-allowed'
          )}
        >
          {publish.isPending ? 'Publishing…' : 'Publicar'}
        </button>
      </div>
      {(revert.error || publish.error) && (
        <p className="mt-1.5 text-[10px] text-error">
          {revert.error?.message ?? publish.error?.message}
        </p>
      )}
    </div>
  );
}
