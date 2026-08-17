/**
 * Sandbox REST endpoints — the user-facing surface of "Sandbox Mode".
 *
 *   POST   /api/codebases/{id}/sandboxes        — create sandbox (branch + worktree)
 *   GET    /api/codebases/{id}/sandboxes        — list active sandboxes
 *   GET    /api/sandboxes/{id}                 — get one sandbox
 *   GET    /api/sandboxes/{id}/diff            — diff vs base branch (stat + preview)
 *   POST   /api/sandboxes/{id}/merge           — merge into base, remove worktree
 *   POST   /api/sandboxes/{id}/discard         — remove worktree, delete branch
 *
 * The sandbox metadata is stored in `remote_agent_isolation_environments`
 * (workflow_type='sandbox', workflow_id=<slug>). The git worktree itself
 * is the source of truth for "is this sandbox still on disk?" — the
 * `status` column tracks logical state, but a crashed orchestrator can
 * leave a sandbox in 'active' while the worktree is gone. The UI
 * handles this by re-checking via `listWorktrees()` on render.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  createSandbox as createSandboxImpl,
  DEFAULT_SANDBOX_BASE,
  diffSandbox as diffSandboxImpl,
  discardSandbox as discardSandboxImpl,
  getWorktreeBase,
  mergeSandbox as mergeSandboxImpl,
  toBranchName,
  type SandboxDiffResult,
} from '@archon/git';
/** Structural type for the isolation_environments row. Avoids pulling
 *  @archon/isolation as a server dep — the real type lives there. */
interface SandboxRow {
  id: string;
  codebase_id: string;
  workflow_type: string;
  workflow_id: string;
  provider: string;
  working_path: string;
  branch_name: string | null;
  created_at: Date | string;
  status: string;
}
import * as codebaseDb from '@archon/core/db/codebases';
import * as isoDb from '@archon/core/db/isolation-environments';
import { apiError } from './api-error';
import { codebaseIdParamsSchema } from './schemas/codebase.schemas';

// ---------------------------------------------------------------------------
// Route configs (OpenAPI)
// ---------------------------------------------------------------------------

/** Local helper to keep the error-response shape consistent across endpoints. */
function errorJsonSchema(): z.ZodObject<{ error: z.ZodString }> {
  return z.object({ error: z.string() });
}

function jsonError(description: string): {
  content: { 'application/json': { schema: ReturnType<typeof errorJsonSchema> } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorJsonSchema() } }, description };
}

const createSandboxBody = z
  .object({
    /** Short URL-safe slug, used for the branch name. Generated server-side if absent. */
    slug: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, 'slug must be lowercase alphanum / dash / underscore')
      .optional(),
    baseBranch: z.string().min(1).optional(),
  })
  .openapi('CreateSandboxBody');

export const createSandboxRoute = createRoute({
  method: 'post',
  path: '/api/codebases/{id}/sandboxes',
  tags: ['Sandboxes'],
  summary: 'Create a new sandbox (branch + worktree) for a codebase',
  request: {
    params: codebaseIdParamsSchema,
    body: { content: { 'application/json': { schema: createSandboxBody } }, required: true },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            branch: z.string(),
            worktreePath: z.string(),
          }),
        },
      },
      description: 'Sandbox created',
    },
    404: jsonError('Codebase not found'),
    409: jsonError('Branch or worktree already exists'),
    500: jsonError('git worktree add failed'),
  },
});

export const listSandboxesRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/sandboxes',
  tags: ['Sandboxes'],
  summary: 'List active sandboxes for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            sandboxes: z.array(
              z.object({
                id: z.string(),
                slug: z.string(),
                branch: z.string(),
                worktreePath: z.string(),
                createdAt: z.string(),
              })
            ),
          }),
        },
      },
      description: 'Active sandboxes',
    },
    404: jsonError('Codebase not found'),
  },
});

export const getSandboxRoute = createRoute({
  method: 'get',
  path: '/api/sandboxes/{id}',
  tags: ['Sandboxes'],
  summary: 'Get one sandbox by id',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            slug: z.string(),
            branch: z.string(),
            worktreePath: z.string(),
            createdAt: z.string(),
            status: z.string(),
          }),
        },
      },
      description: 'Sandbox details',
    },
    404: jsonError('Sandbox not found'),
  },
});

export const diffSandboxRoute = createRoute({
  method: 'get',
  path: '/api/sandboxes/{id}/diff',
  tags: ['Sandboxes'],
  summary: 'Diff a sandbox vs its base branch',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: z.custom<SandboxDiffResult>() } },
      description: 'Diff stat + preview + ahead/behind counts',
    },
    404: jsonError('Sandbox not found'),
    500: jsonError('git diff failed'),
  },
});

export const mergeSandboxRoute = createRoute({
  method: 'post',
  path: '/api/sandboxes/{id}/merge',
  tags: ['Sandboxes'],
  summary: 'Merge a sandbox into the base branch and remove the worktree',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            merged: z.boolean(),
            fastForward: z.boolean(),
          }),
        },
      },
      description: 'Merged',
    },
    404: jsonError('Sandbox not found'),
    409: jsonError('Merge conflict — rebase the sandbox manually'),
    500: jsonError('git merge failed'),
  },
});

export const discardSandboxRoute = createRoute({
  method: 'post',
  path: '/api/sandboxes/{id}/discard',
  tags: ['Sandboxes'],
  summary: 'Discard a sandbox (remove worktree + branch without merging)',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.object({ discarded: z.boolean() }) },
      },
      description: 'Discarded',
    },
    404: jsonError('Sandbox not found'),
    500: jsonError('git worktree remove failed'),
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function defaultSlug(): string {
  // e.g. "2026-08-17-1530" — sortable, fits in 40 chars, URL-safe.
  return new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 16);
}

type LoadSandboxResult = { ok: true; row: SandboxRow } | { ok: false; error: Response };

async function loadSandboxOr404(c: Context): Promise<LoadSandboxResult> {
  const id = c.req.param('id') ?? '';
  const row = await isoDb.getById(id);
  if (!row) {
    return { ok: false, error: apiError(c, 404, 'Sandbox not found') };
  }
  if (row.workflow_type !== 'sandbox') {
    return { ok: false, error: apiError(c, 404, 'Sandbox not found') };
  }
  return { ok: true, row };
}

export async function postCreateSandbox(c: Context): Promise<Response> {
  const codebaseId = c.req.param('id') ?? '';
  const codebase = await codebaseDb.getCodebase(codebaseId);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    baseBranch?: string;
  };
  const slug = body.slug?.trim() || defaultSlug();
  const baseBranch = body.baseBranch?.trim() || DEFAULT_SANDBOX_BASE;

  const { base: worktreeParent } = getWorktreeBase(
    codebase.default_cwd as Parameters<typeof getWorktreeBase>[0],
    codebase.name
  );

  let created: { branch: string; worktreePath: string };
  try {
    created = await createSandboxImpl(
      codebase.default_cwd as Parameters<typeof createSandboxImpl>[0],
      worktreeParent,
      slug,
      baseBranch
    );
  } catch (err) {
    const message = (err as Error).message;
    // Common case: a stale worktree from a crashed previous run. Surface
    // a 409 so the UI can prompt the user to discard it first.
    if (message.includes('already exists') || message.includes('already used')) {
      return apiError(c, 409, 'Branch or worktree already exists', message);
    }
    return apiError(c, 500, 'git worktree add failed', message);
  }

  // Persist the metadata so list / get / diff endpoints can find it.
  const env = await isoDb.create({
    codebase_id: codebaseId,
    workflow_type: 'sandbox',
    workflow_id: slug,
    provider: 'worktree',
    working_path: created.worktreePath,
    branch_name: toBranchName(created.branch),
  });

  return c.json({ id: env.id, branch: created.branch, worktreePath: created.worktreePath }, 201);
}

export async function getListSandboxes(c: Context): Promise<Response> {
  const codebaseId = c.req.param('id') ?? '';
  const codebase = await codebaseDb.getCodebase(codebaseId);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }

  const envs = await isoDb.listByCodebase(codebaseId);
  const sandboxes = envs
    .filter(e => e.workflow_type === 'sandbox' && e.status === 'active')
    .map(e => ({
      id: e.id,
      slug: e.workflow_id,
      branch: `sandbox/${e.workflow_id}`,
      worktreePath: e.working_path,
      createdAt:
        e.created_at instanceof Date ? e.created_at.toISOString() : (e.created_at as string),
    }));

  return c.json({ sandboxes });
}

export async function getSandbox(c: Context): Promise<Response> {
  const result = await loadSandboxOr404(c);
  if (!result.ok) return result.error;
  const env = result.row;
  return c.json({
    id: env.id,
    slug: env.workflow_id,
    branch: `sandbox/${env.workflow_id}`,
    worktreePath: env.working_path,
    createdAt: env.created_at instanceof Date ? env.created_at.toISOString() : env.created_at,
    status: env.status,
  });
}

export async function getSandboxDiff(c: Context): Promise<Response> {
  const result = await loadSandboxOr404(c);
  if (!result.ok) return result.error;
  const env = result.row;
  const codebase = await codebaseDb.getCodebase(env.codebase_id);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }

  const branch = `sandbox/${env.workflow_id}`;
  try {
    const diff = await diffSandboxImpl(
      codebase.default_cwd as Parameters<typeof diffSandboxImpl>[0],
      branch
    );
    return c.json(diff);
  } catch (err) {
    return apiError(c, 500, 'git diff failed', (err as Error).message);
  }
}

export async function postMergeSandbox(c: Context): Promise<Response> {
  const result = await loadSandboxOr404(c);
  if (!result.ok) return result.error;
  const env = result.row;
  const codebase = await codebaseDb.getCodebase(env.codebase_id);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }

  const branch = `sandbox/${env.workflow_id}`;
  try {
    const mergeResult = await mergeSandboxImpl(
      codebase.default_cwd as Parameters<typeof mergeSandboxImpl>[0],
      env.working_path,
      branch
    );
    await isoDb.updateStatus(env.id, 'destroyed');
    return c.json(mergeResult);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('CONFLICT') || message.includes('not possible because')) {
      return apiError(c, 409, 'Merge conflict — rebase the sandbox manually', message);
    }
    return apiError(c, 500, 'git merge failed', message);
  }
}

export async function postDiscardSandbox(c: Context): Promise<Response> {
  const result = await loadSandboxOr404(c);
  if (!result.ok) return result.error;
  const env = result.row;
  const codebase = await codebaseDb.getCodebase(env.codebase_id);
  if (!codebase) {
    return apiError(c, 404, 'Codebase not found');
  }

  const branch = `sandbox/${env.workflow_id}`;
  try {
    const discardResult = await discardSandboxImpl(
      codebase.default_cwd as Parameters<typeof discardSandboxImpl>[0],
      env.working_path,
      branch
    );
    await isoDb.updateStatus(env.id, 'destroyed');
    return c.json(discardResult);
  } catch (err) {
    return apiError(c, 500, 'git worktree remove failed', (err as Error).message);
  }
}

export const sandboxRoutes = [
  createSandboxRoute,
  listSandboxesRoute,
  getSandboxRoute,
  diffSandboxRoute,
  mergeSandboxRoute,
  discardSandboxRoute,
] as const;
