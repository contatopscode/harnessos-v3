/**
 * Per-conversation sandbox selection endpoints.
 *
 *   GET    /api/conversations/{id}/sandbox   — current sandbox state for the chat
 *   POST   /api/conversations/{id}/sandbox   — set conversation.cwd to a sandbox worktree
 *   DELETE /api/conversations/{id}/sandbox   — leave the sandbox (cwd -> NULL)
 *
 * The chat is "in sandbox mode" iff conversations.cwd points at the
 * working_path of an active isolation_environments row with
 * workflow_type='sandbox'. The orchestrator (orchestrator-agent.ts)
 * auto-detects this on every turn via findActiveSandboxByCwd and
 * injects a Sandbox Mode section into the system prompt. These
 * endpoints are the EXPLICIT counterpart — the user picks the
 * sandbox from the chat composer instead of the orchestrator
 * guessing.
 *
 * Why a separate file from api.sandboxes.ts: that file is the
 * CRUD surface for the sandbox resource itself (create / list /
 * diff / merge / discard). This file is per-conversation state
 * and shares the same DB column (`conversations.cwd`) as
 * /worktree, /update-project, and the existing isolation
 * resolver paths.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { apiError } from './api-error';
import { findConversationByPlatformId, updateConversation } from '@archon/core/db/conversations';
import { getById as getSandboxById } from '@archon/core/db/isolation-environments';
import { findActiveSandboxByCwd } from '@archon/core/db/sandbox';

function jsonError(description: string): {
  content: { 'application/json': { schema: z.ZodObject<{ error: z.ZodString }> } };
  description: string;
} {
  return {
    content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    description,
  };
}

/** A trimmed version of the sandbox row, suitable for the chat composer UI. */
const sandboxSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  createdAt: z.string(),
});

export const getConversationSandboxRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/sandbox',
  tags: ['Sandboxes'],
  summary: 'Get the active sandbox (if any) for a conversation',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            active: z.boolean(),
            sandbox: sandboxSummarySchema.nullable(),
          }),
        },
      },
      description: 'Current sandbox state (null when the chat is on main)',
    },
    404: jsonError('Conversation not found'),
  },
});

export const setConversationSandboxRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/sandbox',
  tags: ['Sandboxes'],
  summary: 'Pin the conversation to a sandbox worktree',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            sandboxId: z.string().min(1),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: sandboxSummarySchema } },
      description: 'Conversation now pinned to this sandbox',
    },
    404: jsonError('Conversation or sandbox not found'),
    409: jsonError('Sandbox is not active (already merged or discarded)'),
  },
});

export const clearConversationSandboxRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}/sandbox',
  tags: ['Sandboxes'],
  summary: 'Leave the sandbox — reset conversation.cwd to NULL',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ cleared: z.boolean() }) } },
      description: 'Conversation left the sandbox',
    },
    404: jsonError('Conversation not found'),
  },
});

/**
 * Read the current sandbox for a conversation. Returns the sandbox
 * summary when conversations.cwd matches an active sandbox row,
 * `active: false` otherwise. Used by the chat composer to show
 * the "in sandbox X" badge before the user types a message.
 */
export async function getConversationSandbox(c: Context): Promise<Response> {
  const platformId = c.req.param('id') ?? '';
  const conv = await findConversationByPlatformId(platformId);
  if (!conv) return apiError(c, 404, 'Conversation not found');
  if (!conv.cwd) return c.json({ active: false, sandbox: null });
  if (!conv.codebase_id) return c.json({ active: false, sandbox: null });
  const sandbox = await findActiveSandboxByCwd(conv.codebase_id, conv.cwd);
  if (!sandbox) return c.json({ active: false, sandbox: null });
  return c.json({
    active: true,
    sandbox: {
      id: sandbox.id,
      slug: sandbox.workflow_id,
      branch: `sandbox/${sandbox.workflow_id}`,
      worktreePath: sandbox.working_path,
      createdAt:
        sandbox.created_at instanceof Date
          ? sandbox.created_at.toISOString()
          : String(sandbox.created_at),
    },
  });
}

/**
 * Pin a conversation to a sandbox by setting conversations.cwd to
 * the sandbox's working_path. Validates that the sandbox is still
 * active (the user can race a merge/discard from another tab) and
 * that the conversation actually belongs to the sandbox's codebase
 * — a FaceGate conversation cannot be pinned to a Harness-v1
 * sandbox, that would silently let the agent act on the wrong repo.
 */
export async function setConversationSandbox(c: Context): Promise<Response> {
  const platformId = c.req.param('id') ?? '';
  const conv = await findConversationByPlatformId(platformId);
  if (!conv) return apiError(c, 404, 'Conversation not found');
  const body = (await c.req.json().catch(() => null)) as { sandboxId?: string } | null;
  const sandboxId = body?.sandboxId?.trim();
  if (!sandboxId) return apiError(c, 400, 'sandboxId is required');

  const sandbox = await getSandboxById(sandboxId);
  if (sandbox?.workflow_type !== 'sandbox') {
    return apiError(c, 404, 'Sandbox not found');
  }
  if (sandbox.status !== 'active') {
    return apiError(c, 409, 'Sandbox is not active (already merged or discarded)');
  }
  if (sandbox.codebase_id !== conv.codebase_id) {
    return apiError(c, 409, 'Sandbox belongs to a different codebase than the conversation');
  }

  await updateConversation(conv.id, { cwd: sandbox.working_path });
  return c.json({
    id: sandbox.id,
    slug: sandbox.workflow_id,
    branch: `sandbox/${sandbox.workflow_id}`,
    worktreePath: sandbox.working_path,
    createdAt:
      sandbox.created_at instanceof Date
        ? sandbox.created_at.toISOString()
        : String(sandbox.created_at),
  });
}

/**
 * Reset conversations.cwd to NULL. The next chat turn falls back
 * to the canonical repo. No-op (idempotent) when the conversation
 * is already off-sandbox — the UI calls this from the "Exit
 * sandbox" button, which may be hit repeatedly.
 */
export async function clearConversationSandbox(c: Context): Promise<Response> {
  const platformId = c.req.param('id') ?? '';
  const conv = await findConversationByPlatformId(platformId);
  if (!conv) return apiError(c, 404, 'Conversation not found');
  if (conv.cwd !== null) {
    await updateConversation(conv.id, { cwd: null });
  }
  return c.json({ cleared: true });
}

export const conversationSandboxRoutes = [
  getConversationSandboxRoute,
  setConversationSandboxRoute,
  clearConversationSandboxRoute,
] as const;
