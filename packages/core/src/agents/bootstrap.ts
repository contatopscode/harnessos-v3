/**
 * Bootstrap the `remote_agent_agents` table with the bundled agents
 * (code-reviewer, test-writer, bug-investigator, general-assistant).
 *
 * Called once on server startup. Idempotent — `upsertAgent` replaces by slug
 * so a stale bundled can be refreshed (e.g. when a new app version ships an
 * updated system prompt). `installed_at` is preserved on update.
 *
 * The loader is `loadBundledAgents()`, not `loadAllAgents()`, because the
 * bundled set is what the app ships with. Local + global agents are
 * discovered on demand by the orchestrator, not seeded here.
 */
import { loadBundledAgents } from './loader';
import { upsertAgent, toAgentInsert } from '../db/agents';
import { createLogger } from '@archon/paths';

// ---------------------------------------------------------------------------
// Logger (lazy so test mocks can intercept createLogger).
// ---------------------------------------------------------------------------

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agents.bootstrap');
  return cachedLog;
}

export interface BootstrapResult {
  inserted: string[];
  refreshed: string[];
  errors: { slug: string; reason: string }[];
}

/**
 * Sync the bundled agents into the `remote_agent_agents` table.
 *
 * Returns the list of slugs that were inserted (new), refreshed (updated),
 * and any errors. Errors are NOT thrown — the bootstrap is best-effort
 * because the app must keep running even if the DB is briefly unavailable.
 */
export async function bootstrapBundledAgents(): Promise<BootstrapResult> {
  const result: BootstrapResult = { inserted: [], refreshed: [], errors: [] };
  const { agents, errors } = await loadBundledAgents();
  if (errors.length > 0) {
    for (const e of errors) {
      getLog().warn({ sourcePath: e.sourcePath, reason: e.reason }, 'agents.bootstrap.load_error');
    }
  }

  for (const loaded of agents) {
    const slug = loaded.definition.slug;
    try {
      const before = await isInstalled(slug);
      await upsertAgent(toAgentInsert(loaded));
      if (before) result.refreshed.push(slug);
      else result.inserted.push(slug);
    } catch (err) {
      result.errors.push({ slug, reason: (err as Error).message });
      getLog().error({ err: err as Error, slug }, 'agents.bootstrap.upsert_failed');
    }
  }

  if (result.errors.length === 0) {
    getLog().info(
      {
        inserted: result.inserted.length,
        refreshed: result.refreshed.length,
        total: agents.length,
      },
      'agents.bootstrap.completed'
    );
  } else {
    getLog().error(
      { errors: result.errors.length, total: agents.length },
      'agents.bootstrap.partial_failure'
    );
  }
  return result;
}

/**
 * Cheap existence check used to distinguish "newly inserted" from "refreshed"
 * in the bootstrap report. Kept private — callers that want a list of
 * installed agents should use `listAgents` from db/agents.
 */
async function isInstalled(slug: string): Promise<boolean> {
  // Lazy import to avoid a circular dep with db/agents (which is what
  // toAgentInsert() uses, and the loaders don't need db).
  const { getAgentBySlug } = await import('../db/agents');
  return (await getAgentBySlug(slug)) !== null;
}
