/**
 * Agent command - list, show, install, uninstall, route, and audit agents.
 *
 * Mirror of `archon workflow …` so the CLI feels familiar to operators
 * who already use workflows day-to-day. Every subcommand accepts `--json`
 * for machine-readable output so the same command feeds humans and CI.
 *
 * Exit code contract: 0 success, 1 invalid args / load error, 2 not found
 * (so `archon agent show <slug> && …` works in shell pipelines).
 */
import { resolve } from 'path';
import { existsSync } from 'fs';
import {
  listAgents,
  getAgentBySlug,
  upsertAgent,
  deleteAgentBySlug,
  recordAgentRun,
  listAgentRuns,
  topRoutedAgents,
  loadAgentFromFile,
  routeMessage,
  loadAllAgents,
  toAgentInsert,
  type AgentSource,
} from '@archon/core';

const EXIT_OK = 0;
const EXIT_BAD_ARGS = 1;
const EXIT_NOT_FOUND = 2;

const SOURCES: readonly AgentSource[] = ['bundled', 'local', 'installed'] as const;

function isAgentSource(value: string): value is AgentSource {
  return (SOURCES as readonly string[]).includes(value);
}

/** Parse a JSON-as-TEXT column from the agent row into a JS array. */
function parseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

interface ListOptions {
  json?: boolean;
  source?: string;
  search?: string;
  limit?: number;
}

interface ShowOptions {
  json?: boolean;
}

interface RouteOptions {
  json?: boolean;
  codebase?: string;
}

interface RunsOptions {
  json?: boolean;
  limit?: number;
  slug?: string;
}

/**
 * `archon agent list` — show all installed agents with source/version and a
 * compact tools/keywords/examples count. Filter by `--source` and free-text
 * search by `--search` (matches name + description, case-insensitive).
 */
export async function agentListCommand(options: ListOptions = {}): Promise<number> {
  const limit = options.limit ?? 50;
  const source = options.source;
  if (source !== undefined && !isAgentSource(source)) {
    console.error(`Error: --source must be one of ${SOURCES.join(', ')}; got '${source}'.`);
    return EXIT_BAD_ARGS;
  }

  const result = await listAgents({
    source: source,
    search: options.search,
    limit,
    offset: 0,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          total: result.total,
          counts: result.counts,
          agents: result.agents.map(a => ({
            slug: a.slug,
            name: a.name,
            source: a.source,
            version: a.version,
            description: a.description,
            keywords: parseJsonArray(a.keywords_json),
            examples: parseJsonArray(a.examples_json),
            tools: parseJsonArray(a.allowed_tools_json),
            model: a.model,
            author: a.author,
            installed_at:
              a.installed_at instanceof Date ? a.installed_at.toISOString() : a.installed_at,
          })),
        },
        null,
        2
      )
    );
    return EXIT_OK;
  }

  console.log(
    `Found ${result.total} agent(s)` +
      (source ? ` (source=${source})` : '') +
      (options.search ? ` matching "${options.search}"` : '') +
      ':'
  );
  console.log(
    `  bundled: ${result.counts.bundled}  local: ${result.counts.local}  installed: ${result.counts.installed}`
  );
  console.log('');
  for (const a of result.agents) {
    const kw = parseJsonArray(a.keywords_json).length;
    const ex = parseJsonArray(a.examples_json).length;
    const tools = parseJsonArray(a.allowed_tools_json).length;
    console.log(`  ${a.slug.padEnd(22)} [${a.source.padEnd(9)}] v${a.version}  ${a.name}`);
    console.log(`    ${a.description}`);
    console.log(
      `    ${kw} keywords · ${ex} examples · ${tools} tools${a.model ? ` · model=${a.model}` : ''}`
    );
    console.log('');
  }
  return EXIT_OK;
}

/**
 * `archon agent show <slug>` — full detail for one agent: name, source,
 * system prompt, tags, keywords, examples, allowed tools.
 */
export async function agentShowCommand(slug: string, options: ShowOptions = {}): Promise<number> {
  if (!slug) {
    console.error('Usage: archon agent show <slug> [--json]');
    return EXIT_BAD_ARGS;
  }
  const agent = await getAgentBySlug(slug);
  if (!agent) {
    console.error(
      `Error: agent '${slug}' not found. Run \`archon agent list\` to see installed agents.`
    );
    return EXIT_NOT_FOUND;
  }

  const keywords = parseJsonArray(agent.keywords_json);
  const examples = parseJsonArray(agent.examples_json);
  const tools = parseJsonArray(agent.allowed_tools_json);
  const tags = parseJsonArray(agent.tags_json);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          slug: agent.slug,
          name: agent.name,
          source: agent.source,
          version: agent.version,
          description: agent.description,
          system_prompt: agent.system_prompt,
          tags,
          keywords,
          examples,
          allowed_tools: tools,
          model: agent.model,
          memory_ref: agent.memory_ref,
          author: agent.author,
          installed_at:
            agent.installed_at instanceof Date
              ? agent.installed_at.toISOString()
              : agent.installed_at,
          updated_at:
            agent.updated_at instanceof Date ? agent.updated_at.toISOString() : agent.updated_at,
        },
        null,
        2
      )
    );
    return EXIT_OK;
  }

  console.log(`${agent.name} (${agent.slug})`);
  console.log(`  Source:      ${agent.source}  v${agent.version}`);
  if (agent.author) console.log(`  Author:      ${agent.author}`);
  if (agent.model) console.log(`  Model:       ${agent.model}`);
  if (agent.memory_ref) console.log(`  Memory ref:  ${agent.memory_ref}`);
  console.log(`  Description: ${agent.description}`);
  console.log('');
  console.log('  System prompt:');
  for (const line of agent.system_prompt.split('\n')) {
    console.log(`    ${line}`);
  }
  console.log('');
  if (tags.length > 0) {
    console.log(`  Tags:        ${tags.join(', ')}`);
  }
  if (keywords.length > 0) {
    console.log(`  Keywords:    ${keywords.join(', ')}`);
  }
  if (tools.length > 0) {
    console.log(`  Tools:       ${tools.join(', ')}`);
  }
  if (examples.length > 0) {
    console.log('  Examples:');
    for (const ex of examples) {
      console.log(`    - ${ex}`);
    }
  }
  return EXIT_OK;
}

/**
 * `archon agent install <path>` — load a YAML agent file from disk, validate
 * it via the agent schema, and upsert into the DB. Path can be relative
 * (resolved against cwd) or absolute.
 */
export async function agentInstallCommand(
  path: string,
  options: { json?: boolean } = {}
): Promise<number> {
  if (!path) {
    console.error('Usage: archon agent install <path-to-yaml>');
    return EXIT_BAD_ARGS;
  }
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    console.error(`Error: file not found: ${absolute}`);
    return EXIT_NOT_FOUND;
  }

  const loadResult = await loadAgentFromFile(absolute);
  if (loadResult.error) {
    console.error(`Error: ${loadResult.error.sourcePath}: ${loadResult.error.reason}`);
    return EXIT_BAD_ARGS;
  }
  const loaded = loadResult.agent;
  if (!loaded) {
    console.error(`Error: no agent definition found in ${absolute}`);
    return EXIT_BAD_ARGS;
  }

  try {
    // The loader already validated the YAML against the agent schema; this
    // upsert just persists it. Schema errors would have surfaced from the
    // loader's parseAgentContent step above.
    const inserted = await upsertAgent(toAgentInsert(loaded));
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            slug: inserted.slug,
            source: inserted.source,
            version: inserted.version,
            installed_at:
              inserted.installed_at instanceof Date
                ? inserted.installed_at.toISOString()
                : inserted.installed_at,
          },
          null,
          2
        )
      );
      return EXIT_OK;
    }
    console.log(
      `Installed agent ${inserted.slug} (${inserted.source} v${inserted.version}) from ${absolute}`
    );
    return EXIT_OK;
  } catch (err) {
    console.error(`Error: failed to install agent: ${(err as Error).message}`);
    return EXIT_BAD_ARGS;
  }
}

/**
 * `archon agent uninstall <slug>` — remove an installed agent. Refuses to
 * uninstall `bundled` agents (they ship with the app and re-seed on boot) —
 * use a different `source` if you need to override.
 */
export async function agentUninstallCommand(
  slug: string,
  options: { json?: boolean } = {}
): Promise<number> {
  if (!slug) {
    console.error('Usage: archon agent uninstall <slug>');
    return EXIT_BAD_ARGS;
  }
  const existing = await getAgentBySlug(slug);
  if (!existing) {
    console.error(`Error: agent '${slug}' not found.`);
    return EXIT_NOT_FOUND;
  }
  if (existing.source === 'bundled') {
    console.error(
      `Error: '${slug}' is a bundled agent and cannot be uninstalled.\n` +
        '  Bundled agents re-seed on every server boot. To override, install a\n' +
        '  same-slug agent from a local file (source=installed).'
    );
    return EXIT_BAD_ARGS;
  }
  const removed = await deleteAgentBySlug(slug);
  if (!removed) {
    console.error(`Error: failed to delete agent '${slug}'.`);
    return EXIT_BAD_ARGS;
  }
  if (options.json) {
    console.log(JSON.stringify({ ok: true, slug, removed: true }, null, 2));
    return EXIT_OK;
  }
  console.log(`Uninstalled agent ${slug}.`);
  return EXIT_OK;
}

/**
 * `archon agent run <message>` — simulate the routing decision for a message
 * without actually sending a chat request. Uses the same 5-stage flow as the
 * orchestrator: override → codebase default → heuristic → LLM fallback →
 * default fallback. Records the run so it shows up in `agent runs`.
 *
 * `--codebase <slug>` pins a codebase default for the simulation.
 */
export async function agentRunCommand(
  message: string,
  options: RouteOptions = {}
): Promise<number> {
  if (!message?.trim()) {
    console.error('Usage: archon agent run <message> [--codebase <slug>] [--json]');
    return EXIT_BAD_ARGS;
  }
  const { agents, errors } = await loadAllAgents();
  if (agents.size === 0) {
    console.error('Error: no agents available. Run `archon agent list` to check.');
    return EXIT_BAD_ARGS;
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`Warning: ${e.sourcePath}: ${e.reason}`);
    }
  }

  const startedAt = Date.now();
  // loadAllAgents returns a slug→LoadedAgent map; flatten for the router.
  const agentList = Array.from(agents.values());
  const decision = await routeMessage(
    {
      rawMessage: message,
      overrideSlug: null,
      codebaseAgent: options.codebase ?? null,
      conversationId: null,
      messageId: null,
      availableAgentSlugs: agentList.map(a => a.definition.slug),
    },
    agentList
  );
  const latencyMs = Date.now() - startedAt;
  const chosen = agents.get(decision.chosenSlug);
  const chosenName = chosen?.definition.name ?? decision.chosenSlug;

  // Best-effort audit write — never throws. Failures are visible in the
  // `agent runs` output (the row simply doesn't appear) but don't block CLI.
  try {
    await recordAgentRun({
      agentSlug: decision.chosenSlug,
      conversationId: null,
      messageId: null,
      decision: decision.decision,
      confidence: decision.confidence,
      reason: decision.reason,
      latencyMs,
      userMessagePreview: message.slice(0, 200),
    });
  } catch {
    // ignored — the simulation result is the source of truth
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          message: message.slice(0, 200),
          routed_to: decision.chosenSlug,
          decision: decision.decision,
          confidence: decision.confidence,
          reason: decision.reason,
          latency_ms: latencyMs,
        },
        null,
        2
      )
    );
    return EXIT_OK;
  }

  console.log(`Message:    ${message.length > 100 ? message.slice(0, 97) + '…' : message}`);
  console.log(`Routed to:  ${decision.chosenSlug}  (${chosenName})`);
  console.log(
    `Decision:   ${decision.decision}  ·  confidence ${decision.confidence.toFixed(2)}  ·  ${latencyMs}ms`
  );
  console.log(`Reason:     ${decision.reason}`);
  return EXIT_OK;
}

/**
 * `archon agent runs` — audit log of recent routing decisions. Filter by
 * `--slug` (one agent). Default 20 rows; pass `--limit` to change. The
 * free-form reasoning string in each row tells you which stage (override,
 * heuristic, fallback) the router chose and why.
 */
export async function agentRunsCommand(options: RunsOptions = {}): Promise<number> {
  const limit = options.limit ?? 20;
  const result = await listAgentRuns({
    agentSlug: options.slug,
    limit,
    offset: 0,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          total: result.total,
          runs: result.runs.map(r => ({
            id: r.id,
            agent_slug: r.agent_slug,
            decision: r.decision,
            confidence: r.confidence,
            reason: r.reason,
            latency_ms: r.latency_ms,
            user_message_preview: r.user_message_preview,
            created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
          })),
        },
        null,
        2
      )
    );
    return EXIT_OK;
  }

  console.log(`Recent agent routing decisions (total ${result.total}):`);
  console.log('');
  for (const r of result.runs) {
    const ts = r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at;
    const preview =
      r.user_message_preview.length > 60
        ? r.user_message_preview.slice(0, 57) + '…'
        : r.user_message_preview;
    console.log(
      `  ${ts}  ${r.decision.padEnd(20)}  ${r.agent_slug.padEnd(22)}  conf ${r.confidence.toFixed(2)}  ${r.latency_ms}ms`
    );
    console.log(`    ${preview}`);
    console.log(`    ${r.reason}`);
    console.log('');
  }

  // Bonus: top routed agents in the last 24h, so the operator can see what
  // their team is leaning on. Free info, separate from the paginated runs.
  const top = await topRoutedAgents(24, 5);
  if (top.length > 0) {
    console.log('Top routed agents (last 24h):');
    for (const t of top) {
      console.log(`  ${t.slug.padEnd(22)} ${t.count} runs`);
    }
  }
  return EXIT_OK;
}
