/**
 * Zod schemas for the Memory system (path B — Memory + RAG).
 *
 * Three layers, one file:
 *   1. memorySchema — the row shape (mirrors the SQL CHECK constraints in
 *      `migrations/025_memory.sql`).
 *   2. Recall request / response — what the orchestrator needs to fetch
 *      relevant memories for a chat turn.
 *   3. List / search query shapes — for the CLI and the future Web UI.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Enums (mirror the SQL CHECK constraints in 025_memory.sql)
// ---------------------------------------------------------------------------

export const memoryScopeSchema = z
  .enum(['user', 'agent', 'project', 'conversation'])
  .openapi('MemoryScope');

export const memoryKindSchema = z
  .enum(['preference', 'fact', 'project_context', 'feedback', 'note'])
  .openapi('MemoryKind');

export const memorySourceSchema = z.enum(['chat', 'manual', 'imported']).openapi('MemorySource');

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export const memorySchema = z
  .object({
    id: z.string(),
    scope: memoryScopeSchema,
    scope_id: z.string().nullable(),
    kind: memoryKindSchema,
    content: z.string().min(1),
    source: memorySourceSchema,
    confidence: z.number().min(0).max(1),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    use_count: z.number().int().min(0),
  })
  .openapi('Memory');

// ---------------------------------------------------------------------------
// Insert / query / search shapes
// ---------------------------------------------------------------------------

export const memoryInsertSchema = z
  .object({
    scope: memoryScopeSchema,
    scopeId: z.string().nullable().optional(),
    kind: memoryKindSchema,
    content: z.string().min(1),
    source: memorySourceSchema.default('manual'),
    confidence: z.number().min(0).max(1).default(1.0),
  })
  .openapi('MemoryInsert');

export const recallMemoryRequestSchema = z
  .object({
    query: z.string().min(1),
    scopes: z
      .array(
        z.object({
          scope: memoryScopeSchema,
          scopeId: z.string().nullable().optional(),
        })
      )
      .min(1),
    kind: memoryKindSchema.optional(),
    limit: z.number().int().min(1).max(50).default(5),
  })
  .openapi('RecallMemoryRequest');

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
// Inferred types — single source of truth for the row / request shapes.
// Mirrors the `z.infer<typeof …Schema>` rule from the project AGENTS.md.
// ---------------------------------------------------------------------------

export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemorySource = z.infer<typeof memorySourceSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type MemoryInsert = z.infer<typeof memoryInsertSchema>;
export type RecallMemoryRequest = z.infer<typeof recallMemoryRequestSchema>;
export type ListMemoriesQuery = z.infer<typeof listMemoriesQuerySchema>;
