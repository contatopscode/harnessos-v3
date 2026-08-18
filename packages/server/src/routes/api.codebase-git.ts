/**
 * Git Turbo REST endpoints — the runtime surface for the always-on
 * versioned working state the user sees in the Console sidebar.
 *
 *   GET  /api/codebases/{id}/git-log        — last 20 commits, dirty flag, branch
 *   POST /api/codebases/{id}/git-revert     — soft-reset HEAD~1 (keeps changes staged)
 *   POST /api/codebases/{id}/git-publish    — git push --set-upstream origin HEAD
 *
 * All three endpoints resolve the codebase's default_cwd (the clone path
 * inside the container) and shell out to git via @archon/git. No state
 * lives on the server beyond the call — Turbo is intentionally a thin
 * wrapper so the UI can call it from a button click.
 *
 * Errors here are user-facing and meant to be shown as toast messages
 * in the Console, so the error messages stay short and actionable.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  getRecentLog,
  publishBranch as publishBranchImpl,
  revertLastCommit as revertLastCommitImpl,
} from '@archon/git';
import * as codebaseDb from '@archon/core/db/codebases';
import { apiError } from './api-error';
import { codebaseIdParamsSchema } from './schemas/codebase.schemas';

// ---------------------------------------------------------------------------
// Route configs (OpenAPI)
// ---------------------------------------------------------------------------

/** Helper to build a JSON error response entry for createRoute configs. */
function jsonError(description: string): {
  content: { 'application/json': { schema: ReturnType<typeof errorJsonSchema> } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorJsonSchema() } }, description };
}

function errorJsonSchema(): z.ZodObject<{ error: z.ZodString }> {
  return z.object({ error: z.string() });
}

export const getLogRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/git-log',
  tags: ['Codebases'],
  summary: 'Recent git log for a codebase working directory',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      // Real Zod object (not z.custom / z.unknown) so the OpenAPI
      // generator can render it. The shape mirrors `GitLogResult`
      // from @archon/git; keep both in sync if either changes.
      content: {
        'application/json': {
          schema: z
            .object({
              branch: z.string(),
              totalCommits: z.number().int().nonnegative(),
              dirty: z.boolean(),
              commits: z.array(
                z.object({
                  sha: z.string(),
                  shortSha: z.string(),
                  subject: z.string(),
                  author: z.string(),
                  timestamp: z.number().int(),
                })
              ),
            })
            .openapi('GitLogResult'),
        },
      },
      description: 'Recent commits with dirty flag',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Git log failed'),
  },
});

export const revertRoute = createRoute({
  method: 'post',
  path: '/api/codebases/{id}/git-revert',
  tags: ['Codebases'],
  summary: 'Soft-reset the most recent local commit (keeps changes staged)',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            reverted: z.object({ sha: z.string(), subject: z.string() }),
          }),
        },
      },
      description: 'Reverted commit summary',
    },
    404: jsonError('Codebase or HEAD not found'),
    500: jsonError('git reset failed'),
  },
});

export const publishRoute = createRoute({
  method: 'post',
  path: '/api/codebases/{id}/git-publish',
  tags: ['Codebases'],
  summary: 'Push the current branch to the configured remote',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            branch: z.string(),
            remote: z.string(),
            ref: z.string(),
          }),
        },
      },
      description: 'Published ref',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('git push failed (e.g. non-FF, no remote, auth)'),
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getCodebaseGitLog(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const codebase = await codebaseDb.getCodebase(id);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }
  try {
    const log = await getRecentLog(codebase.default_cwd as Parameters<typeof getRecentLog>[0]);
    return c.json(log);
  } catch (err) {
    return apiError(c, 500, 'Git log failed', (err as Error).message);
  }
}

export async function postCodebaseGitRevert(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const codebase = await codebaseDb.getCodebase(id);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }
  try {
    const reverted = await revertLastCommitImpl(
      codebase.default_cwd as Parameters<typeof revertLastCommitImpl>[0]
    );
    if (!reverted) {
      return apiError(c, 404, 'No commit to revert');
    }
    return c.json({ reverted });
  } catch (err) {
    return apiError(c, 500, 'git reset failed', (err as Error).message);
  }
}

export async function postCodebaseGitPublish(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const codebase = await codebaseDb.getCodebase(id);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }
  try {
    const result = await publishBranchImpl(
      codebase.default_cwd as Parameters<typeof publishBranchImpl>[0]
    );
    return c.json(result);
  } catch (err) {
    return apiError(c, 500, 'git push failed', (err as Error).message);
  }
}

export const gitTurboRoutes = [getLogRoute, revertRoute, publishRoute] as const;
