/**
 * Zod schemas for codebase API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { codebaseRowSchema } from '@archon/core/schemas/codebase';

/** A codebase record (wire shape with ISO string dates). */
export const codebaseSchema = codebaseRowSchema
  .extend({
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('Codebase');

/** GET /api/codebases response. */
export const codebaseListResponseSchema = z.array(codebaseSchema).openapi('CodebaseListResponse');

/** Path params for routes with :id (codebase ID). */
export const codebaseIdParamsSchema = z.object({ id: z.string() });

/** POST /api/codebases request body. Exactly one of url or path must be provided. */
export const addCodebaseBodySchema = z
  .object({
    url: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .openapi('AddCodebaseBody');
// NOTE: object-level `.refine` was removed because `@hono/zod-openapi` cannot
// represent a ZodEffects wrapper in OpenAPI 3.0. The "exactly one of url/path"
// check is now enforced at the route handler in `api.ts` (it returns 400 with
// the same message) — see where `addCodebaseBodySchema` is consumed.

/** DELETE /api/codebases/:id response. */
export const deleteCodebaseResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteCodebaseResponse');

/** POST /api/codebases/mkdir request body. Creates the directory tree on disk. */
export const mkdirCodebaseBodySchema = z
  .object({
    path: z.string().min(1),
  })
  .strict()
  .openapi('MkdirCodebaseBody');

/** POST /api/codebases/mkdir response. */
export const mkdirCodebaseResponseSchema = z
  .object({
    ok: z.boolean(),
    path: z.string(),
  })
  .openapi('MkdirCodebaseResponse');

/** Response for GET /api/codebases/:id/env — returns only keys, never values */
export const codebaseEnvVarsResponseSchema = z
  .object({
    keys: z.array(z.string()),
  })
  .openapi('CodebaseEnvVarsResponse');

/** Body for PUT /api/codebases/:id/env — upsert one key-value pair */
export const setEnvVarBodySchema = z
  .object({
    key: z.string().min(1).max(255),
    value: z.string(),
  })
  .openapi('SetEnvVarBody');

/** Path params for routes with :id/:key */
export const codebaseEnvVarParamsSchema = z.object({
  id: z.string(),
  key: z.string(),
});

/** Response for PUT/DELETE /api/codebases/:id/env */
export const envVarMutationResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('EnvVarMutationResponse');

/** POST /api/codebases/:id/skills response — installs the bundled archon + manage-run skills. */
export const installSkillsResponseSchema = z
  .object({
    ok: z.boolean(),
    /** Absolute path of the project root the skills were written into. */
    targetPath: z.string(),
    /** The two roots the skills landed in (Claude Code + Codex). */
    skillsRoots: z.array(z.string()),
    /** File count written into each root (archon + manage-run). */
    fileCount: z.number().int().min(0),
  })
  .openapi('InstallSkillsResponse');
