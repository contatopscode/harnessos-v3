/**
 * VOLUND FORGE — PMO surface schemas.
 *
 * Five entity types back the Project Management Office surface that
 * ships as a separate frontend (`apps/forge/`) consuming the
 * HarnessOS backend:
 *
 *   Client     — top-level entity (a customer / org)
 *   Demand     — kanban card, the central work unit
 *   Sprint     — time-boxed commitment window per client
 *   OS         — Ordem de Serviço, a sub-task within a demand
 *   Cost       — LLM usage ledger, one row per model call
 *
 * All Zod schemas use `z.infer<typeof X>` for the derived TypeScript
 * type. Import `z` from `@hono/zod-openapi` (project convention) so
 * the OpenAPI generator can pick them up.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const clientStatusSchema = z.enum(['active', 'inactive', 'archived']);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const clientRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: clientStatusSchema,
  contact_email: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Client = z.infer<typeof clientRowSchema>;

export const createClientBodySchema = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, 'slug must be lowercase alphanum / dash / underscore'),
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    contact_email: z.string().email().optional(),
  })
  .openapi('CreateClientBody');

export const updateClientBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    contact_email: z.string().email().nullable().optional(),
    status: clientStatusSchema.optional(),
  })
  .openapi('UpdateClientBody');

// ---------------------------------------------------------------------------
// Demand (kanban card)
// ---------------------------------------------------------------------------

export const demandStatusSchema = z.enum([
  'backlog',
  'triagem',
  'requisitos',
  'aprovacao_cliente',
  'em_andamento',
  'concluido',
  'cancelado',
]);
export type DemandStatus = z.infer<typeof demandStatusSchema>;

export const demandPrioritySchema = z.enum(['baixa', 'media', 'alta', 'urgente']);
export type DemandPriority = z.infer<typeof demandPrioritySchema>;

export const demandRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  client_id: z.string(),
  codebase_id: z.string().nullable(),
  status: demandStatusSchema,
  priority: demandPrioritySchema,
  metadata: z.record(z.string(), z.unknown()),
  due_date: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Demand = z.infer<typeof demandRowSchema>;

export const createDemandBodySchema = z
  .object({
    slug: z
      .string()
      .min(3)
      .max(96)
      .regex(
        /^[A-Z0-9][A-Z0-9-]*$/,
        'slug must be uppercase alphanum / dash (e.g. PSCODE-EC-FSM-2026-013)'
      ),
    title: z.string().min(1).max(255),
    description: z.string().max(8000).optional(),
    client_id: z.string().uuid(),
    codebase_id: z.string().uuid().optional(),
    priority: demandPrioritySchema.optional(),
    due_date: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CreateDemandBody');

export const updateDemandBodySchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(8000).nullable().optional(),
    status: demandStatusSchema.optional(),
    priority: demandPrioritySchema.optional(),
    codebase_id: z.string().uuid().nullable().optional(),
    due_date: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('UpdateDemandBody');

/** Body of PATCH /api/forge/demands/:id/status — the kanban drag-and-drop. */
export const updateDemandStatusBodySchema = z
  .object({
    status: demandStatusSchema,
  })
  .openapi('UpdateDemandStatusBody');

// ---------------------------------------------------------------------------
// Sprint
// ---------------------------------------------------------------------------

export const sprintStatusSchema = z.enum(['planejado', 'em_andamento', 'concluido', 'cancelado']);
export type SprintStatus = z.infer<typeof sprintStatusSchema>;

export const sprintRowSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  status: sprintStatusSchema,
  goal: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Sprint = z.infer<typeof sprintRowSchema>;

export const createSprintBodySchema = z
  .object({
    client_id: z.string().uuid(),
    name: z.string().min(1).max(128),
    start_date: z.string(),
    end_date: z.string(),
    status: sprintStatusSchema.optional(),
    goal: z.string().max(2000).optional(),
  })
  .refine(v => new Date(v.end_date) >= new Date(v.start_date), {
    message: 'end_date must be on or after start_date',
    path: ['end_date'],
  })
  .openapi('CreateSprintBody');

// ---------------------------------------------------------------------------
// OS (Ordem de Serviço)
// ---------------------------------------------------------------------------

export const osStatusSchema = z.enum([
  'pendente',
  'em_andamento',
  'concluida',
  'cancelada',
  'bloqueada',
]);
export type OsStatus = z.infer<typeof osStatusSchema>;

export const osRowSchema = z.object({
  id: z.string(),
  demand_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: osStatusSchema,
  priority: demandPrioritySchema,
  assignee_user_id: z.string().nullable(),
  estimated_hours: z.number().nullable(),
  actual_hours: z.number().nullable(),
  due_date: z.string().nullable(),
  completed_at: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Os = z.infer<typeof osRowSchema>;

export const createOsBodySchema = z
  .object({
    demand_id: z.string().uuid(),
    title: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    status: osStatusSchema.optional(),
    priority: demandPrioritySchema.optional(),
    assignee_user_id: z.string().uuid().optional(),
    estimated_hours: z.number().optional(),
    due_date: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CreateOsBody');

export const updateOsBodySchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(4000).nullable().optional(),
    status: osStatusSchema.optional(),
    priority: demandPrioritySchema.optional(),
    assignee_user_id: z.string().uuid().nullable().optional(),
    estimated_hours: z.number().nullable().optional(),
    actual_hours: z.number().nullable().optional(),
    due_date: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('UpdateOsBody');

// ---------------------------------------------------------------------------
// Cost (LLM usage ledger)
// ---------------------------------------------------------------------------

export const costKindSchema = z.enum(['chat', 'completion', 'embedding', 'tool', 'image']);
export type CostKind = z.infer<typeof costKindSchema>;

export const costRowSchema = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  demand_id: z.string().nullable(),
  codebase_id: z.string().nullable(),
  model: z.string(),
  provider: z.string(),
  kind: costKindSchema,
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  amount_usd: z.number(),
  usd_brl_rate: z.number(),
  amount_brl: z.number(),
  created_at: z.string(),
});
export type Cost = z.infer<typeof costRowSchema>;

/** Body of POST /api/forge/costs — called by the orchestrator / chat loop. */
export const recordCostBodySchema = z
  .object({
    run_id: z.string().uuid().optional(),
    demand_id: z.string().uuid().optional(),
    codebase_id: z.string().uuid().optional(),
    model: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
    kind: costKindSchema.optional(),
    tokens_in: z.number().int().min(0),
    tokens_out: z.number().int().min(0),
    amount_usd: z.number().min(0),
    usd_brl_rate: z.number().min(0).optional(),
  })
  .openapi('RecordCostBody');

// ---------------------------------------------------------------------------
// Aggregated views for the dashboard
// ---------------------------------------------------------------------------

/** GET /api/forge/costs/summary — KPIs for the dashboard header. */
export const costSummarySchema = z.object({
  total_usd: z.number(),
  total_brl: z.number(),
  runs_count: z.number().int(),
  cost_rows_count: z.number().int(),
  tokens_in_total: z.number().int(),
  tokens_out_total: z.number().int(),
  window_days: z.number().int(),
});
export type CostSummary = z.infer<typeof costSummarySchema>;

/** GET /api/forge/costs/breakdown — per-model / per-project / per-pipeline rollup. */
export const costBreakdownEntrySchema = z.object({
  key: z.string(),
  amount_usd: z.number(),
  amount_brl: z.number(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_rows_count: z.number().int(),
});
export const costBreakdownSchema = z.object({
  by_model: z.array(costBreakdownEntrySchema),
  by_codebase: z.array(costBreakdownEntrySchema),
  by_pipeline: z.array(costBreakdownEntrySchema),
  window_days: z.number().int(),
});
export type CostBreakdown = z.infer<typeof costBreakdownSchema>;

/**
 * GET /api/forge/projects — extended codebase view with demand +
 * run counts. Surfaces the same data as /api/codebases but enriched
 * with the PMO surface (so the FORGE app can use a single endpoint).
 */
export const projectSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  client_id: z.string().nullable(),
  client_name: z.string().nullable(),
  status: z.string(),
  default_branch: z.string().nullable(),
  open_demands: z.number().int(),
  total_demands: z.number().int(),
  runs_count: z.number().int(),
  repository_url: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** GET /api/forge/demands/board — kanban payload, grouped by status column. */
export const demandBoardColumnSchema = z.object({
  status: demandStatusSchema,
  demands: z.array(demandRowSchema),
});
export const demandBoardSchema = z.object({
  columns: z.array(demandBoardColumnSchema),
  total: z.number().int(),
});
export type DemandBoard = z.infer<typeof demandBoardSchema>;
