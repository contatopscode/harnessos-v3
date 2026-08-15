// E2E test: Memory system (Path B — Memory + RAG, Day 1).
//
// Exercises addMemory / listMemories / recallMemories against the
// production DB at ~/.archon/archon.db. Verifies FTS5 search works
// (porter + unicode61 tokenizer), scope filtering, and the bm25
// ranking.

import { getDatabase } from '../packages/core/src/db/connection';
import {
  addMemory,
  listMemories,
  recallMemories,
  deleteMemory,
  countMemoriesByKind,
} from '../packages/core/src/db/memories';

function step(msg: string): void {
  console.log(`\n=== ${msg} ===`);
}

async function main(): Promise<void> {
  step('1. Forçando abertura do pool (aplica schema 025 na 1ª query)');
  getDatabase();
  console.log('  pool open');

  step('2. Adicionando 4 memórias de teste (3 PT-BR + 1 EN, escopos variados)');
  const testIds: string[] = [];
  const samples: {
    scope: 'user' | 'project';
    scopeId: string | null;
    kind: 'preference' | 'fact' | 'project_context' | 'feedback' | 'note';
    content: string;
    source: 'manual' | 'chat' | 'imported';
  }[] = [
    {
      scope: 'user',
      scopeId: null,
      kind: 'preference',
      content: 'Eu sempre uso o editor Cursor com vim mode habilitado e tema Tokyo Night',
      source: 'manual',
    },
    {
      scope: 'user',
      scopeId: null,
      kind: 'preference',
      content: 'Meu setup de TypeScript: strict mode, sem any implícito, ESLint com preset airbnb',
      source: 'manual',
    },
    {
      scope: 'project',
      scopeId: 'test-codebase-archon-001',
      kind: 'project_context',
      content: 'Projeto HarnessOS usa Bun como runtime e SQLite como database padrão',
      source: 'imported',
    },
    {
      scope: 'project',
      scopeId: 'test-codebase-archon-001',
      kind: 'fact',
      content:
        'O sistema de agents (Path A) tem 4 personas bundled: code-reviewer, test-writer, bug-investigator, general-assistant',
      source: 'imported',
    },
  ];
  for (const s of samples) {
    const m = await addMemory(s);
    testIds.push(m.id);
    console.log(
      `  + [${m.kind.padEnd(15)}] scope=${m.scope.padEnd(11)} | ${m.content.slice(0, 70)}${m.content.length > 70 ? '…' : ''}`
    );
  }

  step('3. listMemories (todas)');
  const all = await listMemories({ limit: 50, offset: 0 });
  console.log(`  total: ${all.total}`);
  for (const m of all.memories.slice(0, 5)) {
    console.log(`  - ${m.id.slice(0, 8)} [${m.kind.padEnd(15)}] ${m.content.slice(0, 60)}…`);
  }
  if (all.total < 4) {
    console.log(`  FAIL: expected at least 4, got ${all.total}`);
    process.exit(1);
  }

  step(
    '4. recallMemories com query "qual editor o paulo usa" (OR semantics — deve achar "Cursor")'
  );
  const r1 = await recallMemories({
    query: 'qual editor o paulo usa',
    scopes: [{ scope: 'user', scopeId: null }],
    limit: 3,
  });
  console.log(`  found ${r1.length} memories:`);
  for (const m of r1) {
    console.log(`  - [${m.kind}] ${m.content.slice(0, 70)}… (used ${m.use_count}×)`);
  }
  if (r1.length === 0) {
    console.log('  FAIL: FTS5 should have found at least the Cursor/vim memory');
    process.exit(1);
  }
  if (!r1[0].content.toLowerCase().includes('cursor')) {
    console.log('  FAIL: top hit should be the editor memory');
    process.exit(1);
  }

  step('5. recallMemories com query "runtime database projeto" (OR — deve achar "Bun")');
  const r2 = await recallMemories({
    query: 'runtime database projeto',
    scopes: [{ scope: 'project', scopeId: 'test-codebase-archon-001' }],
    limit: 3,
  });
  console.log(`  found ${r2.length} memories:`);
  for (const m of r2) {
    console.log(`  - [${m.kind}] ${m.content.slice(0, 70)}…`);
  }
  if (r2.length === 0) {
    console.log('  FAIL: FTS5 should have found the Bun memory');
    process.exit(1);
  }
  if (!r2[0].content.toLowerCase().includes('bun')) {
    console.log('  FAIL: top hit should be the Bun memory');
    process.exit(1);
  }

  step('6. recallMemories filtrando por kind="fact" (deve excluir "preference")');
  const r3 = await recallMemories({
    query: 'agents personas bundled',
    scopes: [
      { scope: 'user', scopeId: null },
      { scope: 'project', scopeId: 'test-codebase-archon-001' },
    ],
    kind: 'fact',
    limit: 5,
  });
  console.log(`  found ${r3.length} fact memories:`);
  for (const m of r3) {
    console.log(`  - [${m.kind}] ${m.content.slice(0, 70)}…`);
  }
  for (const m of r3) {
    if (m.kind !== 'fact') {
      console.log(`  FAIL: kind filter leaked ${m.kind}`);
      process.exit(1);
    }
  }

  step('7. recallMemories multi-scope (user + project) — top-N union');
  const r4 = await recallMemories({
    query: 'typescript strict eslint',
    scopes: [
      { scope: 'user', scopeId: null },
      { scope: 'project', scopeId: 'test-codebase-archon-001' },
    ],
    limit: 5,
  });
  console.log(`  found ${r4.length} memories (user + project scopes):`);
  for (const m of r4) {
    console.log(
      `  - [${m.kind.padEnd(15)}] scope=${m.scope.padEnd(11)} ${m.content.slice(0, 60)}…`
    );
  }
  if (r4.length === 0) {
    console.log('  FAIL: multi-scope recall should return at least one TS memory');
    process.exit(1);
  }

  step('8. listMemories com scope=project filter');
  const projOnly = await listMemories({ scope: 'project', limit: 50, offset: 0 });
  console.log(`  project-scoped total: ${projOnly.total}`);
  for (const m of projOnly.memories) {
    console.log(`  - [${m.kind}] ${m.content.slice(0, 60)}…`);
    if (m.scope !== 'project') {
      console.log(`  FAIL: scope filter leaked ${m.scope}`);
      process.exit(1);
    }
  }

  step('9. listMemories com search filter (FTS)');
  const searched = await listMemories({ search: 'bun runtime sqlite', limit: 50, offset: 0 });
  console.log(`  FTS total: ${searched.total}`);
  for (const m of searched.memories) {
    console.log(`  - [${m.kind}] ${m.content.slice(0, 60)}…`);
  }
  if (searched.total === 0) {
    console.log('  FAIL: FTS search should find the Bun memory');
    process.exit(1);
  }

  step('10. countMemoriesByKind');
  const counts = await countMemoriesByKind();
  console.log(`  ${JSON.stringify(counts)}`);
  if (counts.preference < 2) {
    console.log('  FAIL: expected at least 2 preferences');
    process.exit(1);
  }

  step('11. Cleanup (delete test memories)');
  for (const id of testIds) {
    const removed = await deleteMemory(id);
    console.log(`  - ${id.slice(0, 8)}… removed=${removed}`);
  }

  step('12. Verify use_count bumped on recall');
  // Re-add one and recall twice, then check use_count
  const m = await addMemory({
    scope: 'user',
    scopeId: null,
    kind: 'note',
    content: 'Counter de uso para validar bumpMemoryUsage',
    source: 'manual',
  });
  await recallMemories({ query: 'counter uso', scopes: [{ scope: 'user', scopeId: null }] });
  await recallMemories({ query: 'counter uso', scopes: [{ scope: 'user', scopeId: null }] });
  const after = await listMemories({ limit: 50, offset: 0 });
  const found = after.memories.find(x => x.id === m.id);
  if (!found) {
    console.log('  FAIL: memory vanished after recall');
    process.exit(1);
  }
  console.log(`  use_count = ${found.use_count} (expected ≥ 2)`);
  if (found.use_count < 2) {
    console.log('  FAIL: use_count should be ≥ 2 after 2 recalls');
    process.exit(1);
  }
  // Cleanup
  await deleteMemory(m.id);

  step('DONE — 12/12 steps verdes');
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\nFATAL:', err);
    process.exit(1);
  }
);
