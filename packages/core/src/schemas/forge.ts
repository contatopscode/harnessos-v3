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
  'bloqueada', // auto-set when a workflow run fails
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
  // Audit-trail "last activity" summary — populated by triggers/hooks so
  // the kanban can show "last touched" without joining activities table.
  last_activity_at: z.string().nullable(),
  last_run_id: z.string().nullable(),
  last_run_status: z.string().nullable(),
  runs_count: z.number().int(),
  messages_count: z.number().int(),
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

// ---------------------------------------------------------------------------
// Demand activity — audit trail row
// ---------------------------------------------------------------------------

/**
 * An activity is any auditable event that touches a demand: a status
 * change, a workflow run starting/completing/failing, a chat message
 * linked to the demand, or a manual note from a human.
 *
 * Single source of truth for "what happened to this demand and when".
 * The kanban UI renders the timeline of activities inside the demand
 * detail modal; the Custos page shows activities tagged 'message' and
 * 'run_completed' alongside the cost rows.
 */
export const demandActivityActionSchema = z.enum([
  'created', // demand was just created
  'status_change', // explicit status transition (manual or auto)
  'priority_change', // priority was changed
  'run_started', // a workflow run linked to this demand started
  'run_completed', // a workflow run linked to this demand succeeded
  'run_failed', // a workflow run linked to this demand failed
  'message', // a chat message (FORGE) linked to this demand
  'note', // a human added a note
]);
export type DemandActivityAction = z.infer<typeof demandActivityActionSchema>;

export const demandActivityRowSchema = z.object({
  id: z.string(),
  demand_id: z.string(),
  action: demandActivityActionSchema,
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  from_priority: z.string().nullable(),
  to_priority: z.string().nullable(),
  run_id: z.string().nullable(),
  message_id: z.string().nullable(),
  user_id: z.string().nullable(),
  note: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type DemandActivity = z.infer<typeof demandActivityRowSchema>;

/** Body of POST /api/forge/demands/:id/activities — manual activity log. */
export const createDemandActivityBodySchema = z
  .object({
    action: z.enum(['note', 'status_change', 'priority_change']).default('note'),
    note: z.string().min(1).max(8000),
    to_status: demandStatusSchema.optional(),
    to_priority: demandPrioritySchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CreateDemandActivityBody');

/**
 * Aggregated demand timeline — what's been happening to a demand.
 * Combines:
 *   - activities (status changes, run start/end, messages, notes)
 *   - workflow runs (just the latest ones; full list in another endpoint)
 *   - cost rows (LLM calls attributed to this demand)
 *   - chat messages (FORGE messages that mention/link this demand)
 */
export const demandTimelineEntrySchema = z.object({
  // One of 'activity' | 'run' | 'cost' | 'message' — discriminated union
  kind: z.enum(['activity', 'run', 'cost', 'message']),
  at: z.string(), // ISO timestamp (created_at or run start)
  title: z.string(),
  detail: z.string().nullable(),
  // The full underlying row (matched to the kind)
  activity: demandActivityRowSchema.optional(),
  // The run id (if kind=run)
  run_id: z.string().optional(),
  run_status: z.string().optional(),
  run_workflow_name: z.string().optional(),
  // The cost (if kind=cost)
  cost_id: z.string().optional(),
  cost_model: z.string().optional(),
  cost_tokens_in: z.number().int().optional(),
  cost_tokens_out: z.number().int().optional(),
  cost_amount_usd: z.number().optional(),
  cost_amount_brl: z.number().optional(),
  // The message (if kind=message)
  message_id: z.string().optional(),
  message_role: z.string().optional(),
  message_preview: z.string().optional(),
});
export type DemandTimelineEntry = z.infer<typeof demandTimelineEntrySchema>;

export const demandTimelineResponseSchema = z.object({
  demand: demandRowSchema,
  entries: z.array(demandTimelineEntrySchema),
  totals: z.object({
    activities: z.number().int(),
    runs: z.number().int(),
    cost_calls: z.number().int(),
    cost_total_usd: z.number(),
    cost_total_brl: z.number(),
    messages: z.number().int(),
  }),
});
export type DemandTimelineResponse = z.infer<typeof demandTimelineResponseSchema>;
