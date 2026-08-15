/**
 * Bridge between the Agent system (loader + router + bundled personas) and
 * the orchestrator's chat path.
 *
 * Single entry point used by `handleMessage`:
 *   resolveAgentForMessage(rawMessage, conversation)
 *     → { routing, agent, strippedMessage } | { skip: true }
 *
 * Behaviour:
 *   - Slash commands (`/foo`) skip the agent layer entirely — they go through
 *     the deterministic command handler.
 *   - `agent:slug` at the start of the message is parsed as an override and
 *     stripped from what the AI actually sees. The model never needs to know
 *     the prefix existed; it only needs the persona + tools.
 *   - On any failure (loader error, no agents, DB issue) the helper returns
 *     `{ skip: true }` so the orchestrator continues with the existing
 *     persona-less prompt. The chat must NEVER block on a broken agent layer.
 *   - The `RoutingResult` is returned for the orchestrator to call
 *     `recordAgentRun()` AFTER the AI turn completes (success path only).
 */
import { createLogger } from '@archon/paths';
import { loadAllAgents, parseAgentOverride, routeMessage, type LoadedAgent } from './index';
import type { RoutingResult } from '../schemas/agent';

// ---------------------------------------------------------------------------
// Logger (lazy so test mocks can intercept createLogger)
// ---------------------------------------------------------------------------

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agents.orchestrator');
  return cachedLog;
}

export interface AgentResolution {
  /** The router's decision — what to write to the agent_runs audit table. */
  routing: RoutingResult;
  /** The chosen agent's loaded definition (system prompt, tools, examples). */
  agent: LoadedAgent;
  /**
   * The message with the `agent:slug` prefix stripped, ready to send to the
   * model. When no override was used, this equals the input message.
   */
  strippedMessage: string;
  /**
   * The override slug (if the user wrote `agent:foo` at the start). Useful
   * for logs even when the override didn't match — the router falls through
   * but the operator still wants to see "user tried to pin foo".
   */
  overrideAttempt: string | null;
}

/**
 * Skip-reasons. Kept as a discriminated union so the orchestrator can decide
 * whether to log at info (override not found) vs warn (loader error) without
 * the helper growing conditional return shapes.
 */
export type AgentResolutionResult =
  | {
      skip: true;
      reason: 'slash_command' | 'no_agents' | 'loader_error' | 'router_threw';
      detail?: string;
    }
  | { skip: false; resolution: AgentResolution };

/**
 * Look up the right agent for a chat message.
 *
 * `codebaseDefaultSlug` is the optional codebase-level pin (resolved by the
 * caller from `<codebase>.archon/config.yaml` agents.default or similar; not
 * yet implemented — pass `null` for now and the router skips that stage).
 */
export async function resolveAgentForMessage(
  rawMessage: string,
  options: { conversationId: string; codebaseDefaultSlug?: string | null } = { conversationId: '' }
): Promise<AgentResolutionResult> {
  // Slash commands are deterministic and never route through an agent.
  if (rawMessage.trimStart().startsWith('/')) {
    return { skip: true, reason: 'slash_command' };
  }

  const { slug: overrideSlug, rest: strippedMessage } = parseAgentOverride(rawMessage);

  let loadResult;
  try {
    loadResult = await loadAllAgents();
  } catch (err) {
    getLog().warn(
      { err: err as Error, conversationId: options.conversationId },
      'agents.orchestrator.loader_failed'
    );
    return { skip: true, reason: 'loader_error', detail: (err as Error).message };
  }

  if (loadResult.agents.size === 0) {
    return { skip: true, reason: 'no_agents' };
  }

  // Surface loader errors (bad YAML, permission denied) but don't fail the
  // chat. A user with one broken agent file should still get an answer.
  if (loadResult.errors.length > 0) {
    for (const e of loadResult.errors) {
      getLog().warn(
        { sourcePath: e.sourcePath, reason: e.reason, conversationId: options.conversationId },
        'agents.orchestrator.loader_error'
      );
    }
  }

  const agentList = Array.from(loadResult.agents.values());
  const startedAt = performance.now();
  let routing: RoutingResult;
  try {
    routing = await routeMessage(
      {
        rawMessage,
        overrideSlug: overrideSlug ?? null,
        codebaseAgent: options.codebaseDefaultSlug ?? null,
        conversationId: options.conversationId || null,
        messageId: null,
        availableAgentSlugs: agentList.map(a => a.definition.slug),
      },
      agentList
    );
  } catch (err) {
    getLog().warn(
      { err: err as Error, conversationId: options.conversationId },
      'agents.orchestrator.router_threw'
    );
    return { skip: true, reason: 'router_threw', detail: (err as Error).message };
  }
  const routerLatencyMs = Math.round(performance.now() - startedAt);

  const agent = loadResult.agents.get(routing.chosenSlug);
  if (!agent) {
    // The router claims it picked a slug but the agent isn't in the load
    // result. Should be impossible (the router only picks from what it was
    // given) — defensive guard, log and skip rather than crash.
    getLog().error(
      { chosenSlug: routing.chosenSlug, conversationId: options.conversationId },
      'agents.orchestrator.router_returned_unknown_slug'
    );
    return { skip: true, reason: 'router_threw', detail: `unknown slug: ${routing.chosenSlug}` };
  }

  getLog().info(
    {
      conversationId: options.conversationId,
      chosenSlug: routing.chosenSlug,
      decision: routing.decision,
      confidence: routing.confidence,
      routerLatencyMs,
      overrideAttempt: overrideSlug ?? null,
    },
    'agents.orchestrator.routed'
  );

  return {
    skip: false,
    resolution: {
      routing: { ...routing, latencyMs: routerLatencyMs },
      agent,
      strippedMessage,
      overrideAttempt: overrideSlug ?? null,
    },
  };
}

/**
 * Build the system-prompt append that injects the agent's persona into the
 * orchestrator's existing prompt. Returned as a plain string so the caller
 * can concat it with whatever other sections it builds (manage-run CLI
 * pointer, etc.). Empty string when there's nothing useful to add.
 */
export function buildAgentPromptSection(agent: LoadedAgent): string {
  const def = agent.definition;
  const toolList = def.allowedTools.length > 0 ? def.allowedTools.join(', ') : 'the default set';
  return [
    '## Active agent',
    `You are currently operating as **${def.name}** (slug: \`${def.slug}\`, source: ${agent.source}).`,
    '',
    '### Persona',
    def.systemPrompt.trim(),
    '',
    '### Tools you should prefer',
    toolList,
  ].join('\n');
}
