/**
 * Agent router — picks the right agent for a given user message.
 *
 * Flow (precedence highest → lowest):
 *   1. `agent:slug` override    (user wrote it at the start of the message — wins always)
 *   2. Codebase default         (codebase .archon/config.yaml pinned an agent)
 *   3. Heuristic                (zero-token keyword/description/examples match)
 *   4. LLM classify (optional)  (M3-small classifies when heuristic is ambiguous)
 *   5. Default fallback         (`general-assistant`, or the first available agent)
 *
 * Performance targets:
 *   - Heuristic: < 50ms (no LLM call)
 *   - LLM fallback: < 500ms (only when needed)
 *   - Default fallback: < 5ms
 *
 * Robustness:
 *   - Never throws. Always returns a RoutingResult.
 *   - Override / codebase default that point to a missing/uninstalled agent
 *     are logged and the router falls through to the next step.
 *   - General-assistant is the universal fallback — if it's not installed,
 *     the router falls back to the first available agent (degraded but alive).
 *
 * Audit (FUTURE):
 *   - The router currently does NOT write to the `agent_runs` table. That's a
 *     separate step the orchestrator performs after a successful route.
 *     When the migration lands, the orchestrator will call
 *     `recordAgentRun(routingResult, input)` here.
 */
import { type RoutingInput, type RoutingResult, routingResultSchema } from '../schemas/agent';
import type { LoadedAgent } from './loader';
import { createLogger } from '@archon/paths';

// ---------------------------------------------------------------------------
// Logger (lazy so test mocks can intercept createLogger).
// ---------------------------------------------------------------------------

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agents.router');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Minimum heuristic score to accept a match (0..1). Below this → ambiguous → LLM or fallback. */
const HEURISTIC_THRESHOLD = 0.5;

/** Slug of the default agent when nothing else matches. */
const DEFAULT_AGENT_SLUG = 'general-assistant';

/** Maximum chars of the message considered for the description overlap (perf). */
const DESC_OVERLAP_MAX_CHARS = 1000;

// ---------------------------------------------------------------------------
// LLM classifier (optional injection point — wired by the orchestrator later).
// Returns { slug, confidence } or throws. The router treats a throw as
// "no usable answer" and falls through to the default.
// ---------------------------------------------------------------------------

export interface LlmClassifier {
  classify(
    message: string,
    candidates: { slug: string; name: string; description: string }[]
  ): Promise<{ slug: string; confidence: number }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse `agent:slug` from the start of a user message.
 *
 * Returns `{ slug, rest }` if the prefix is present, else `{ rest: raw }`.
 * Trims leading whitespace. Case-insensitive prefix match.
 *
 *   "agent:code-reviewer olha esse PR" → { slug: "code-reviewer", rest: "olha esse PR" }
 *   "olha esse PR"                     → { rest: "olha esse PR" }
 *   "Agent: foo bar"                    → { slug: "foo", rest: "bar" }
 */
export function parseAgentOverride(raw: string): { slug?: string; rest: string } {
  const trimmed = raw.trimStart();
  const match = /^(?:agent:)([a-z0-9][a-z0-9-]*)\s*(.*)$/i.exec(trimmed);
  if (!match) return { rest: raw };
  const slug = match[1].toLowerCase();
  const rest = match[2].trim();
  return { slug, rest };
}

/**
 * Pick the best agent for a message.
 */
export async function routeMessage(
  input: RoutingInput,
  agents: LoadedAgent[],
  options: { llmClassify?: LlmClassifier } = {}
): Promise<RoutingResult> {
  const start = performance.now();

  // Sanity: if no agents at all, the system is misconfigured. Throw a
  // descriptive error — there's nothing the router can do without candidates.
  if (agents.length === 0) {
    throw new Error('routeMessage called with no agents. Did you forget to call loadAllAgents()?');
  }

  const available = new Map<string, LoadedAgent>();
  for (const a of agents) available.set(a.definition.slug, a);

  // ─── 1. Override ───────────────────────────────────────────────────────
  if (input.overrideSlug) {
    const found = available.get(input.overrideSlug);
    if (found) {
      return finalize({
        chosenSlug: found.definition.slug,
        decision: 'override',
        confidence: 1.0,
        reason: `user override: agent:${found.definition.slug}`,
        start,
      });
    }
    getLog().warn(
      { overrideSlug: input.overrideSlug, availableSlugs: [...available.keys()] },
      'agent.router.override_slug_not_found'
    );
  }

  // ─── 2. Codebase default ───────────────────────────────────────────────
  if (input.codebaseAgent) {
    const found = available.get(input.codebaseAgent);
    if (found) {
      return finalize({
        chosenSlug: found.definition.slug,
        decision: 'codebase_default',
        confidence: 1.0,
        reason: `codebase .archon/config.yaml pinned agent:${found.definition.slug}`,
        start,
      });
    }
    getLog().warn(
      { codebaseAgent: input.codebaseAgent, availableSlugs: [...available.keys()] },
      'agent.router.codebase_default_not_found'
    );
  }

  // ─── 3. Heuristic ──────────────────────────────────────────────────────
  // We exclude the default agent from the candidate set so the default doesn't
  // steal matches from the specialists. (The default has no keywords by
  // convention, but defensive — if it has, it shouldn't beat a real match.)
  const candidates = agents.filter(a => a.definition.slug !== DEFAULT_AGENT_SLUG);
  const heuristicResult = scoreHeuristic(input.rawMessage, candidates);
  if (heuristicResult && heuristicResult.score >= HEURISTIC_THRESHOLD) {
    return finalize({
      chosenSlug: heuristicResult.agentSlug,
      decision: 'auto_heuristic',
      confidence: heuristicResult.score,
      reason: heuristicResult.reason,
      start,
    });
  }

  // ─── 4. LLM fallback (optional) ───────────────────────────────────────
  if (options.llmClassify && candidates.length > 0) {
    try {
      const llmResult = await options.llmClassify.classify(
        input.rawMessage,
        candidates.map(a => ({
          slug: a.definition.slug,
          name: a.definition.name,
          description: a.definition.description,
        }))
      );
      if (available.has(llmResult.slug)) {
        return finalize({
          chosenSlug: llmResult.slug,
          decision: 'auto_llm',
          confidence: clamp01(llmResult.confidence),
          reason: `M3 classifier returned ${llmResult.slug} (conf ${llmResult.confidence.toFixed(2)})`,
          start,
        });
      }
      getLog().warn(
        { llmSlug: llmResult.slug },
        'agent.router.llm_classifier_returned_unknown_slug'
      );
    } catch (err) {
      getLog().warn(
        { err: (err as Error).message },
        'agent.router.llm_classifier_threw_falling_through'
      );
    }
  }

  // ─── 5. Default fallback ──────────────────────────────────────────────
  const generalAssistant = available.get(DEFAULT_AGENT_SLUG);
  if (generalAssistant) {
    return finalize({
      chosenSlug: generalAssistant.definition.slug,
      decision: 'default_fallback',
      confidence: 0.0,
      reason: `no agent matched heuristic (best=${heuristicResult?.score.toFixed(2) ?? '0'}); used general-assistant`,
      start,
    });
  }
  // Last-resort: pick the first available agent. Degraded but alive.
  const first = agents[0];
  getLog().warn(
    { firstSlug: first.definition.slug, hasGeneralAssistant: false },
    'agent.router.no_general_assistant_using_first_agent'
  );
  return finalize({
    chosenSlug: first.definition.slug,
    decision: 'default_fallback',
    confidence: 0.0,
    reason: `general-assistant not installed; fell through to first available agent: ${first.definition.slug}`,
    start,
  });
}

// ---------------------------------------------------------------------------
// Heuristic scoring (zero-token, < 50ms typical)
// ---------------------------------------------------------------------------

interface HeuristicResult {
  agentSlug: string;
  score: number;
  reason: string;
}

/**
 * Score each candidate against the user message using three signals:
 *   1. keyword_substring_match  (weight 1.0) — most reliable
 *   2. description_overlap      (weight 0.5) — semantic-ish, cheap
 *   3. example_overlap          (weight 0.7) — exact pattern match
 *
 * Returns the best candidate or undefined if no candidate has a positive
 * score on any signal.
 */
function scoreHeuristic(message: string, candidates: LoadedAgent[]): HeuristicResult | undefined {
  if (candidates.length === 0) return undefined;
  const msg = message.toLowerCase();
  const msgWords = tokenize(message);

  let best: HeuristicResult | undefined;

  for (const candidate of candidates) {
    const def = candidate.definition;

    // 1. Keyword substring match — strongest signal. A keyword hit means
    //    the user literally used one of the agent's expected trigger words.
    const keywordHits = def.keywords.filter(kw => msg.includes(kw.toLowerCase()));
    const keywordScore = def.keywords.length === 0 ? 0 : keywordHits.length / def.keywords.length;

    // 2. Description overlap — token-set overlap coefficient between the
    //    message and the agent's description. Cheap, no embeddings.
    const descScore = overlapCoefficient(msgWords, tokenize(def.description));

    // 3. Example overlap — best overlap against the agent's few-shot
    //    examples. Stronger than description because examples are concrete
    //    user messages the agent is built for.
    const exampleScore =
      def.examples.length === 0
        ? 0
        : Math.max(...def.examples.map(ex => overlapCoefficient(msgWords, tokenize(ex))));

    // Combine with weights. Cap at 1.0.
    const combined = Math.min(1.0, keywordScore * 1.0 + descScore * 0.5 + exampleScore * 0.7);

    if (combined > 0 && (!best || combined > best.score)) {
      const parts: string[] = [];
      if (keywordHits.length > 0) {
        parts.push(
          `matched ${keywordHits.length} keyword(s): ${keywordHits.slice(0, 3).join(', ')}`
        );
      }
      if (descScore > 0) parts.push(`description overlap ${descScore.toFixed(2)}`);
      if (exampleScore > 0) parts.push(`best example overlap ${exampleScore.toFixed(2)}`);
      best = {
        agentSlug: def.slug,
        score: combined,
        reason: `${def.slug} (score ${combined.toFixed(2)}: ${parts.join('; ')})`,
      };
    }
  }

  return best;
}

/** Tokenize: lowercase, split on non-letter/digit, drop empty + tiny. */
function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const truncated =
    text.length > DESC_OVERLAP_MAX_CHARS ? text.slice(0, DESC_OVERLAP_MAX_CHARS) : text;
  return new Set(
    truncated
      .toLowerCase()
      .split(/[^a-z0-9áàâãéèêíïóôõúüç]+/u)
      .filter(w => w.length >= 3)
  );
}

/**
 * Overlap coefficient: |A ∩ B| / min(|A|, |B|).
 *
 * Why overlap and not Jaccard: when the corpus (description / example) is much
 * larger than the query (user message), Jaccard almost always returns ~0
 * because the intersection is dominated by the smaller set's words. Overlap
 * normalizes by the smaller set, so even a single shared word from a short
 * query against a long description scores meaningfully.
 */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function finalize(args: {
  chosenSlug: string;
  decision: RoutingResult['decision'];
  confidence: number;
  reason: string;
  start: number;
}): RoutingResult {
  const result: RoutingResult = {
    chosenSlug: args.chosenSlug,
    decision: args.decision,
    confidence: args.confidence,
    reason: args.reason,
    latencyMs: Math.max(0, Math.round(performance.now() - args.start)),
  };
  // Validate against schema so the audit writer can trust the shape.
  return routingResultSchema.parse(result);
}

// ---------------------------------------------------------------------------
// Re-exports for convenience — consumers can import everything from one place.
// RoutingInput / RoutingResult come from the schema; LoadedAgent comes from
// the loader. We don't re-export them here — consumers should import from
// their canonical module (./loader and ../schemas/agent).
// ---------------------------------------------------------------------------
