/**
 * Git Turbo helpers — auto-commit, log, revert, and publish primitives
 * for the "Git Turbo" workflow (always-on versioned working state,
 * with a one-click revert and publish).
 *
 * The MVP assumes a single linear history on the working branch:
 *   - `commitIfDirty` adds + commits with a deterministic message
 *   - `getRecentLog` parses `git log` into a small JSON shape the UI can render
 *   - `revertLastCommit` rolls back the most recent local commit (no remote push)
 *   - `publishBranch` pushes the current branch to the configured remote
 *
 * Conflict / merge cases are out of scope — the worktree isolation layer
 * already owns the "branch per agent run" concern, so a Turbo revert
 * never has to reason about merging divergent branches.
 */
import { execFileAsync } from './exec';
import type { RepoPath } from './types';

/** One commit as returned by `getRecentLog`. Datestamp is ISO-8601 UTC. */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Seconds since epoch (UTC) — number to keep the wire format small. */
  timestamp: number;
}

export interface GitLogResult {
  branch: string;
  totalCommits: number;
  commits: CommitSummary[];
  /** True when the working tree has uncommitted changes since HEAD. */
  dirty: boolean;
}

export interface GitTurboOptions {
  /** Min seconds between auto-commits. Default 60. */
  minIntervalSec?: number;
  /** Override the message template (default: `auto: <summary>`). */
  buildMessage?: (changedFileCount: number) => string;
}

const DEFAULT_MIN_INTERVAL_SEC = 60;
const DEFAULT_LOG_LIMIT = 20;

/**
 * Auto-commit any dirty files in the working path. Returns the new
 * commit sha, or null when nothing was committed (clean tree, or throttled
 * by the min-interval guard).
 *
 * The interval guard keeps Turbo from spamming the log when the agent
 * is editing in tight bursts — it just holds the next commit until the
 * throttle window expires, then a single commit captures all the bursts.
 */
export async function commitIfDirty(
  workingPath: RepoPath,
  summary: string,
  options: GitTurboOptions = {}
): Promise<{ sha: string; committed: boolean; throttled: boolean } | null> {
  const minInterval = options.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;
  const lastCommitAt = await getLastCommitTimestamp(workingPath);
  const now = Math.floor(Date.now() / 1000);
  const throttled = lastCommitAt !== null && now - lastCommitAt < minInterval;

  if (throttled) {
    return { sha: '', committed: false, throttled: true };
  }

  const dirty = await isDirty(workingPath);
  if (!dirty) {
    return null;
  }

  const fileCount = await countChangedFiles(workingPath);
  const message = options.buildMessage ? options.buildMessage(fileCount) : `auto: ${summary}`;

  await execFileAsync('git', ['-C', workingPath, 'add', '-A'], { timeout: 10000 });
  await execFileAsync('git', ['-C', workingPath, 'commit', '-m', message], { timeout: 15000 });

  const sha = (await execFileAsync('git', ['-C', workingPath, 'rev-parse', 'HEAD'])).stdout.trim();
  return { sha, committed: true, throttled: false };
}

/** True when the working tree has changes vs HEAD (staged OR unstaged). */
export async function isDirty(workingPath: RepoPath): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain'], {
    timeout: 5000,
  });
  return stdout.trim().length > 0;
}

/** Number of files changed in the working tree (modified, added, deleted). */
async function countChangedFiles(workingPath: RepoPath): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain'], {
    timeout: 5000,
  });
  return stdout.split('\n').filter(line => line.trim().length > 0).length;
}

async function getLastCommitTimestamp(workingPath: RepoPath): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingPath, 'log', '-1', '--format=%ct'],
      { timeout: 5000 }
    );
    const ts = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Returns the most recent commits on the current branch (newest first).
 * Use this for the "Histórico" panel in the Console — small enough to
 * render inline without pagination for the MVP.
 */
export async function getRecentLog(
  workingPath: RepoPath,
  limit: number = DEFAULT_LOG_LIMIT
): Promise<GitLogResult> {
  const format = '%H%x1f%h%x1f%s%x1f%an%x1f%ct';
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workingPath, 'log', `-n${limit}`, `--format=${format}`],
    { timeout: 5000 }
  );
  const commits: CommitSummary[] = stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [sha, shortSha, subject, author, ts] = line.split('\x1f');
      return {
        sha: sha ?? '',
        shortSha: shortSha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        timestamp: Number.parseInt(ts ?? '0', 10),
      };
    });

  const { stdout: branchOut } = await execFileAsync(
    'git',
    ['-C', workingPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeout: 5000 }
  );
  const dirty = await isDirty(workingPath);

  return {
    branch: branchOut.trim() || 'HEAD',
    totalCommits: commits.length,
    commits,
    dirty,
  };
}

/**
 * Roll back the most recent local commit, keeping the working tree
 * changes staged (so the agent can re-commit them with a fresh message).
 *
 * We use `git reset --soft HEAD~1` rather than `git revert` because
 * Turbo is for the local working state — there's no shared history to
 * preserve yet. A `--soft` reset puts the changes back in the index,
 * a `--mixed` would unstage them. Soft matches the "oops, message was
 * wrong" use case the UI is built for.
 */
export async function revertLastCommit(
  workingPath: RepoPath
): Promise<{ sha: string; subject: string } | null> {
  const headLog = await getRecentLog(workingPath, 1);
  const top = headLog.commits[0];
  if (!top) {
    return null; // Nothing to revert
  }
  await execFileAsync('git', ['-C', workingPath, 'reset', '--soft', 'HEAD~1'], { timeout: 10000 });
  return { sha: top.sha, subject: top.subject };
}

/**
 * Push the current branch to the configured remote. Returns the upstream
 * ref name on success.
 *
 * No `--force`, no `--set-upstream` magic — we explicitly set the
 * upstream the first time so the next push is the cheap fast-forward.
 * If the remote rejected (e.g. non-FF), the error bubbles up to the
 * caller with stderr so the UI can surface the actual reason.
 */
export async function publishBranch(
  workingPath: RepoPath,
  remote = 'origin'
): Promise<{ branch: string; remote: string; ref: string }> {
  const { stdout: branchOut } = await execFileAsync(
    'git',
    ['-C', workingPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeout: 5000 }
  );
  const branch = branchOut.trim();
  if (!branch) {
    throw new Error('publishBranch: cannot resolve current branch');
  }

  await execFileAsync('git', ['-C', workingPath, 'push', '--set-upstream', remote, branch], {
    timeout: 60000,
  });
  // The push output ends with the remote ref line ("remote: ... -> main")
  // or the local ref line ("* [new branch]"). Either way the caller just
  // needs to know the ref name, which is `refs/heads/<branch>`.
  return { branch, remote, ref: `refs/heads/${branch}` };
}
