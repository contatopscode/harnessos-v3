/**
 * Bridge between the Memory system and the orchestrator's chat path.
 *
 * Mirrors the shape of `agent-integration.ts` so the orchestrator can call
 * one helper to get the prompt section it should inject, and one helper
 * to detect "remember this" signals in the user message. Both are safe
 * by default — failures are logged and the chat continues without memory.
 *
 * Two things the orchestrator gets from here per turn:
 *   1. `buildMemoryPromptSection(message, scopes)` — the system-prompt
 *      fragment listing the top-N relevant memories (FTS5 recall). Injected
 *      AFTER the agent persona so the most-recent instructions win.
 *   2. `detectMemorySignals(message)` — does the user want to remember
 *      something explicit? PT-BR + EN patterns. If yes, returns the
 *      content that should be saved (the text AFTER the signal phrase).
 *      The orchestrator then calls `addMemory` on the success path.
 */
import { createLogger } from '@archon/paths';
import { addMemory, recallMemories } from '../db/memories';
import type { Memory, MemoryKind, MemoryScope, MemorySource } from '../schemas/memory';

// ---------------------------------------------------------------------------
// Logger (lazy so test mocks can intercept createLogger)
// ---------------------------------------------------------------------------

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('memory.orchestrator');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Recall (system-prompt section)
// ---------------------------------------------------------------------------

/**
 * Build a system-prompt fragment listing the memories the router matched
 * for this turn. Empty string when no relevant memories — the orchestrator
 * should always concatenate (never replace) the result.
 *
 * Default scope set is the union of the agent (if provided) and the
 * conversation. A project scope is added when the conversation is
 * scoped to a codebase — keeps project_context memories in reach.
 */
export async function buildMemoryPromptSection(
  query: string,
  options: {
    conversationId?: string | null;
    agentSlug?: string | null;
    codebaseId?: string | null;
    limit?: number;
  } = {}
): Promise<string> {
  const { conversationId, agentSlug, codebaseId, limit = 5 } = options;
  const scopes: { scope: MemoryScope; scopeId?: string | null }[] = [
    { scope: 'user', scopeId: null },
  ];
  if (agentSlug) scopes.push({ scope: 'agent', scopeId: agentSlug });
  if (codebaseId) scopes.push({ scope: 'project', scopeId: codebaseId });
  if (conversationId) scopes.push({ scope: 'conversation', scopeId: conversationId });

  let memories: Memory[];
  try {
    memories = await recallMemories({ query, scopes, limit });
  } catch (err) {
    // Never let a memory lookup break the chat. Log and continue.
    getLog().warn(
      { err: err as Error, conversationId: options.conversationId },
      'memory.orchestrator.recall_failed'
    );
    return '';
  }

  if (memories.length === 0) return '';

  const lines: string[] = [
    '## Recalled memories',
    'Facts the user has shared in past sessions. Apply them silently when relevant; do not announce that you remembered.',
    '',
  ];
  for (const m of memories) {
    const sourceTag =
      m.source === 'chat' ? ' [user said]' : m.source === 'manual' ? ' [manual]' : '';
    lines.push(`- ${m.content}${sourceTag}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Memory signal detection (PT-BR + EN)
// ---------------------------------------------------------------------------

/**
 * Common signal phrases that mean "remember this". Case-insensitive, anchored
 * at the start of the message (or right after a greeting). The text AFTER
 * the signal is what should be saved. If a content-kind hint follows
 * ("lembre como preferência: X" / "remember as a fact: Y"), we map that to
 * the `kind` field. Otherwise the default is `note`.
 *
 * Why anchored: avoids false positives like "não precisa lembrar disso"
 * (the user explicitly says NOT to remember). And it matches how people
 * actually write memory instructions in practice.
 */
const PT_BR_SIGNALS: { pattern: RegExp; kind: MemoryKind | null }[] = [
  { pattern: /^\s*(?:por\s+favor[,\s]+)?lembr[ae]\s+(?:que\s+)?(?:de\s+que\s+)?/i, kind: 'note' },
  {
    pattern:
      /^\s*(?:por\s+favor[,\s]+)?lembr[ae]\s+como\s+(preferência|preferencia|fato|contexto|feedback|nota)\s*:\s*/i,
    kind: null,
  },
  {
    pattern: /^\s*(?:por\s+favor[,\s]+)?nunca\s+esque(cer|ça|ca)\s+(?:que\s+)?/i,
    kind: 'preference',
  },
  {
    pattern: /^\s*(?:por\s+favor[,\s]+)?sempre\s+(?:lembr[ae]|esque)\s+(?:que\s+)?/i,
    kind: 'preference',
  },
  // Accept "preferência é/são:" (with or without trailing space) and bare ":"
  { pattern: /^\s*(?:minha|minhas)\s+preferência\s+(?:é|são|:)[:\s]+/i, kind: 'preference' },
  { pattern: /^\s*meu\s+setup\s+(?:é|são|:)[:\s]+/i, kind: 'preference' },
  { pattern: /^\s*contexto\s+do\s+projeto\s*:\s*/i, kind: 'project_context' },
  { pattern: /^\s*nota\s+(?:importante\s*)?:\s*/i, kind: 'note' },
];

const EN_SIGNALS: { pattern: RegExp; kind: MemoryKind | null }[] = [
  { pattern: /^\s*(?:please\s+)?remember\s+(?:that\s+)?/i, kind: 'note' },
  {
    pattern:
      /^\s*(?:please\s+)?remember\s+(?:this|these)\s+as\s+(?:a\s+)?(preference|fact|context|feedback|note)\s*:\s*/i,
    kind: null,
  },
  { pattern: /^\s*(?:please\s+)?(?:don't|do\s+not)\s+forget\s+(?:that\s+)?/i, kind: 'preference' },
  // Accept "always remember:" (colon glued) and "always remember that" — the
  // colon-without-space case is the common PT-BR/EN shorthand so we strip the
  // colon from the rest before storing.
  { pattern: /^\s*(?:please\s+)?always\s+remember(?:\s*[:\s]+(?:that\s+)?)?/i, kind: 'preference' },
  { pattern: /^\s*my\s+preference\s+(?:is|are|:)\s+/i, kind: 'preference' },
  { pattern: /^\s*my\s+setup\s+(?:is|are|:)\s+/i, kind: 'preference' },
  { pattern: /^\s*project\s+context\s*:\s*/i, kind: 'project_context' },
  { pattern: /^\s*note\s*:\s*/i, kind: 'note' },
];

const ALL_SIGNALS = [...PT_BR_SIGNALS, ...EN_SIGNALS];

const KIND_LABELS_PT: Record<string, MemoryKind> = {
  preferencia: 'preference',
  preferência: 'preference',
  fato: 'fact',
  contexto: 'project_context',
  feedback: 'feedback',
  nota: 'note',
};
const KIND_LABELS_EN: Record<string, MemoryKind> = {
  preference: 'preference',
  fact: 'fact',
  context: 'project_context',
  feedback: 'feedback',
  note: 'note',
};

export interface MemorySignal {
  /** The text to remember (the message after the signal phrase). */
  content: string;
  /** What kind of memory this is. Defaults to 'note' when no hint. */
  kind: MemoryKind;
  /** Always 'chat' for user-said signals. */
  source: MemorySource;
  /** Which scope the user meant by the conversation context. The
   *  orchestrator resolves project / agent / conversation IDs at the
   *  call site; we only return 'user' here for the fallback case. */
  scope: MemoryScope;
}

/**
 * Detect an explicit "remember this" signal in a user message. Returns
 * null if no signal matched. Always returns null for empty / whitespace
 * messages and for messages starting with `/` (deterministic commands).
 */
export function detectMemorySignal(rawMessage: string): MemorySignal | null {
  const msg = rawMessage.trim();
  if (msg === '' || msg.startsWith('/')) return null;

  for (const signal of ALL_SIGNALS) {
    const m = signal.pattern.exec(msg);
    if (m === null) continue;
    const rest = msg.slice(m[0].length).trim();
    if (rest === '' || rest.length < 3) return null;
    // Reject cases like "lembre que:" / "remember that" where the regex
    // matched the verb but the user gave no actual content. A bare "que" /
    // "that" / ":" with nothing after is not a real memory instruction.
    if (/^(?:que|that)[:\s]*$/i.test(rest) || /^:\s*$/i.test(rest)) return null;

    let kind: MemoryKind = signal.kind ?? 'note';
    if (signal.kind === null) {
      // The pattern had a kind-capture group; try to map the captured
      // word to a MemoryKind.
      const captured = m[1]?.toLowerCase() ?? '';
      kind = KIND_LABELS_PT[captured] ?? KIND_LABELS_EN[captured] ?? 'note';
    }

    return { content: rest, kind, source: 'chat', scope: 'user' };
  }
  return null;
}

/**
 * Save a memory signal. Used by the orchestrator when it detects an
 * explicit "remember this" intent in a user message. Best-effort: a
 * failure here is logged but never fails the chat turn.
 */
export async function persistMemorySignal(
  signal: MemorySignal,
  options: { conversationId: string; agentSlug?: string | null; codebaseId?: string | null }
): Promise<Memory | null> {
  // Upgrade the scope when the conversation has an agent / codebase —
  // these are higher-signal than a global "user" memory for this kind of
  // content (e.g. "lembre que esse projeto usa Postgres" → project_context).
  let scope: MemoryScope = signal.scope;
  let scopeId: string | null = null;
  if (signal.kind === 'project_context' && options.codebaseId) {
    scope = 'project';
    scopeId = options.codebaseId;
  } else if (signal.kind === 'feedback' && options.agentSlug) {
    scope = 'agent';
    scopeId = options.agentSlug;
  }

  try {
    const saved = await addMemory({
      scope,
      scopeId,
      kind: signal.kind,
      content: signal.content,
      source: signal.source,
      confidence: 0.9,
    });
    getLog().info(
      {
        memoryId: saved.id,
        kind: saved.kind,
        scope: saved.scope,
        scopeId: saved.scope_id,
        conversationId: options.conversationId,
      },
      'memory.orchestrator.persisted'
    );
    return saved;
  } catch (err) {
    getLog().warn(
      { err: err as Error, conversationId: options.conversationId },
      'memory.orchestrator.persist_failed'
    );
    return null;
  }
}
