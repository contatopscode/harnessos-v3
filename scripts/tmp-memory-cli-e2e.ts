/**
 * E2E for the new `archon memory …` CLI commands + the orchestrator
 * memory-signal detection helper. Path B — Memory + RAG, Day 2.
 *
 * Runs against the real DB (HarnessOS uses ~/.archon/archon.db). Cleans
 * its own scratch memories at the end so reruns stay idempotent. Each
 * step is a hard assertion; non-zero exit on any failure.
 */
import {
  addMemory,
  deleteMemory,
  listMemories,
  recallMemories,
  detectMemorySignal,
  type MemoryScope,
  type MemoryKind,
} from '../packages/core/src';

let ok = 0;
let fail = 0;
const log = (label: string, okFlag: boolean, detail?: string): void => {
  if (okFlag) {
    ok += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------------------
// 1. detectMemorySignal: PT-BR + EN signal phrases
// ---------------------------------------------------------------------------

const ptSignal = detectMemorySignal('lembre que meu setup usa Postgres 16 + Redis na 6380');
log(
  'detectMemorySignal PT-BR "lembre que…"',
  ptSignal !== null && ptSignal.content === 'meu setup usa Postgres 16 + Redis na 6380',
  ptSignal ? `kind=${ptSignal.kind}` : 'null'
);

const enSignal = detectMemorySignal('always remember: the user prefers Bun over Node');
log(
  'detectMemorySignal EN "always remember:"',
  enSignal !== null && enSignal.content === 'the user prefers Bun over Node',
  enSignal ? `kind=${enSignal.kind}` : 'null'
);

const preferenceSignal = detectMemorySignal('minha preferência é: nunca usar Anthropic');
log(
  'detectMemorySignal PT "minha preferência é:"',
  preferenceSignal !== null &&
    preferenceSignal.kind === 'preference' &&
    preferenceSignal.content === 'nunca usar Anthropic',
  preferenceSignal ? `kind=${preferenceSignal.kind}` : 'null'
);

const projectContextSignal = detectMemorySignal('contexto do projeto: este monorepo usa turborepo');
log(
  'detectMemorySignal "contexto do projeto:"',
  projectContextSignal !== null && projectContextSignal.kind === 'project_context',
  projectContextSignal ? `kind=${projectContextSignal.kind}` : 'null'
);

const noSignal = detectMemorySignal('Por favor, explique o que o orchestrator faz');
log('detectMemorySignal no-signal returns null', noSignal === null);

const slashSignal = detectMemorySignal('/help');
log('detectMemorySignal slash-command ignored', slashSignal === null);

const emptySignal = detectMemorySignal('lembre que:');
log('detectMemorySignal empty content returns null', emptySignal === null);

// ---------------------------------------------------------------------------
// 2. CLI round-trip: add → list → search → forget
// ---------------------------------------------------------------------------

const scratchTag = `[memory-cli-e2e ${Date.now()}]`;
const sampleContent = `${scratchTag} Postgres está na porta 5434 neste setup local`;
const projectId = '__e2e_scratch__';

let savedId: string | null = null;
try {
  const saved = await addMemory({
    scope: 'project' as MemoryScope,
    scopeId: projectId,
    kind: 'fact' as MemoryKind,
    content: sampleContent,
    source: 'manual',
  });
  savedId = saved.id;
  log('addMemory (project scope)', saved.id.length > 0, `id=${saved.id.slice(0, 8)}…`);
} catch (err) {
  log('addMemory', false, (err as Error).message);
}

const listed = await listMemories({ scope: 'project', kind: 'fact', limit: 200 });
const found = listed.memories.find(m => m.id === savedId);
log('listMemories finds the saved memory', found !== undefined);

const recalled = await recallMemories({
  query: 'Postgres porta local',
  scopes: [{ scope: 'project', scopeId: projectId }],
  limit: 5,
});
const recalledHit = recalled.find(m => m.id === savedId);
log(
  'recallMemories (FTS5) finds the saved memory',
  recalledHit !== undefined,
  recalledHit ? `conf=${recalledHit.confidence.toFixed(2)}` : 'no hit'
);

// ---------------------------------------------------------------------------
// 3. Forget cleanup
// ---------------------------------------------------------------------------

if (savedId !== null) {
  const removed = await deleteMemory(savedId);
  log('deleteMemory cleans up the scratch row', removed);
  const after = await listMemories({ scope: 'project', kind: 'fact', limit: 200 });
  const stillThere = after.memories.find(m => m.id === savedId);
  log('listMemories no longer returns the forgotten row', stillThere === undefined);
}

console.log('');
console.log(`Result: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
