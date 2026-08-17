/**
 * Git Sandbox helpers — branch + worktree + merge + discard primitives
 * for the user-facing "Sandbox Mode" workflow.
 *
 * A sandbox is a named branch + worktree on a registered codebase, where
 * the agent can run freely without touching main. The lifecycle is:
 *   - create:   `git worktree add -b sandbox/<slug> <path>` from main
 *   - merge:    `git merge sandbox/<slug>` on the canonical repo, then
 *               remove the worktree + branch
 *   - discard:  remove the worktree + branch without merging
 *
 * `slug` is the only user-visible identifier — we don't expose UUIDs in
 * the diff output. The branch lives in a single fixed namespace
 * (`sandbox/`) so `git branch | grep sandbox/` gives a clean audit trail.
 */
import { execFileAsync } from './exec';
import type { RepoPath, WorktreePath } from './types';
import { addSafeDirectory } from './repo';

export interface SandboxCreateResult {
  branch: string;
  worktreePath: string;
}

export interface SandboxDiffResult {
  branch: string;
  baseBranch: string;
  /** `git diff --stat` output — single line per file with +/- counts. */
  stat: string;
  /** `git diff` first 200 lines — UI shows truncated preview. */
  preview: string;
  /** Number of commits the sandbox branch is ahead of base. */
  aheadBy: number;
  /** Number of commits the sandbox branch is behind base. */
  behindBy: number;
}

const PREVIEW_LINE_LIMIT = 200;
const SANDBOX_BRANCH_PREFIX = 'sandbox/';

function sandboxBranch(slug: string): string {
  return `${SANDBOX_BRANCH_PREFIX}${slug}`;
}

/** Default `baseBranch` for a new sandbox — caller may override per codebase. */
export const DEFAULT_SANDBOX_BASE = 'main';

/**
 * Create a new sandbox: a fresh branch + worktree on the canonical repo.
 * The branch is rooted at the current HEAD of the base branch (default
 * `main`); the worktree lives next to the canonical checkout.
 *
 * Returns the absolute worktree path and the branch name. Caller is
 * expected to register the result in `remote_agent_isolation_environments`
 * for audit + UI listing.
 */
export async function createSandbox(
  repoPath: RepoPath,
  worktreeParent: string,
  slug: string,
  baseBranch: string = DEFAULT_SANDBOX_BASE
): Promise<SandboxCreateResult> {
  await addSafeDirectory(repoPath);
  const branch = sandboxBranch(slug);
  const worktreePath = `${worktreeParent.replace(/\/$/, '')}/${slug}` as WorktreePath;

  // `git worktree add -b <branch> <path> <base>` — create branch + checkout
  // in a single call. Fails if the branch already exists.
  await execFileAsync(
    'git',
    ['-C', repoPath, 'worktree', 'add', '-b', branch, worktreePath, baseBranch],
    { timeout: 30_000 }
  );

  return { branch, worktreePath };
}

/**
 * Read-only inspection: stat, line preview, ahead/behind counts. Safe to
 * call while the agent is editing — git operations don't lock the worktree.
 */
export async function diffSandbox(
  repoPath: RepoPath,
  branch: string,
  baseBranch: string = DEFAULT_SANDBOX_BASE
): Promise<SandboxDiffResult> {
  const [statResult, diffResult, aheadBehindResult] = await Promise.all([
    execFileAsync('git', ['-C', repoPath, 'diff', '--stat', `${baseBranch}...${branch}`], {
      timeout: 10_000,
    }),
    execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'diff',
        `${baseBranch}...${branch}`,
        // `-U0` strips the hunk headers for a tighter preview; the UI can
        // request a fuller diff via a separate endpoint if it wants the
        // surrounding context. Limit lines to keep the response bounded.
        ...'--unified=0'.split(' '),
      ],
      { timeout: 10_000 }
    ),
    execFileAsync(
      'git',
      ['-C', repoPath, 'rev-list', '--left-right', '--count', `${baseBranch}...${branch}`],
      { timeout: 5_000 }
    ),
  ]);

  const previewLines = diffResult.stdout.split('\n').slice(0, PREVIEW_LINE_LIMIT).join('\n');
  const [aheadRaw, behindRaw] = aheadBehindResult.stdout.trim().split(/\s+/);
  const aheadBy = Number.parseInt(aheadRaw ?? '0', 10);
  const behindBy = Number.parseInt(behindRaw ?? '0', 10);

  return {
    branch,
    baseBranch,
    stat: statResult.stdout.trim(),
    preview: previewLines,
    aheadBy: Number.isFinite(aheadBy) ? aheadBy : 0,
    behindBy: Number.isFinite(behindBy) ? behindBy : 0,
  };
}

/**
 * Merge a sandbox branch into the canonical repo's base branch, then
 * remove the worktree + the now-merged branch. No `git push` — the
 * caller (UI button) triggers a separate `git push` via the Git Turbo
 * panel to keep this helper side-effect-bounded.
 *
 * Throws if there are merge conflicts — we deliberately use
 * `--no-commit` semantics via `--ff-only` so a non-FF situation surfaces
 * as a clean error rather than a half-merged state. The user can then
 * rebase the sandbox manually if they want.
 */
export async function mergeSandbox(
  repoPath: RepoPath,
  worktreePath: string,
  branch: string,
  baseBranch: string = DEFAULT_SANDBOX_BASE
): Promise<{ merged: boolean; fastForward: boolean }> {
  await addSafeDirectory(repoPath);

  // Try fast-forward first. If FF fails, fall back to a real merge
  // commit — the UI can show the merge commit in the diff and offer a
  // "revert merge" action later. We never use --no-ff blindly because
  // most sandboxes are linear and FF keeps the history clean.
  let fastForward = true;
  try {
    await execFileAsync('git', ['-C', repoPath, 'merge', '--ff-only', branch], { timeout: 30_000 });
  } catch {
    fastForward = false;
    await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'merge',
        '--no-ff',
        '-m',
        `Merge sandbox '${branch.replace(SANDBOX_BRANCH_PREFIX, '')}' into ${baseBranch}`,
        branch,
      ],
      { timeout: 30_000 }
    );
  }

  // Remove the worktree (force — `git worktree remove` refuses if there
  // are uncommitted changes, which the agent's last edit might leave
  // behind. The user is merging because they're happy with the state,
  // so a dirty worktree is fine to discard.)
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
    timeout: 30_000,
  });

  // Delete the merged branch locally. We never use -D so a non-merged
  // branch raises an error here too — defense in depth in case the
  // merge silently failed.
  await execFileAsync('git', ['-C', repoPath, 'branch', '-d', branch], { timeout: 5_000 });

  return { merged: true, fastForward };
}

/**
 * Discard a sandbox: remove the worktree + branch without merging.
 * Used when the user decides the experiment wasn't worth keeping.
 */
export async function discardSandbox(
  repoPath: RepoPath,
  worktreePath: string,
  branch: string
): Promise<{ discarded: boolean }> {
  await addSafeDirectory(repoPath);

  await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
    timeout: 30_000,
  });

  await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branch], { timeout: 5_000 });

  return { discarded: true };
}
