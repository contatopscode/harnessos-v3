/**
 * Zod schemas for the Agent HTTP API.
 *
 * Three concerns, one file:
 *   1. Wire-shape agents (the agent row + parsed JSON-as-TEXT fields)
 *   2. Wire-shape agent_runs (audit row)
 *   3. Request / response shapes for the 5 endpoints
 *
 * Mirrors `packages/core/src/schemas/agent.ts` (the row shape) but adapted
 * for HTTP — the JSON-as-TEXT columns are parsed into arrays so the React UI
 * doesn't have to know about the storage encoding.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Source / decision enums — match the DB CHECK constraints.
// ---------------------------------------------------------------------------

export const agentSourceSchema = z.enum(['bundled', 'local', 'installed']).openapi('AgentSource');
export const routingDecisionSchema = z
  .enum(['override', 'codebase_default', 'auto_heuristic', 'auto_llm', 'default_fallback'])
  .openapi('RoutingDecision');

// ---------------------------------------------------------------------------
// Wire-shape agent (parsed JSON columns → string[])
// ---------------------------------------------------------------------------

export const agentSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    source: agentSourceSchema,
    version: z.string(),
    description: z.string(),
    system_prompt: z.string(),
    tags: z.array(z.string()),
    keywords: z.array(z.string()),
    examples: z.array(z.string()),
    allowed_tools: z.array(z.string()),
    model: z.string().nullable(),
    memory_ref: z.string().nullable(),
    author: z.string().nullable(),
    installed_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Agent');

export const agentCountsSchema = z
  .object({
    all: z.number().int().min(0),
    bundled: z.number().int().min(0),
    local: z.number().int().min(0),
    installed: z.number().int().min(0),
  })
  .openapi('AgentCounts');

export const listAgentsResponseSchema = z
  .object({
    total: z.number().int().min(0),
    counts: agentCountsSchema,
    agents: z.array(agentSchema),
  })
  .openapi('ListAgentsResponse');

export const getAgentResponseSchema = z
  .object({
    agent: agentSchema,
  })
  .openapi('GetAgentResponse');

// ---------------------------------------------------------------------------
// Wire-shape agent_runs (parsed JSON column → none needed; just strings)
// ---------------------------------------------------------------------------

export const agentRunSchema = z
  .object({
    id: z.string(),
    agent_slug: z.string(),
    conversation_id: z.string().nullable(),
    message_id: z.string().nullable(),
    decision: routingDecisionSchema,
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    latency_ms: z.number().int().min(0),
    user_message_preview: z.string(),
    created_at: z.string(),
  })
  .openapi('AgentRun');

export const listAgentRunsResponseSchema = z
  .object({
    total: z.number().int().min(0),
    runs: z.array(agentRunSchema),
  })
  .openapi('ListAgentRunsResponse');

// ---------------------------------------------------------------------------
// Install / uninstall / route requests
// ---------------------------------------------------------------------------

/** Request body for POST /api/agents/install — path to a YAML file. */
export const installAgentBodySchema = z
  .object({
    path: z.string().min(1),
  })
  .strict()
  .openapi('InstallAgentBody');

/** Response for POST /api/agents/install. */
export const installAgentResponseSchema = z
  .object({
    ok: z.boolean(),
    slug: z.string(),
    source: agentSourceSchema,
    version: z.string(),
    installed_at: z.string(),
  })
  .openapi('InstallAgentResponse');

/** Response for DELETE /api/agents/:slug. */
export const uninstallAgentResponseSchema = z
  .object({
    ok: z.boolean(),
    slug: z.string(),
    removed: z.boolean(),
  })
  .openapi('UninstallAgentResponse');

/** Request body for POST /api/agents/route — simulate routing a message. */
export const routeAgentBodySchema = z
  .object({
    message: z.string().min(1),
    codebase: z.string().nullable().optional(),
  })
  .strict()
  .openapi('RouteAgentBody');

/** Response for POST /api/agents/route. */
export const routeAgentResponseSchema = z
  .object({
    message: z.string(),
    routed_to: z.string(),
    decision: routingDecisionSchema,
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    latency_ms: z.number().int().min(0),
  })
  .openapi('RouteAgentResponse');

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export const listAgentsQuerySchema = z
  .object({
    source: agentSourceSchema.optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('ListAgentsQuery');

export const listAgentRunsQuerySchema = z
  .object({
    slug: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('ListAgentRunsQuery');

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const agentSlugParamsSchema = z
  .object({
    slug: z.string().min(1).max(64),
  })
  .openapi('AgentSlugParams');
