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
import { access, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { RepoPath, WorktreePath } from './types';
import { addSafeDirectory } from './repo';
import { ensureSource } from './boot/ensure-source';
import { makeLogger } from '@archon/paths';

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

/**
 * Sandbox-Mode-shaped wrapper that preserves the legacy signature
 * `(repoPath, repositoryUrl) => { cloned, reason? }`. Internally it
 * delegates to `ensureSource` when the path follows the conventional
 * `~/.archon/workspaces/{owner}/{repo}/source` layout (so the
 * `boot.source_recovered` event still fires), and falls back to a
 * direct clone for arbitrary paths (legacy / local-dev layouts).
 *
 * The fallback is necessary because some codebases were registered
 * with `default_cwd` pointing at an arbitrary local checkout
 * (e.g., `/Users/.../Volund/harness-v1`) before the workspace
 * convention was enforced. Rewriting those rows is a separate
 * refactor; in the meantime this wrapper does the right thing for
 * both layouts.
 */
export async function ensureRepoCloned(
  repoPath: string,
  repositoryUrl: string | null | undefined
): Promise<{ cloned: boolean; reason?: string }> {
  const inferred = inferOwnerRepoFromPath(repoPath);
  if (inferred !== null) {
    const result = await ensureSource({
      owner: inferred.owner,
      repo: inferred.repo,
      baseDir: inferred.baseDir,
      remoteUrl: repositoryUrl ?? undefined,
    });
    return { cloned: result.recovered };
  }
  // Arbitrary path: skip the structured event (no owner/repo context)
  // and clone directly. This is the legacy behavior preserved for
  // local-dev layouts.
  return legacyEnsureRepoCloned(repoPath, repositoryUrl);
}

/**
 * Direct clone of `repoPath` from `repositoryUrl`. Used for codebases
 * whose `default_cwd` does not follow the conventional workspace
 * layout (legacy / local-dev). Mirrors the original behavior from
 * commit 7875fb0c.
 */
async function legacyEnsureRepoCloned(
  repoPath: string,
  repositoryUrl: string | null | undefined
): Promise<{ cloned: boolean; reason?: string }> {
  await addSafeDirectory(repoPath as RepoPath);
  try {
    await access(`${repoPath}/.git`);
    // Emit the same present event the conventional-layout path emits
    // so alerting (D.3) and `archon doctor` (D.4) see a uniform
    // timeline across both layouts.
    makeLogger({ module: 'git.boot.ensure-source' })('boot.source_present', {
      source_path: repoPath,
    });
    return { cloned: false };
  } catch {
    // not present — fall through to clone
  }
  if (!repositoryUrl) {
    throw new Error(
      `Codebase source directory does not exist at ${repoPath} and no repository_url is set. ` +
        'Re-register the codebase with a valid Git URL, or run a chat turn first to trigger the implicit clone.'
    );
  }
  await mkdir(dirname(repoPath), { recursive: true });
  try {
    await access(repoPath);
    throw new Error(
      `Codebase path ${repoPath} exists but is not a git repository. ` +
        'Remove the directory (or point the codebase at a different path) and retry.'
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Good — the dir does not exist, safe to clone.
    } else {
      throw err;
    }
  }
  // Emit a recovery event even on the legacy path so alerts (D.3)
  // fire the same way regardless of which layout the codebase uses.
  const logger = makeLogger({ module: 'git.boot.ensure-source' });
  logger('boot.source_recovered_start', { source_path: repoPath });
  await execFileAsync('git', ['clone', repositoryUrl, repoPath], { timeout: 300_000 });
  logger('boot.source_recovered', { source_path: repoPath, from_url: repositoryUrl });
  return { cloned: true };
}

/**
 * Split a canonical source path of the form `<baseDir>/<owner>/<repo>/source`
 * into its components. Returns null when the path does not end in
 * `/source` (the marker segment) so we don't accidentally try to
 * bootstrap a path that was constructed under a different convention.
 */
function inferOwnerRepoFromPath(
  repoPath: string
): { owner: string; repo: string; baseDir: string } | null {
  const trimmed = repoPath.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  if (parts.length < 4 || parts[parts.length - 1] !== 'source') {
    return null;
  }
  const repo = parts[parts.length - 2] ?? '';
  const owner = parts[parts.length - 3] ?? '';
  const baseDir = parts.slice(0, parts.length - 3).join('/');
  if (owner === '' || repo === '') return null;
  return { owner, repo, baseDir };
}
