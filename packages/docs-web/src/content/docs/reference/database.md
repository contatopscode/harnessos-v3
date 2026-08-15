---
title: Database
description: Database setup, schema overview, and migration guide for SQLite and PostgreSQL backends.
category: reference
area: database
audience: [developer, operator]
status: current
sidebar:
  order: 5
---

Archon supports two database backends: **SQLite** (default, zero setup) and **PostgreSQL** (optional, for cloud/advanced deployments). The database backend is selected automatically based on whether the `DATABASE_URL` environment variable is set.

## SQLite (Default - No Setup Required)

Simply **omit the `DATABASE_URL` variable** from your `.env` file. The app will automatically:
- Create a SQLite database at `~/.archon/archon.db`
- Initialize the schema on first run
- Use this database for all operations

**Pros:**
- Zero configuration required
- No external database needed
- Perfect for single-user CLI usage

**Cons:**
- Not suitable for multi-container deployments
- No network access (CLI and server can't share database across different hosts)

## Remote PostgreSQL (Supabase, Neon, etc.)

Set your remote connection string in `.env`:

```ini
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

**No manual migration step is required.** On startup, the Postgres adapter applies the bundled `migrations/000_combined.sql` inside an advisory-lock transaction. The SQL is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so both fresh installs and version upgrades converge automatically — including new tables and columns added in later releases.

If schema application fails (permissions, syntax error, network), the process aborts at the first DB operation with the underlying Postgres error logged at `db.pg_schema_init_failed`.

## Local PostgreSQL via Docker

Use the `with-db` Docker Compose profile for automatic PostgreSQL setup.

Set in `.env`:

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

The app converges the schema automatically on startup (see the note above for remote Postgres). Both fresh installs and upgrades are handled by the same path; the `docker-entrypoint-initdb.d` mount in `docker-compose.yml` is now redundant and is retained only as a no-op on fresh volumes.

## Verifying the Database

**Health check:**
```bash
curl http://localhost:3090/health/db
# Expected: {"status":"ok","database":"connected"}
```

**List tables (PostgreSQL):**
```bash
psql $DATABASE_URL -c "\dt"
```

## Schema Overview

The database has 20 tables, all prefixed with `remote_agent_`:

1. **`remote_agent_codebases`** - Repository metadata
   - Commands stored as JSONB: `{command_name: {path, description}}`
   - AI assistant type per codebase
   - Default working directory
   - `kind` (`'repo'` | `'folder'`, default `'repo'`) discriminates git-repo projects from non-git folder projects (which run in place, no worktree)
   - Nullable detected default branch, used as branch context for workspace sync when available

2. **`remote_agent_conversations`** - Platform conversation tracking
   - Platform type + conversation ID (unique constraint)
   - Linked to codebase via foreign key
   - AI assistant type locked at creation
   - Nullable `user_id` records the first user who created the conversation (first-user-wins; later replies in the same thread are attributed on the workflow_run, not here)

3. **`remote_agent_sessions`** - AI session management
   - Active session flag (one per conversation)
   - Session ID for resume capability
   - Metadata JSONB for command context

4. **`remote_agent_isolation_environments`** - Worktree isolation
   - Tracks git worktrees per issue/PR
   - Enables worktree sharing between linked issues and PRs
   - Nullable `created_by_user_id` preserves the original creator across re-activation (the `ON CONFLICT DO UPDATE` clause intentionally omits this column)

5. **`remote_agent_workflow_runs`** - Workflow execution tracking
   - Tracks active workflows per conversation
   - Locks concurrent execution per `working_path`: a second dispatch on a path with an active run (status `pending`/`running`/`paused`) is auto-cancelled with an actionable message. Stale `pending` rows older than 5 minutes are treated as orphaned and ignored.
   - Stores workflow state, step progress, and parent conversation linkage
   - Nullable `user_id` records which user triggered the run

6. **`remote_agent_workflow_events`** - Step-level workflow event log
   - Records step transitions, artifacts, and errors per workflow run
   - Lean UI-relevant events (verbose logs stored in JSONL files)
   - Enables workflow run detail views and debugging
   - Indexed on `created_at` (`idx_workflow_events_created_at`) for the dashboard event poller's cross-run tail. On PostgreSQL an `AFTER INSERT` trigger (`archon_workflow_event_notify`) calls `pg_notify('archon_dashboard_event', …)` so runs started out of process (the `archon` CLI / `--detach`) stream live to the console; on SQLite the poller picks them up within its interval. The trigger is Postgres-only and best-effort (a role without `CREATE TRIGGER` degrades to poll-only, not a boot failure).

7. **`remote_agent_messages`** - Conversation message history
   - Persists user and assistant messages with timestamps
   - Stores tool call metadata (name, input, duration) in JSONB
   - Enables message history in Web UI across page refreshes
   - Nullable `user_id` on user-role rows (NULL on assistant rows since the AI isn't a user)

8. **`remote_agent_codebase_env_vars`** - Per-project env vars for workflow execution
   - Key-value pairs scoped to a codebase
   - Injected into Claude SDK subprocess environment at execution time
   - Managed via Web UI Settings panel; `env:` in `.archon/config.yaml` for CLI users

9. **`remote_agent_users`** - Archon-internal user identity
   - One row per human (or bot) across all platforms
   - Created lazily on first sight by any chat/forge adapter
   - `display_name` and `email` are nullable until enrichment succeeds
   - `role` (`VARCHAR`, default `'admin'`) is the identity seam for future per-resource scoping; everyone is `admin` today (visibility stays open), `'member'` is reserved

10. **`remote_agent_user_identities`** - Platform-to-Archon user mapping
    - One row per `(platform, platform_user_id)` pair — Slack U-id, Telegram chat id, Discord snowflake, GitHub login, the `web` Better Auth user id, etc.
    - `UNIQUE(platform, platform_user_id)` enforces deduplication at the DB level
    - References `users.id` with `ON DELETE CASCADE` (deleting a user removes their identity mappings)
    - All user_id FKs on the four tables above use `ON DELETE SET NULL` so future user deletion never destructively cascades

11. **`remote_agent_workflow_node_sessions`** - Per-node provider session IDs persisted across workflow re-runs
    - Opt-in via `persist_session`; keyed by `(workflow_name, node_id, scope_key, provider)`
    - `scope_key` is typically the conversation UUID

12. **`remote_agent_user_github_tokens`** - Per-user GitHub device-flow tokens
    - Encrypted at rest (AES-256-GCM); one row per Archon user (`UNIQUE(user_id)`), cascades on user deletion
    - Numeric `github_user_id` anchors the commit no-reply email

13. **`remote_agent_user_provider_keys`** - Per-user AI-provider credentials (API key or OAuth subscription blob)
    - Encrypted at rest (AES-256-GCM, same `TOKEN_ENCRYPTION_KEY`); one row per `(user_id, provider)`, cascades on user deletion
    - `kind` records `api_key` vs `oauth`; resolved + injected into the user's runs/chat env at execution time
    - `provider` holds **vendor-canonical** credential ids (`anthropic`, `openai`, `github-copilot`, plus Pi backend vendors) — legacy `claude`/`codex`/`copilot` rows are renamed by an idempotent startup data fix (the vendor row wins when both exist)

14. **`remote_agent_user_ai_prefs`** - Per-user AI preferences (personal model tiers, `@custom` aliases, default assistant + default chat model)
    - NON-encrypted (model names aren't secrets); one row per user (`UNIQUE(user_id)`), cascades on user deletion
    - `tiers` / `aliases` are JSON-as-TEXT; folded into model resolution as the highest-precedence layer. `default_model` pins the user's direct-chat model (written atomically with `default_provider`; applied only when the effective chat provider matches — workflows still resolve the `large` tier). Resolution follows the **acting user**: workflow runs use the run starter; chat turns use the message **sender** (the conversation creator's row is only a fallback when no sender identity resolves)
    - Editable via the console "Just me" scope, `archon ai … --scope user`, or `/api/auth/me/ai-prefs*`

15–18. **`remote_agent_auth_user` / `remote_agent_auth_session` / `remote_agent_auth_account` / `remote_agent_auth_verification`** - Better Auth tables for opt-in web login
    - **PostgreSQL only.** Always created on Postgres via the idempotent schema apply, but populated only when web auth is enabled (`DATABASE_URL` + `BETTER_AUTH_SECRET`)
    - Owned and shaped by Better Auth (text ids, camelCase columns); Archon never queries them directly — a session maps to the canonical `users` row via `user_identities('web', <betterAuthUserId>)`

19. **`remote_agent_agents`** - Installed agents (bundled + local + installed from future registry)
    - `UNIQUE(slug)` — one row per agent; upsert on conflict replaces the row, preserving `installed_at` for "first install" vs "refresh" distinction
    - `source` is one of `'bundled'` (ships with the app), `'local'` (per-project override), or `'installed'` (from a future registry)
    - JSON-as-TEXT columns (`tags_json`, `keywords_json`, `examples_json`, `allowed_tools_json`, `definition_json`) are parsed in the store layer for SQLite/Postgres parity
    - Seeded on every server boot from the 4 bundled YAMLs in `packages/core/src/agents/defaults/` (idempotent — refreshes on update)

20. **`remote_agent_agent_runs`** - Append-only audit of every routing decision
    - One row per non-slash chat message that goes through the orchestrator, plus rows from `archon agent run` simulations
    - `decision` is one of `'override'` / `'codebase_default'` / `'auto_heuristic'` / `'auto_llm'` / `'default_fallback'` (CHECK-constrained)
    - `confidence` is `0.0–1.0` (the router's score for the winning agent)
    - `agent_slug` is **NOT a FK** — uninstalled agents still appear in history (same posture as `remote_agent_workflow_events.workflow_name`)
    - Read by the `/console/agents` audit panel and `archon agent runs` CLI
    - Never written on the error path — only after a successful chat turn

21. **`remote_agent_memories`** - Persistent facts the orchestrator carries across sessions (path B — Memory + RAG)
    - `scope` is one of `'user'` / `'agent'` / `'project'` / `'conversation'` (CHECK-constrained)
    - `kind` is one of `'note'` / `'preference'` / `'fact'` / `'project_context'` / `'feedback'` (CHECK-constrained)
    - `source` is one of `'chat'` (orchestrator detected a "lembre que…" signal) / `'manual'` (CLI/UI/API) / `'imported'` (future bulk-import)
    - `scope_id` is nullable — for `scope='user'` it stays NULL; for the others it points at the agent slug / codebase id / conversation id
    - `use_count` and `last_used_at` are bumped best-effort on every recall (not in the same transaction as the FTS query)
    - Backed by `remote_agent_memories_fts` (FTS5 virtual table) + 3 triggers (`memories_ai` after insert, `memories_ad` after delete, `memories_au` after update) that keep the index in sync without a separate write path
    - Read by `buildMemoryPromptSection` on every chat turn (top-5 hits) and by the `/console/memory` page + `archon memory list/search` CLI
    - PERSISTED on the success path of every chat turn (after the AI responds) when `detectMemorySignal` matches; failures are logged but never break the chat

22. **`remote_agent_memories_fts`** - FTS5 virtual table over `remote_agent_memories.content`
    - Tokenizer: `unicode61` with `remove_diacritics 2` (handles PT-BR accents: `é` ↔ `e`, `ã` ↔ `a`)
    - Query semantics: **OR** with quote-escaped tokens (NOT FTS5's default AND) so natural language queries with stopwords work
    - Rank: bm25, converted to 0-1 confidence via min/max normalization
    - Updated automatically by the 3 triggers on `remote_agent_memories` — no separate write path

## Migration List

| Migration | Description |
|-----------|-------------|
| `000_combined.sql` | Combined initial schema (use for fresh installs) |
| `001_initial_schema.sql` | Initial schema (codebases, conversations, sessions) |
| `002_command_templates.sql` | Command templates table |
| `003_add_worktree.sql` | Add worktree columns |
| `004_worktree_sharing.sql` | Worktree sharing support |
| `005_isolation_abstraction.sql` | Isolation abstraction layer |
| `006_isolation_environments.sql` | Isolation environments table |
| `007_drop_legacy_columns.sql` | Drop legacy worktree columns |
| `008_workflow_runs.sql` | Workflow runs table |
| `009_workflow_last_activity.sql` | Workflow last activity tracking |
| `010_immutable_sessions.sql` | Immutable session model |
| `011_partial_unique_constraint.sql` | Partial unique constraint |
| `012_workflow_events.sql` | Workflow events table |
| `013_conversation_titles.sql` | Conversation titles |
| `014_message_history.sql` | Message history table |
| `015_background_dispatch.sql` | Background dispatch support |
| `016_session_ended_reason.sql` | Session ended reason field |
| `017_drop_command_templates.sql` | Drop command templates table |
| `018_fix_workflow_status_default.sql` | Fix workflow status default value |
| `019_workflow_resume_path.sql` | Workflow resume path support |
| `020_codebase_env_vars.sql` | Per-project environment variables |
| `021_add_allow_env_keys_to_codebases.sql` | Allow-listed env keys per codebase |
| `022_workflow_node_sessions.sql` | Per-node provider session persistence |
| `023_add_default_branch_to_codebases.sql` | Detected default branch on codebases |
| `024_agents.sql` | Agent system — `remote_agent_agents` (UNIQUE slug) + `remote_agent_agent_runs` (append-only audit). 4 bundled agents seed on every server boot. |
| `025_memory.sql` | Memory + RAG — `remote_agent_memories` (4 scopes × 5 kinds) + `remote_agent_memories_fts` (FTS5 virtual table, `unicode61` with `remove_diacritics 2`) + 3 triggers (`memories_ai`/`ad`/`au`) that keep the FTS index in sync. Used by `buildMemoryPromptSection` on every chat turn and the `/console/memory` page. |

> The `remote_agent_codebases.kind` column (project `'repo'` | `'folder'` discriminator, originally from migration 024's precursor changes), the `remote_agent_users.role` column, and the four `remote_agent_auth_*` Better Auth tables (opt-in web login) are applied inline in `000_combined.sql` rather than as numbered migrations, and converge on startup via the idempotent schema apply.

> **SQLite parity gotcha** — the SQLite adapter's `createSchema()` is hardcoded inline in `packages/core/src/db/adapters/sqlite.ts:396-643` and does NOT auto-read `000_combined.sql`. New tables (like `remote_agent_agents` / `remote_agent_agent_runs`) must be added in **three** places: (a) the new `migrations/NNN_*.sql` file, (b) `migrations/000_combined.sql` for fresh installs, and (c) the SQLite adapter's `createSchema()` with SQLite-flavoured columns (`lower(hex(randomblob(16)))` instead of `gen_random_uuid()`, `TEXT` instead of `JSONB` / `TIMESTAMPTZ`). Forgetting (c) surfaces as `no such table: <name>` at runtime even when the schema "looks" applied.
