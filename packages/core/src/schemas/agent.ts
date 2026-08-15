/**
 * Zod schemas for the Agent system.
 *
 * Three layers, one file:
 *  1. agentDefinitionSchema — source-of-truth YAML manifest (.archon/agents/*.yaml).
 *     Authored by humans, discovered by the loader, validated here.
 *  2. agentRowSchema — installed row in the `agents` DB table. The "installation"
 *     record pointing at the definition (either the YAML path for `local` or the
 *     inlined definition_yaml for `bundled`/`installed`).
 *  3. agentRunRowSchema — audit row in the `agent_runs` DB table. One per
 *     routing decision. The router always writes one of these so the user can
 *     later ask "why did this go to the bug-investigator?".
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Slug rule — kebab-case, lowercase, no leading/trailing dash, no consecutive
// dashes. Mirrors the convention used by workflow slugs so the same input
// field (`agent:`) works in both contexts.
// ---------------------------------------------------------------------------

export const agentSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: 'slug must be kebab-case (lowercase, digits, single dashes)',
  });

export type AgentSlug = z.infer<typeof agentSlugSchema>;

// ---------------------------------------------------------------------------
// AgentSource — origin of an installed agent row.
//   bundled  : shipped with the Archon app (e.g. code-reviewer, test-writer)
//   local    : loaded from a `.archon/agents/<slug>.yaml` in a registered codebase
//   installed: pulled from a remote registry (skills/agents marketplace, future)
// ---------------------------------------------------------------------------

export const agentSourceSchema = z.enum(['bundled', 'local', 'installed']);
export type AgentSource = z.infer<typeof agentSourceSchema>;

// ---------------------------------------------------------------------------
// RoutingDecision — how the router chose this agent for a given message.
//   override         : user wrote `agent:slug` at the start of the message
//   codebase_default : codebase .archon/config pinned a default agent
//   auto_heuristic   : keyword/description match (zero-token, fast path)
//   auto_llm         : M3-small classifier was used (ambiguous message)
//   default_fallback : nothing matched, fell back to general-assistant
// Every routing path — even failures — produces an agent_run row.
// ---------------------------------------------------------------------------

export const routingDecisionSchema = z.enum([
  'override',
  'codebase_default',
  'auto_heuristic',
  'auto_llm',
  'default_fallback',
]);
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

// ---------------------------------------------------------------------------
// AgentDefinition — the YAML manifest.
//
// Required: name, slug, description, systemPrompt. Everything else is optional
// with sensible defaults so authoring a new agent is a 10-line YAML.
//
// `systemPrompt` is the persona. It is *appended* to the base orchestrator
// system prompt (NOT replaced), so the agent inherits platform-level rules
// (manage_run, etc) and only overrides the persona/voice/approach.
//
// `tags` feed the heuristic router. Keep them short and distinctive so a
// keyword match in the user message picks the right agent.
//
// `keywords` are matched as substrings in the user message (case-insensitive).
// Used as the first-pass signal before any description/embedding similarity.
//
// `examples` are 3-5 literal user messages that this agent should handle. They
// are shown in the UI ("Examples: ...") and used by the LLM classifier as
// few-shot prompts when the heuristic is ambiguous.
//
// `allowedTools` is a list of native tool names (Read, Write, Edit, Bash, ...).
// Empty array = inherit all tools the underlying provider grants. Restrict to
// least-privilege: e.g. the code-reviewer shouldn't have Write by default.
//
// `model` overrides the user's `large` tier model when set. Format is
// `provider/model-name` (e.g. `pi/MiniMax-M3`).
//
// `memoryRef` is the namespace for this agent's memory layer. Format is
// `agent:<slug>` by convention. If omitted, the agent shares memory with the
// user's default namespace.
// ---------------------------------------------------------------------------

export const agentDefinitionSchema = z.object({
  name: z.string().min(1).max(64),
  slug: agentSlugSchema,
  description: z.string().min(20).max(500),
  systemPrompt: z.string().min(20),
  tags: z.array(z.string().min(1).max(32)).default([]),
  keywords: z.array(z.string().min(1).max(64)).default([]),
  examples: z.array(z.string().min(1).max(280)).default([]),
  allowedTools: z.array(z.string().min(1).max(64)).default([]),
  model: z
    .string()
    .regex(/^[a-z]+\/.+$/u)
    .optional(),
  memoryRef: z.string().min(1).max(128).optional(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.]+)?$/u, {
      message: 'version must be semver (e.g. 1.0.0 or 2.1.0-rc.1)',
    })
    .default('1.0.0'),
  author: z.string().min(1).max(128).optional(),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

// ---------------------------------------------------------------------------
// Agent — installed row in the `agents` table.
//
// Mirrors the `agents` table created by the agent migration. `definitionYaml`
// is the inlined YAML (so we can move the source file without breaking
// installed agents) for `bundled` and `installed`; for `local` it is the
// absolute path to the source file and `definition` is also cached for fast
// router access (no filesystem read on every routing decision).
// ---------------------------------------------------------------------------

export const agentRowSchema = z.object({
  id: z.string(),
  slug: agentSlugSchema,
  name: z.string(),
  source: agentSourceSchema,
  version: z.string(),
  description: z.string(),
  system_prompt: z.string(),
  tags_json: z.string(),
  keywords_json: z.string(),
  examples_json: z.string(),
  allowed_tools_json: z.string(),
  model: z.string().nullable(),
  memory_ref: z.string().nullable(),
  author: z.string().nullable(),
  definition_yaml: z.string(),
  definition_json: z.string(),
  installed_at: z.date(),
  updated_at: z.date(),
});

export type Agent = z.infer<typeof agentRowSchema>;

// ---------------------------------------------------------------------------
// AgentRun — one row per routing decision.
//
// `confidence` is 0.0–1.0. For `override` and `codebase_default` it is always
// 1.0 (deterministic, no inference). For `auto_heuristic` it is the best
// match score. For `auto_llm` it is what M3 reported. For `default_fallback`
// it is 0.0.
//
// `latencyMs` is end-to-end router time (heuristic < 50ms, LLM < 500ms typical).
//
// `reason` is a short human-readable explanation. Examples:
//   "matched keyword 'stack trace' with score 0.82"
//   "M3-small returned bug-investigator (conf 0.85)"
//   "user override: agent:code-reviewer"
//   "no agent matched heuristic, used general-assistant fallback"
// ---------------------------------------------------------------------------

export const agentRunRowSchema = z.object({
  id: z.string(),
  agent_slug: agentSlugSchema,
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  decision: routingDecisionSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  latency_ms: z.number().int().min(0),
  user_message_preview: z.string().max(280),
  created_at: z.date(),
});

export type AgentRun = z.infer<typeof agentRunRowSchema>;

// ---------------------------------------------------------------------------
// RoutingInput — what the orchestrator hands the router.
//
//   rawMessage         : the verbatim user message (already stripped of leading
//                        `agent:slug` if the parser consumed it)
//   overrideSlug       : if the user wrote `agent:slug`, that slug — wins always
//   codebaseAgent      : if the active codebase pinned a default in
//                        .archon/config (e.g. `agent: code-reviewer`), that slug
//   conversationId     : for audit only
//   messageId          : for audit only
//   availableAgentSlugs: the set of agents the router can pick from (so a
//                        stale codebase override never points at an uninstalled
//                        agent)
// ---------------------------------------------------------------------------

export const routingInputSchema = z.object({
  rawMessage: z.string(),
  overrideSlug: agentSlugSchema.nullable(),
  codebaseAgent: agentSlugSchema.nullable(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  availableAgentSlugs: z.array(agentSlugSchema),
});

export type RoutingInput = z.infer<typeof routingInputSchema>;

// ---------------------------------------------------------------------------
// RoutingResult — what the router returns to the orchestrator.
//
//   chosenSlug : the agent the message goes to
//   decision   : how it was chosen (see RoutingDecision above)
//   confidence : 0.0–1.0 (see AgentRun)
//   reason     : short human-readable explanation, also written to agent_runs
//   latencyMs  : router wall-clock time
// ---------------------------------------------------------------------------

export const routingResultSchema = z.object({
  chosenSlug: agentSlugSchema,
  decision: routingDecisionSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  latencyMs: z.number().int().min(0),
});

export type RoutingResult = z.infer<typeof routingResultSchema>;

// ---------------------------------------------------------------------------
// Agent install manifest — what the loader produces before writing to DB.
//
// The loader scans `.archon/agents/*.yaml` in the codebase root, parses each
// file, validates against agentDefinitionSchema, and returns this shape. The
// CLI / UI then asks the user to confirm before persisting.
// ---------------------------------------------------------------------------

export const discoveredAgentSchema = z.object({
  definition: agentDefinitionSchema,
  sourcePath: z.string(),
  source: z.literal('local'),
});

export type DiscoveredAgent = z.infer<typeof discoveredAgentSchema>;

// ---------------------------------------------------------------------------
// Agent list query — used by `archon agent list` and the Console page.
// ---------------------------------------------------------------------------

export const listAgentsOptionsSchema = z.object({
  source: agentSourceSchema.optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type ListAgentsOptions = z.infer<typeof listAgentsOptionsSchema>;

// ---------------------------------------------------------------------------
// Agent list response — wraps rows with a total count for paginated UIs.
// ---------------------------------------------------------------------------

export const listAgentsResultSchema = z.object({
  agents: z.array(agentRowSchema),
  total: z.number().int().min(0),
  counts: z.object({
    all: z.number().int().min(0),
    bundled: z.number().int().min(0),
    local: z.number().int().min(0),
    installed: z.number().int().min(0),
  }),
});

export type ListAgentsResult = z.infer<typeof listAgentsResultSchema>;
