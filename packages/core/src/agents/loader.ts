/**
 * Agent loader — discovers and parses `.archon/agents/*.yaml` files.
 *
 * Scopes (precedence lowest → highest, same-named slugs override):
 *   1. `bundled` — embedded in the package at
 *                  `packages/core/src/agents/defaults/*.yaml`.
 *                  Always available; ships with the app.
 *   2. `global`  — `~/.archon/agents/*.yaml`. Applies to every repo on the
 *                  machine; the user installs once and forgets.
 *   3. `local`   — `<cwd>/.archon/agents/*.yaml`. Per-project; the canonical
 *                  place for repo-specific personas.
 *
 * Design notes:
 *  - All fs access is wrapped in named functions (`fsReadFile`,
 *    `fsReaddir`, `fsStat`) so tests can intercept them via
 *    `mock.module('./loader', ...)` without polluting the global `fs/promises`
 *    cache. (See the mock-pollution warning in the project AGENTS.md.)
 *  - YAML is parsed with `Bun.YAML.parse` (native, no extra dep) — same
 *    pattern as `packages/workflows/src/loader.ts`.
 *  - A single bad file is reported in `errors` and skipped. The loader never
 *    throws for a parse/validation error so the rest of the agents still load.
 *    Permission/IO errors are reported at WARN and skipped (not surfaced as
 *    schema errors).
 *  - Slug collision across scopes: the higher-precedence scope wins; the
 *    losing entry is reported in `overrides` so the CLI/UI can show
 *    "your local foo.yaml is overriding the bundled foo".
 */
import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { z } from '@hono/zod-openapi';

import { type AgentDefinition, type AgentSource, agentDefinitionSchema } from '../schemas/agent';
import { getArchonHome } from '@archon/paths';
import { createLogger } from '@archon/paths';

// ---------------------------------------------------------------------------
// IO wrappers — overridable per test without touching the global fs cache.
// ---------------------------------------------------------------------------

export async function fsReadFile(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

export async function fsReaddir(path: string): Promise<string[]> {
  return readdir(path);
}

export async function fsStat(path: string): Promise<{ isFile: () => boolean }> {
  return stat(path);
}

// ---------------------------------------------------------------------------
// Logger (lazy so test mocks can intercept createLogger).
// ---------------------------------------------------------------------------

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agents.loader');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * A fully-loaded agent ready to be persisted to the `agents` table. Mirrors
 * `agentRowSchema` minus the DB-assigned fields (id, installed_at, updated_at).
 * Bundled and global agents carry their raw YAML in `definitionYaml`; local
 * agents also do, but `sourcePath` points at the file on disk so the user can
 * `code $sourcePath` it.
 */
export interface LoadedAgent {
  definition: AgentDefinition;
  source: AgentSource;
  sourcePath: string;
  definitionYaml: string;
}

export interface AgentLoadError {
  sourcePath: string;
  reason: string;
  issues?: z.ZodIssue[];
}

export interface AgentOverride {
  slug: string;
  winningSource: AgentSource;
  overriddenSource: AgentSource;
}

export interface AgentLoadResult {
  agents: Map<string, LoadedAgent>;
  errors: AgentLoadError[];
  overrides: AgentOverride[];
}

// ---------------------------------------------------------------------------
// Bundled agent directory — relative to this file. Resolved once at module
// load via import.meta.url so dev mode (source TS) and bundled mode (.js in
// dist) both find the right path.
//
// We use a getter (not a top-level constant) because the resolver touches
// `import.meta.url` which can blow up at import time in some test runners.
// Tests can override the directory via `setBundledDirForTests`.
// ---------------------------------------------------------------------------

function defaultBundledDir(): string {
  // src/agents/loader.ts → src/agents/defaults/
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, 'defaults');
}

let bundledDirOverride: string | null = null;
export function setBundledDirForTests(dir: string | null): void {
  bundledDirOverride = dir;
}
function getBundledDir(): string {
  return bundledDirOverride ?? defaultBundledDir();
}

// ---------------------------------------------------------------------------
// YAML parsing + validation
// ---------------------------------------------------------------------------

function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

/**
 * Parse a single YAML file's content and validate against the agent
 * definition schema. Throws nothing — returns either a LoadedAgent or an
 * AgentLoadError.
 */
function parseAgentContent(
  content: string,
  sourcePath: string,
  source: AgentSource
): { ok: true; agent: LoadedAgent } | { ok: false; error: AgentLoadError } {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    return {
      ok: false,
      error: {
        sourcePath,
        reason: `YAML parse error: ${(err as Error).message}`,
      },
    };
  }
  const parsed = agentDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        sourcePath,
        reason: `schema validation failed (${parsed.error.issues.length} issue${parsed.error.issues.length === 1 ? '' : 's'})`,
        issues: parsed.error.issues,
      },
    };
  }
  return {
    ok: true,
    agent: {
      definition: parsed.data,
      source,
      sourcePath,
      definitionYaml: content,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-scope loaders
// ---------------------------------------------------------------------------

const AGENT_FILE_GLOB = /\.ya?ml$/u;

async function loadDir(
  dir: string,
  source: AgentSource
): Promise<{ agents: LoadedAgent[]; errors: AgentLoadError[] }> {
  const out: LoadedAgent[] = [];
  const errs: AgentLoadError[] = [];

  let entries: string[];
  try {
    entries = await fsReaddir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { agents: out, errors: errs };
    // EACCES/EPERM/EIO: surface at warn, don't fail the whole load
    getLog().warn({ err, dir, code }, 'agents.loader.directory_read_error');
    return {
      agents: out,
      errors: [
        {
          sourcePath: dir,
          reason: `cannot read directory (${code ?? 'unknown'}): ${(err as Error).message}`,
        },
      ],
    };
  }

  for (const entry of entries) {
    if (!AGENT_FILE_GLOB.test(entry)) continue;
    const fullPath = join(dir, entry);
    try {
      const s = await fsStat(fullPath);
      if (!s.isFile()) continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      errs.push({ sourcePath: fullPath, reason: `stat failed (${code ?? 'unknown'})` });
      continue;
    }
    let content: string;
    try {
      content = await fsReadFile(fullPath);
    } catch (err) {
      errs.push({
        sourcePath: fullPath,
        reason: `read failed: ${(err as Error).message}`,
      });
      continue;
    }
    const result = parseAgentContent(content, fullPath, source);
    if (result.ok) out.push(result.agent);
    else errs.push(result.error);
  }

  return { agents: out, errors: errs };
}

/**
 * Load the bundled default agents (ship with the app).
 *
 * In a real install these will be the code-reviewer / test-writer /
 * bug-investigator personas. We don't fail the load if the directory is
 * missing (a slim build might strip them) — we log a debug and return [].
 */
export async function loadBundledAgents(): Promise<{
  agents: LoadedAgent[];
  errors: AgentLoadError[];
}> {
  const dir = getBundledDir();
  return loadDir(dir, 'bundled');
}

/**
 * Load agents from the user's global directory `~/.archon/agents/*.yaml`.
 * Applies to every repo on the machine. Optional directory.
 */
export async function loadGlobalAgents(): Promise<{
  agents: LoadedAgent[];
  errors: AgentLoadError[];
}> {
  const dir = join(getArchonHome(), 'agents');
  return loadDir(dir, 'installed');
}

/**
 * Load agents from a single codebase's local directory
 * `<cwd>/.archon/agents/*.yaml`. Pass `cwd` from the registered codebase
 * root, not the worktree (so the agent follows the user's working copy).
 */
export async function loadLocalAgents(
  cwd: string
): Promise<{ agents: LoadedAgent[]; errors: AgentLoadError[] }> {
  const dir = join(cwd, '.archon', 'agents');
  return loadDir(dir, 'local');
}

// ---------------------------------------------------------------------------
// Public entry: merge all scopes with precedence.
// ---------------------------------------------------------------------------

/**
 * Load every agent visible to this codebase.
 *
 *   bundled  (lowest precedence)
 *     ↓ overridden by
 *   global   (`~/.archon/agents/`)
 *     ↓ overridden by
 *   local    (`<cwd>/.archon/agents/`)   (highest precedence)
 *
 * If `cwd` is omitted, bundled + global are returned (the server-startup
 * case where no codebase is active yet).
 */
export async function loadAllAgents(cwd?: string): Promise<AgentLoadResult> {
  const errors: AgentLoadError[] = [];
  const overrides: AgentOverride[] = [];
  const agents = new Map<string, LoadedAgent>();

  // Bundled
  const bundled = await loadBundledAgents();
  errors.push(...bundled.errors);
  for (const a of bundled.agents) agents.set(a.definition.slug, a);

  // Global
  const global = await loadGlobalAgents();
  errors.push(...global.errors);
  for (const a of global.agents) {
    const existing = agents.get(a.definition.slug);
    if (existing) {
      overrides.push({
        slug: a.definition.slug,
        winningSource: a.source,
        overriddenSource: existing.source,
      });
    }
    agents.set(a.definition.slug, a);
  }

  // Local (if cwd provided)
  if (cwd) {
    const local = await loadLocalAgents(cwd);
    errors.push(...local.errors);
    for (const a of local.agents) {
      const existing = agents.get(a.definition.slug);
      if (existing) {
        overrides.push({
          slug: a.definition.slug,
          winningSource: a.source,
          overriddenSource: existing.source,
        });
      }
      agents.set(a.definition.slug, a);
    }
  }

  return { agents, errors, overrides };
}

/**
 * Load a single agent from a YAML file path. Used by `archon agent install <path>`.
 */
export async function loadAgentFromFile(filePath: string): Promise<{
  agent?: LoadedAgent;
  error?: AgentLoadError;
}> {
  let content: string;
  try {
    content = await fsReadFile(filePath);
  } catch (err) {
    return {
      error: {
        sourcePath: filePath,
        reason: `read failed: ${(err as Error).message}`,
      },
    };
  }
  const result = parseAgentContent(content, filePath, 'local');
  if (!result.ok) return { error: result.error };
  return { agent: result.agent };
}

/**
 * Parse a YAML string into an agent definition. Used by tests and the
 * `archon agent validate <file>` command.
 */
export function parseAgentYaml(content: string): {
  agent?: AgentDefinition;
  error?: AgentLoadError;
} {
  const result = parseAgentContent(content, '<inline>', 'local');
  if (!result.ok) return { error: result.error };
  return { agent: result.agent.definition };
}
