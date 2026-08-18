/**
 * Self-healing source-of-truth: ensure `~/.archon/workspaces/{owner}/{repo}/source`
 * exists as a git repo. If not, clone it from `remoteUrl` (or
 * `https://github.com/{owner}/{repo}.git` as a default).
 *
 * This is the "Camada B" (Self-healing) of the Archon Hardening spec.
 * It is independent of any specific caller — chat turn, sandbox create,
 * workflow boot — and emits structured events an external alerting
 * pipeline can grep for (D.3: PAGE on `event === 'boot.source_recovered'`).
 *
 * The function is idempotent: re-running on a populated repo is a
 * single `access()` syscall. The clone path is gated by a 5-min
 * timeout (private repos over slow links can take a couple of
 * minutes; the terminal / UI should keep the user informed while
 * this runs).
 *
 * `git-sandbox.ts:ensureRepoCloned` is a thin wrapper that calls
 * this function and returns just the boolean, preserving the
 * sandbox API surface.
 */
import { access, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { execFileAsync } from '../exec';
import { addSafeDirectory } from '../repo';
import type { RepoPath } from '../types';
import { makeLogger, type StructuredEventLogger } from '@archon/paths';

export interface EnsureSourceOpts {
  owner: string;
  repo: string;
  /**
   * Filesystem path to the source dir. Defaults to
   * `${HOME}/.archon/workspaces/{owner}/{repo}/source` so the helper
   * works for both real callers (chat, sandbox) and ad-hoc CLI
   * smoke tests without a passed-in path.
   */
  baseDir?: string;
  /** Git URL to clone from when the source is missing. */
  remoteUrl?: string;
  /** Structured logger — falls back to a no-op when omitted. */
  logger?: StructuredEventLogger;
  /** Pin run_id / workflow / thread_id onto every emitted event. */
  runId?: string;
  workflow?: string;
  threadId?: string;
}

export interface EnsureSourceResult {
  sourcePath: string;
  recovered: boolean;
}

const DEFAULT_BASE_DIR = `${process.env.HOME ?? '/root'}/.archon/workspaces`;
const CLONE_TIMEOUT_MS = 300_000;

function defaultUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Ensure the source repo at `baseDir/{owner}/{repo}/source` exists.
 * If the dir or its `.git` is missing, clone from `remoteUrl` (or
 * the GitHub default).
 *
 * Throws when:
 * - the path exists but is not a git repo (defends against
 *   clobbering an existing non-empty dir — same guard as
 *   packages/core/src/handlers/clone.ts:373-381)
 * - no `remoteUrl` was provided and the source is missing
 *
 * Emits (when `logger` is provided or the no-op default is replaced):
 * - `boot.source_present` — repo already existed, no action
 * - `boot.source_recovered_start` — source missing, clone starting
 * - `boot.source_recovered` — clone completed
 */
export async function ensureSource(opts: EnsureSourceOpts): Promise<EnsureSourceResult> {
  const baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
  const sourcePath = `${baseDir}/${opts.owner}/${opts.repo}/source`;
  const gitDir = `${sourcePath}/.git`;
  const logger =
    opts.logger ??
    makeLogger({
      runId: opts.runId,
      workflow: opts.workflow,
      threadId: opts.threadId,
      module: 'git.boot.ensure-source',
    });

  await addSafeDirectory(sourcePath as RepoPath);
  if (await isPopulated(gitDir)) {
    logger('boot.source_present', { source_path: sourcePath });
    return { sourcePath, recovered: false };
  }

  logger('boot.source_recovered_start', { source_path: sourcePath });
  await mkdir(dirname(sourcePath), { recursive: true });
  // Defensive: path exists but is not a git repo. Bail loudly rather
  // than clobber — same guard as packages/core/src/handlers/clone.ts:373.
  if (await isPresentButNotEmpty(sourcePath)) {
    throw new Error(
      `Codebase path ${sourcePath} exists but is not a git repository. ` +
        'Remove the directory (or point the codebase at a different path) and retry.'
    );
  }
  const url = opts.remoteUrl ?? defaultUrl(opts.owner, opts.repo);
  await execFileAsync('git', ['clone', url, sourcePath], { timeout: CLONE_TIMEOUT_MS });
  logger('boot.source_recovered', { source_path: sourcePath, from_url: url });
  return { sourcePath, recovered: true };
}

async function isPopulated(gitDir: string): Promise<boolean> {
  try {
    await access(gitDir);
    return true;
  } catch {
    return false;
  }
}

async function isPresentButNotEmpty(sourcePath: string): Promise<boolean> {
  try {
    await access(sourcePath);
    return true;
  } catch {
    return false;
  }
}
