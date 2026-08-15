/**
 * M3 classifier — real LLM-based agent routing fallback.
 *
 * Path A (Agents) finalization. The router has 5 stages; stage 4 is the LLM
 * classifier. Until now the orchestrator never passed an `llmClassify` option
 * to `routeMessage`, so ambiguous messages always fell through to
 * `general-assistant` without an LLM tie-breaker. This module closes that
 * gap by talking to MiniMax M3 directly over HTTP.
 *
 * The HTTP route is intentional — we don't want to spin up the Pi runtime
 * (it does much more than we need) just to ask a one-shot classification
 * question. M3 is fast (p50 ~ 400 ms for a 50-token answer) and cheap
 * (~$0.30/1M input tokens). The same env config that drives the chat
 * assistant (`MINIMAX_API_KEY` + `MINIMAX_BASE_URL`) drives this.
 *
 * The classifier is feature-flagged off by default (`MEMORY_LLM_CLASSIFIER_ENABLED`
 * env). When the flag is on AND the API key is present, the orchestrator
 * injects this into the router. Failures are non-fatal — the router
 * catches and falls through to the default (matches the contract of
 * `LlmClassifier`).
 */
import { createLogger } from '@archon/paths';
import type { LlmClassifier } from './router';

const log = createLogger('agents.m3-classifier');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** MiniMax M3 endpoint — international. Mainland China is `api.minimaxi.com`. */
const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
/** Model id exposed by MiniMax for M3 (case-sensitive — `MiniMax-M3`). */
const DEFAULT_MODEL = 'MiniMax-M3';
/** Per-request timeout — the classifier is best-effort, not blocking. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Max candidates serialized into the prompt (defense against huge agent lists). */
const MAX_CANDIDATES = 32;
/** Max chars of the user message we send to M3 (perf + cost). */
const MAX_MESSAGE_CHARS = 600;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface M3ClassifierOptions {
  /** Override for tests. Default: process.env.MINIMAX_API_KEY. */
  apiKey?: string;
  /** Override for tests. Default: process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL. */
  baseUrl?: string;
  /** Override for tests. Default: process.env.MINIMAX_MODEL ?? DEFAULT_MODEL. */
  model?: string;
  /**
   * Override for tests. Returns a JSON string in the same shape as
   * `classify` parses. Lets unit tests skip the HTTP layer.
   */
  fetchImpl?: typeof fetch;
}

export interface M3ClassifierHandle {
  /** The LlmClassifier the router accepts. */
  classifier: LlmClassifier;
  /** True if this handle is backed by a real API key; false if it's a no-op. */
  isLive: boolean;
}

/**
 * Build an M3 classifier. Returns a `handle` with a `isLive: false`
 * flag when the API key is missing — callers should treat that as "don't
 * wire this in" so the router skips stage 4 cleanly. We never throw from
 * here: classifier construction must never block the chat turn.
 */
export function buildM3Classifier(options: M3ClassifierOptions = {}): M3ClassifierHandle {
  const apiKey = options.apiKey ?? process.env.MINIMAX_API_KEY ?? '';
  if (apiKey === '') {
    log.debug({}, 'm3_classifier.skipped_no_api_key');
    return { classifier: noopClassifier, isLive: false };
  }
  const baseUrl = options.baseUrl ?? process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL;
  const model = options.model ?? process.env.MINIMAX_MODEL ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    classifier: {
      classify: (message, candidates) =>
        callM3(message, candidates, { apiKey, baseUrl, model, fetchImpl }),
    },
    isLive: true,
  };
}

/**
 * The default `enabled` flag. Off by default to preserve existing behavior
 * for installs that don't want an LLM in the routing path. Turn it on
 * with `MEMORY_LLM_CLASSIFIER_ENABLED=1` (or `true`).
 */
export function isM3ClassifierEnabled(): boolean {
  const raw = process.env.MEMORY_LLM_CLASSIFIER_ENABLED;
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are an agent-routing classifier. Given a user message and a list of agent candidates, reply with the single best agent slug and a confidence score in [0, 1]. Reply with JSON only, no prose, no markdown fences. Schema: {"slug":"<one of the candidates>","confidence":0.0}. Pick "general-assistant" if none of the specialists fit.';

interface CallOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl: typeof fetch;
}

async function callM3(
  message: string,
  candidates: { slug: string; name: string; description: string }[],
  opts: CallOptions
): Promise<{ slug: string; confidence: number }> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('M3 classifier called with no candidates');
  }
  const limitedCandidates = candidates.slice(0, MAX_CANDIDATES);
  const trimmedMessage =
    message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS) : message;
  const userPrompt = [
    `Message: ${JSON.stringify(trimmedMessage)}`,
    '',
    'Candidates:',
    ...limitedCandidates.map(c => `- ${c.slug}: ${c.name} — ${c.description}`.slice(0, 300)),
  ].join('\n');

  const body = JSON.stringify({
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 64,
    stream: false,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`M3 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = json.choices?.[0]?.message?.content ?? '';
  return parseClassifierAnswer(raw, limitedCandidates);
}

/**
 * Parse the model's free-form answer. Tolerates a few common shapes:
 *   - Bare JSON: {"slug":"code-reviewer","confidence":0.72}
 *   - JSON wrapped in ```json ... ``` fences
 *   - JSON with leading/trailing prose
 *   - The slug missing from candidates → throw (the router catches and falls back)
 */
function parseClassifierAnswer(
  raw: string,
  candidates: { slug: string }[]
): { slug: string; confidence: number } {
  const slugs = new Set(candidates.map(c => c.slug));
  const trimmed = raw.trim();

  // 1) Direct JSON parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 2) Strip ```json ... ``` fences and retry.
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        throw new Error(`M3 returned non-JSON: ${trimmed.slice(0, 200)}`);
      }
    } else {
      throw new Error(`M3 returned non-JSON: ${trimmed.slice(0, 200)}`);
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`M3 returned non-object: ${typeof parsed}`);
  }
  const obj = parsed as { slug?: unknown; confidence?: unknown };
  if (typeof obj.slug !== 'string' || obj.slug === '') {
    throw new Error('M3 returned empty/invalid slug');
  }
  if (!slugs.has(obj.slug)) {
    throw new Error(`M3 returned unknown slug: ${obj.slug}`);
  }
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;
  return { slug: obj.slug, confidence };
}

/** No-op classifier used when the API key is missing. Throws so the
 *  router falls through to the default fallback (matching the contract). */
const noopClassifier: LlmClassifier = {
  classify: () => {
    throw new Error('M3 classifier disabled (no MINIMAX_API_KEY)');
  },
};
