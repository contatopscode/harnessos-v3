/**
 * Zod schemas for the Memory HTTP API.
 *
 * Three concerns, one file:
 *   1. Wire-shape memories (the memory row)
 *   2. Wire-shape recall (FTS5 hits with confidence)
 *   3. Request / response shapes for the 4 endpoints
 *
 * Mirrors `packages/core/src/schemas/memory.ts` (the row shape) but adapted
 * for HTTP — timestamps stay as ISO strings (no Date serialization needed).
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Scope / kind / source enums — match the DB CHECK constraints.
// ---------------------------------------------------------------------------

export const memoryScopeSchema = z
  .enum(['user', 'agent', 'project', 'conversation'])
  .openapi('MemoryScope');

export const memoryKindSchema = z
  .enum(['note', 'preference', 'fact', 'project_context', 'feedback'])
  .openapi('MemoryKind');

export const memorySourceSchema = z.enum(['chat', 'manual', 'imported']).openapi('MemorySource');

// ---------------------------------------------------------------------------
// Wire-shape memory
// ---------------------------------------------------------------------------

export const memorySchema = z
  .object({
    id: z.string(),
    scope: memoryScopeSchema,
    scope_id: z.string().nullable(),
    kind: memoryKindSchema,
    content: z.string(),
    source: memorySourceSchema,
    confidence: z.number().min(0).max(1),
    use_count: z.number().int().min(0),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .openapi('Memory');

export const listMemoriesResponseSchema = z
  .object({
    total: z.number().int().min(0),
    memories: z.array(memorySchema),
  })
  .openapi('ListMemoriesResponse');

export const addMemoryResponseSchema = z
  .object({
    ok: z.boolean(),
    memory: memorySchema,
  })
  .openapi('AddMemoryResponse');

export const forgetMemoryResponseSchema = z
  .object({
    ok: z.boolean(),
    id: z.string(),
    removed: z.boolean(),
  })
  .openapi('ForgetMemoryResponse');

// ---------------------------------------------------------------------------
// Recall (FTS5 search)
// ---------------------------------------------------------------------------

/** One hit in a recall response — same shape as Memory plus a 0-1 confidence. */
export const memoryRecallHitSchema = z
  .object({
    id: z.string(),
    scope: memoryScopeSchema,
    scope_id: z.string().nullable(),
    kind: memoryKindSchema,
    content: z.string(),
    source: memorySourceSchema,
    confidence: z.number().min(0).max(1),
    use_count: z.number().int().min(0),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    /** Rank-derived confidence (top hit = 1.0, no-signal ≈ 0). */
    rank_confidence: z.number().min(0).max(1),
  })
  .openapi('MemoryRecallHit');

export const recallMemoriesResponseSchema = z
  .object({
    query: z.string(),
    total: z.number().int().min(0),
    hits: z.array(memoryRecallHitSchema),
  })
  .openapi('RecallMemoriesResponse');

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** Request body for POST /api/memories — manually add a memory. */
export const addMemoryBodySchema = z
  .object({
    content: z.string().min(1),
    scope: memoryScopeSchema.default('user'),
    scope_id: z.string().nullable().optional(),
    kind: memoryKindSchema.default('note'),
    source: memorySourceSchema.default('manual'),
  })
  .strict()
  .openapi('AddMemoryBody');

/** Request body for POST /api/memories/recall — FTS5 search. */
export const recallMemoriesBodySchema = z
  .object({
    query: z.string().min(1),
    /** Comma-separated scope names; defaults to all four scopes. */
    scopes: z.array(memoryScopeSchema).min(1).max(4).optional(),
    kind: memoryKindSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict()
  .openapi('RecallMemoriesBody');

// ---------------------------------------------------------------------------
// Query params (list endpoint)
// ---------------------------------------------------------------------------

export const listMemoriesQuerySchema = z
  .object({
    scope: memoryScopeSchema.optional(),
    kind: memoryKindSchema.optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('ListMemoriesQuery');

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const memoryIdParamsSchema = z
  .object({
    id: z.string().min(1),
  })
  .openapi('MemoryIdParams');
