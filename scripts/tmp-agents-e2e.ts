// E2E test: bootstrap bundled agents → list → record run → list runs
//
// Uses the production DB at ~/.archon/archon.db (the same one the dev server
// uses). Safe to run: the schema is idempotent and the bootstrap re-seeds by
// slug.

import { getDatabase, getDialect } from '../packages/core/src/db/connection';
import { bootstrapBundledAgents } from '../packages/core/src/agents/bootstrap';
import { listAgents, getAgentBySlug } from '../packages/core/src/db/agents';
import { recordAgentRun, listAgentRuns, topRoutedAgents } from '../packages/core/src/db/agent-runs';

function step(msg: string): void {
  console.log(`\n=== ${msg} ===`);
}

async function main(): Promise<void> {
  step('1. Forçando abertura do pool (aplica schema idempotente na 1ª query)');
  getDatabase();
  console.log('  pool open, dialect:', getDialect());

  step('2. Bootstrap dos bundled agents');
  const boot = await bootstrapBundledAgents();
  console.log('  inserted:', boot.inserted);
  console.log('  refreshed:', boot.refreshed);
  console.log('  errors:', boot.errors);
  if (boot.errors.length > 0) process.exit(1);

  step('3. Listar todos os agents');
  const list = await listAgents({ limit: 50, offset: 0 });
  console.log('  total:', list.total);
  console.log('  counts:', list.counts);
  for (const a of list.agents) {
    console.log(
      `  - ${a.slug.padEnd(20)} | ${a.source.padEnd(10)} | v${a.version} | ${a.allowed_tools_json.length} tools`
    );
  }
  if (list.total !== 4) {
    console.log(`  FAIL: expected 4 bundled agents, got ${list.total}`);
    process.exit(1);
  }

  step('4. Filtrar por source=bundled');
  const bundled = await listAgents({ source: 'bundled', limit: 50, offset: 0 });
  console.log('  bundled total:', bundled.total);
  if (bundled.total !== 4) {
    console.log(`  FAIL: expected 4 bundled, got ${bundled.total}`);
    process.exit(1);
  }

  step('5. Buscar agent por slug');
  const cr = await getAgentBySlug('code-reviewer');
  console.log('  found:', cr?.name, '|', cr?.source, '| v', cr?.version);
  console.log('  keywords sample:', cr?.keywords_json.slice(0, 60), '...');
  if (cr?.name !== 'Code Reviewer') {
    console.log('  FAIL: code-reviewer not found or wrong name');
    process.exit(1);
  }

  step('6. Gravar 3 agent_runs (1 por tipo de decision)');
  const decisions = [
    {
      slug: 'code-reviewer',
      decision: 'override' as const,
      confidence: 1.0,
      reason: 'user override',
      preview: 'agent:code-reviewer olha esse PR',
    },
    {
      slug: 'test-writer',
      decision: 'auto_heuristic' as const,
      confidence: 0.83,
      reason: 'matched keyword "teste"',
      preview: 'como faço pra escrever um teste?',
    },
    {
      slug: 'bug-investigator',
      decision: 'auto_llm' as const,
      confidence: 0.85,
      reason: 'M3 classified',
      preview: 'tá dando erro 500',
    },
  ];
  for (const d of decisions) {
    const run = await recordAgentRun({
      agentSlug: d.slug,
      conversationId: null,
      messageId: null,
      decision: d.decision,
      confidence: d.confidence,
      reason: d.reason,
      latencyMs: Math.floor(Math.random() * 50),
      userMessagePreview: d.preview,
    });
    console.log(
      `  - ${run.decision} → ${run.agent_slug} (conf ${run.confidence}, ${run.latency_ms}ms) [${run.id.slice(0, 8)}]`
    );
  }

  step('7. Listar os 10 agent_runs mais recentes');
  const runs = await listAgentRuns({ limit: 10, offset: 0 });
  console.log('  total:', runs.total);
  for (const r of runs.runs) {
    console.log(
      `  - ${r.created_at.toISOString()} | ${r.decision.padEnd(20)} | ${r.agent_slug.padEnd(20)} | conf ${r.confidence} | ${r.latency_ms}ms`
    );
  }

  step('8. Top routed agents (últimas 24h)');
  const top = await topRoutedAgents(24, 5);
  console.log('  ', top);

  step('DONE — 8/8 steps verdes');
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\nFATAL:', err);
    process.exit(1);
  }
);
