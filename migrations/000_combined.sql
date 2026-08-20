-- Remote Coding Agent - Combined Schema
-- Version: Combined (final state after migrations 001-020)
-- Description: Complete database schema (idempotent - safe to run multiple times)
--
-- 14 Tables (+ the remote_agent_auth_* Better Auth tables, listed inline below):
--   1. remote_agent_codebases
--   1b. remote_agent_codebase_env_vars
--   1c. remote_agent_users
--   1d. remote_agent_user_identities
--   2. remote_agent_conversations
--   3. remote_agent_sessions
--   4. remote_agent_isolation_environments
--   5. remote_agent_workflow_runs
--   6. remote_agent_workflow_events
--   6b. remote_agent_workflow_node_sessions
--   7. remote_agent_messages
--   8. remote_agent_user_github_tokens
--   9. remote_agent_user_provider_keys
--   10. remote_agent_user_ai_prefs
--
-- Dropped tables (via migrations):
--   - remote_agent_command_templates (017)
--
-- Dropped columns (via migrations):
--   - conversations.worktree_path (007)
--   - conversations.isolation_env_id_legacy (007)
--   - conversations.isolation_provider (007)

-- ============================================================================
-- Table 1: Codebases
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  repository_url VARCHAR(500),
  default_cwd VARCHAR(500) NOT NULL,
  default_branch VARCHAR(255),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  kind VARCHAR(10) NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo', 'folder')),
  allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE,
  commands JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_codebases IS
  'Repository metadata: name, URL, working directory, default branch, AI assistant type, and command paths (JSONB)';

-- ============================================================================
-- Table 1b: Codebase Env Vars
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(codebase_id, key)
);

CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id
  ON remote_agent_codebase_env_vars(codebase_id);

COMMENT ON TABLE remote_agent_codebase_env_vars IS
  'Per-project env vars merged into Options.env on Claude SDK calls. Managed via Web UI or config.';

-- ============================================================================
-- Table 1c: Users (Archon identity, platform-agnostic)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(255),
  email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_users IS
  'Archon-internal user identity. Created on first sight by any adapter; populated via per-platform user-info lookups.';

-- ============================================================================
-- Table 1d: User Identities (per-platform mapping → users.id)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  platform VARCHAR(32) NOT NULL,
  platform_user_id VARCHAR(255) NOT NULL,
  platform_display_name VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON remote_agent_user_identities(user_id);

COMMENT ON TABLE remote_agent_user_identities IS
  'Maps platform-native user IDs (Slack U-ids, Telegram chat ids, GitHub logins, Discord snowflakes) to Archon user UUIDs.';

-- ============================================================================
-- Table 2: Conversations
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_type VARCHAR(20) NOT NULL,
  platform_conversation_id VARCHAR(255) NOT NULL,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  cwd VARCHAR(500),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  isolation_env_id UUID,  -- FK added after isolation_environments table exists
  title VARCHAR(255),
  deleted_at TIMESTAMP WITH TIME ZONE,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform_type, platform_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_conversations_codebase
  ON remote_agent_conversations(codebase_id);
CREATE INDEX IF NOT EXISTS idx_conversations_hidden
  ON remote_agent_conversations(hidden);
CREATE INDEX IF NOT EXISTS idx_conversations_codebase
  ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;

COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';

-- ============================================================================
-- Table 3: Sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  ai_assistant_type VARCHAR(20) NOT NULL,
  assistant_session_id VARCHAR(255),
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb,
  parent_session_id UUID REFERENCES remote_agent_sessions(id),
  transition_reason TEXT,
  ended_reason TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_conversation
  ON remote_agent_sessions(conversation_id, active);
CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_codebase
  ON remote_agent_sessions(codebase_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON remote_agent_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
  ON remote_agent_sessions(conversation_id, started_at DESC);

COMMENT ON COLUMN remote_agent_sessions.parent_session_id IS
  'Links to the previous session in this conversation (for audit trail)';
COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
COMMENT ON COLUMN remote_agent_sessions.ended_reason IS
  'Why this session was deactivated: reset-requested, cwd-changed, conversation-closed, etc.';

-- ============================================================================
-- Table 4: Isolation Environments
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,

  -- Workflow identification (what work this is for)
  workflow_type         TEXT NOT NULL,        -- 'issue', 'pr', 'review', 'thread', 'task'
  workflow_id           TEXT NOT NULL,        -- '42', 'pr-99', 'thread-abc123'

  -- Implementation details
  provider              TEXT NOT NULL DEFAULT 'worktree',
  working_path          TEXT NOT NULL,        -- Actual filesystem path
  branch_name           TEXT NOT NULL,        -- Git branch name

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'active',  -- 'active', 'destroyed'
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_platform   TEXT,                 -- 'github', 'slack', etc.

  -- Cross-reference metadata (for linking)
  metadata              JSONB DEFAULT '{}'
);

-- Partial unique index: only active environments need uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_isolation_env_codebase
  ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX IF NOT EXISTS idx_isolation_env_status
  ON remote_agent_isolation_environments(status);
CREATE INDEX IF NOT EXISTS idx_isolation_env_workflow
  ON remote_agent_isolation_environments(workflow_type, workflow_id);

-- Add FK from conversations to isolation_environments (deferred to avoid circular dependency)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id
  ON remote_agent_conversations(isolation_env_id);

COMMENT ON TABLE remote_agent_isolation_environments IS
  'Work-centric isolated environments with independent lifecycle';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_type IS
  'Type of work: issue, pr, review, thread, task';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_id IS
  'Identifier for the work (issue number, PR number, thread hash, etc.)';

-- ============================================================================
-- Table 5: Workflow Runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  current_step_index INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled, paused
  user_message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  parent_conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  working_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
  ON remote_agent_workflow_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON remote_agent_workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv
  ON remote_agent_workflow_runs(parent_conversation_id);

-- Partial index for efficient staleness queries on running workflows
CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
  ON remote_agent_workflow_runs(last_activity_at)
  WHERE status = 'running';

COMMENT ON TABLE remote_agent_workflow_runs IS
  'Tracks workflow execution state for resumption and observability';

-- ============================================================================
-- Table 6: Workflow Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  step_index INTEGER,
  step_name VARCHAR(255),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id
  ON remote_agent_workflow_events(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type
  ON remote_agent_workflow_events(event_type);
-- Global created_at index for the dashboard event poller's cross-run tail
-- (WHERE created_at >= $1 ORDER BY created_at ASC).
CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at
  ON remote_agent_workflow_events(created_at);

COMMENT ON TABLE remote_agent_workflow_events IS
  'Lean UI-relevant workflow events for observability (step transitions, artifacts, errors)';

-- ============================================================================
-- Workflow node sessions (persist_session opt-in across re-runs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_node_sessions (
  workflow_name VARCHAR(255) NOT NULL,
  node_id VARCHAR(255) NOT NULL,
  scope_key TEXT NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id TEXT NOT NULL,
  last_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (workflow_name, node_id, scope_key, provider)
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_scope
  ON remote_agent_workflow_node_sessions(scope_key);
CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_workflow
  ON remote_agent_workflow_node_sessions(workflow_name);

COMMENT ON TABLE remote_agent_workflow_node_sessions IS
  'Per-node provider session IDs persisted across workflow re-runs. Keyed by (workflow, node, scope, provider). Scope is typically conversation UUID. No cascade on conversation delete (soft delete + never-reused UUID = harmless orphans); a future hard-delete path must delete by scope_key.';

-- ============================================================================
-- Table 7: Messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON remote_agent_messages(conversation_id, created_at ASC);

-- ============================================================================
-- Cleanup: Drop legacy objects from older schemas
-- ============================================================================

-- Drop command_templates table (replaced by file-based commands in .archon/commands)
DROP TABLE IF EXISTS remote_agent_command_templates;
DROP INDEX IF EXISTS idx_remote_agent_command_templates_name;

-- Drop legacy columns from conversations (if upgrading from older schema)
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS worktree_path;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_env_id_legacy;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_provider;
DROP INDEX IF EXISTS idx_conversations_isolation;

-- Drop legacy constraint from isolation_environments (if upgrading from older schema)
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

-- ============================================================================
-- Idempotent ALTER statements for upgrading existing databases
-- (These are no-ops on fresh installs since columns exist in CREATE TABLE above)
-- ============================================================================

-- From migration 006: isolation_env_id + last_activity_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 009: last_activity_at on workflow_runs
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 010: parent_session_id + transition_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES remote_agent_sessions(id);
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS transition_reason TEXT;

-- From migration 013: title + deleted_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- From migration 015: parent_conversation_id + hidden
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_conversation_id UUID
    REFERENCES remote_agent_conversations(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;

-- From migration 016: ended_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;

-- From migration 021: allow_env_keys on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE;

-- From migration 023: detected default branch on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch VARCHAR(255);

-- From migration 024: project kind discriminator ('repo' | 'folder').
-- Folder projects are non-git workspaces (multi-repo roots or plain ops folders)
-- that run in place with named artifact/log storage under _folder/<slug>/.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'repo';

-- User identity foreign keys (nullable on the four primary tables).
-- All FKs use ON DELETE SET NULL so future user deletion never cascades destructively.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_messages
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_isolation_environments
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON remote_agent_conversations(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id
  ON remote_agent_workflow_runs(user_id) WHERE user_id IS NOT NULL;

-- From PR-C: per-user GitHub user-to-server tokens (device flow), encrypted at rest.
-- One row per Archon user; cascades on user deletion. github_user_id is the
-- numeric anchor for the commit no-reply email (survives username changes).
CREATE TABLE IF NOT EXISTS remote_agent_user_github_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login VARCHAR(255) NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  access_token_expires_at TIMESTAMP WITH TIME ZONE,
  refresh_token_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Phase 2: per-user AI-provider credentials (BYO API key + subscription login),
-- encrypted at rest with the existing token-crypto key. One row per
-- (user_id, provider); cascades on user deletion. Exactly one of
-- api_key_encrypted / oauth_creds_encrypted is populated per row; `kind`
-- records which. Gated on TOKEN_ENCRYPTION_KEY at the application layer.
CREATE TABLE IF NOT EXISTS remote_agent_user_provider_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  api_key_encrypted TEXT,
  oauth_creds_encrypted TEXT,
  label VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- #1955: credential rows are vendor-keyed (claude→anthropic, codex→openai,
-- copilot→github-copilot) so one credential can serve every agent that
-- consumes the vendor. Idempotent data fix: where both a legacy and a vendor
-- row exist for the same user, the vendor row wins (rare — requires having
-- connected both ids pre-rename); then legacy rows are renamed in place.
-- Tested on SQLite (adapters/sqlite.test.ts covers rename, conflict, and
-- idempotency); the Postgres DML below is the same statements but is NOT
-- covered by an automated test — verified manually on the multi-user smoke.
-- Survivable either way: reads normalize legacy ids (normalizeCredentialVendor).
DELETE FROM remote_agent_user_provider_keys
WHERE provider IN ('claude', 'codex', 'copilot')
  AND EXISTS (
    SELECT 1 FROM remote_agent_user_provider_keys v
    WHERE v.user_id = remote_agent_user_provider_keys.user_id
      AND v.provider = CASE remote_agent_user_provider_keys.provider
        WHEN 'claude' THEN 'anthropic'
        WHEN 'codex' THEN 'openai'
        WHEN 'copilot' THEN 'github-copilot'
      END
  );
UPDATE remote_agent_user_provider_keys SET provider = 'anthropic' WHERE provider = 'claude';
UPDATE remote_agent_user_provider_keys SET provider = 'openai' WHERE provider = 'codex';
UPDATE remote_agent_user_provider_keys SET provider = 'github-copilot' WHERE provider = 'copilot';

-- Phase 3: per-user AI preferences (model tiers, @custom aliases, default
-- assistant). NON-encrypted — model names are not secrets (mirrors
-- codebase_env_vars, not the provider-key store). One row per user; cascades
-- on user deletion. `tiers` / `aliases` are JSON-as-TEXT (parsed in the
-- store layer so SQLite and Postgres behave identically).
CREATE TABLE IF NOT EXISTS remote_agent_user_ai_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  tiers TEXT,
  aliases TEXT,
  default_provider VARCHAR(64),
  default_model VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- #1998: per-user default CHAT model, written atomically with
-- default_provider (a model pin is only meaningful for the provider it was
-- set with). Idempotent upgrade for installs that created the table before
-- this column existed.
ALTER TABLE remote_agent_user_ai_prefs
  ADD COLUMN IF NOT EXISTS default_model VARCHAR(255);

-- ============================================================================
-- Web auth (opt-in): role on the canonical user + Better Auth tables
-- ============================================================================
--
-- `role` is the durable identity seam: everyone defaults to 'admin' for now;
-- 'member' is reserved for future per-resource scoping. Visibility stays open.
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'admin';

-- Better Auth tables (PostgreSQL only). Generated by `@better-auth/cli generate`
-- against packages/server/src/auth/instance.ts (modelName-renamed to the
-- `remote_agent_auth_*` prefix), then made idempotent with IF NOT EXISTS so the
-- bundled-schema auto-apply on startup converges. Better Auth owns these tables
-- and the column shape (text ids, camelCase columns) — Archon never queries them
-- directly; a session is mapped to the canonical remote_agent_users row via
-- user_identities('web', <betterAuthUserId>). Always created on Postgres (the
-- IF NOT EXISTS apply runs on every boot); populated only when web auth is
-- enabled (BETTER_AUTH_SECRET + DATABASE_URL), harmless empty tables otherwise.
CREATE TABLE IF NOT EXISTS remote_agent_auth_user (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_session (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES remote_agent_auth_user ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_account (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES remote_agent_auth_user ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_verification (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ============================================================================
-- Auth invite allowlist (migration 026)
-- ============================================================================
--
-- Durable side of the signup allowlist. Pairs with
-- ARCHON_AUTH_ALLOWED_EMAILS (which stays as a static env baseline
-- for pre-seeding admins). A signup attempt passes the gate when
--   (a) the email is in ARCHON_AUTH_ALLOWED_EMAILS, OR
--   (b) the email has a non-revoked, non-expired, non-accepted
--       invite row (Better Auth's user.create.before hook stamps
--       accepted_at on the matching invite when the signup succeeds).
-- See packages/server/src/auth/allowlist.ts and api.admin-invites.ts.

CREATE TABLE IF NOT EXISTS remote_agent_auth_invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member')),
  token VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id TEXT
    REFERENCES remote_agent_auth_user(id) ON DELETE SET NULL,
  created_by_user_id TEXT
    REFERENCES remote_agent_auth_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_invite_email
  ON remote_agent_auth_invite(email);
CREATE INDEX IF NOT EXISTS idx_auth_invite_token
  ON remote_agent_auth_invite(token)
  WHERE accepted_at IS NULL;

-- ============================================================================
-- Agent system: installed agents + routing audit (migration 024)
-- ============================================================================
--
-- Two tables backing the Agent persona layer.
--   remote_agent_agents      — every agent visible to the user (bundled + local
--                              + installed from future registry). Slug is unique.
--   remote_agent_agent_runs  — one row per routing decision. Append-only audit
--                              that answers "why did this go to <agent>?" later.
--
-- agent_slug in agent_runs is intentionally NOT a FK — we still want to log
-- runs for slugs that have since been uninstalled (same posture as
-- remote_agent_workflow_events.workflow_name).

CREATE TABLE IF NOT EXISTS remote_agent_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  source VARCHAR(16) NOT NULL CHECK (source IN ('bundled', 'local', 'installed')),
  version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  examples_json TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  model VARCHAR(255),
  memory_ref VARCHAR(128),
  author VARCHAR(128),
  definition_yaml TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  installed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(slug)
);

CREATE INDEX IF NOT EXISTS idx_agents_source
  ON remote_agent_agents(source);

CREATE TABLE IF NOT EXISTS remote_agent_agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_slug VARCHAR(64) NOT NULL,
  conversation_id UUID,
  message_id UUID,
  decision VARCHAR(32) NOT NULL CHECK (decision IN (
    'override', 'codebase_default', 'auto_heuristic', 'auto_llm', 'default_fallback'
  )),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  user_message_preview TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at
  ON remote_agent_agent_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_slug
  ON remote_agent_agent_runs(agent_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
  ON remote_agent_agent_runs(conversation_id) WHERE conversation_id IS NOT NULL;

COMMENT ON TABLE remote_agent_agents IS
  'Installed agents (bundled + local + installed from future registry). Slug is unique. JSON-as-TEXT fields are parsed in the store layer.';
COMMENT ON TABLE remote_agent_agent_runs IS
  'Append-only audit of every routing decision. Answers "why did this go to <agent>?" after the fact. agent_slug is not a FK so uninstalled agents still appear in history.';

-- ============================================================================
-- Memory system (path B — Memory + RAG) [from migration 025]
-- ============================================================================
-- Append-only store of facts the agent should remember across sessions.
-- Searchable via Postgres tsvector + GIN index (requires pgcrypto for
-- gen_random_uuid(); the deploy bundle runs CREATE EXTENSION pgcrypto
-- before this file is applied).
-- Scope model: 'user' (global) | 'agent' (per-persona) | 'project' (per-codebase)
-- | 'conversation' (per-chat). A memory can match multiple scopes — the
-- recall layer queries each scope and unions the top-N results.

CREATE TABLE IF NOT EXISTS remote_agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('user', 'agent', 'project', 'conversation')),
  scope_id TEXT,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('preference', 'fact', 'project_context', 'feedback', 'note')),
  content TEXT NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (source IN ('chat', 'manual', 'imported')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON remote_agent_memories(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON remote_agent_memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON remote_agent_memories(created_at DESC);

-- Postgres full-text search via tsvector + GIN. The content_tsv column is
-- auto-maintained by the trigger below (AFTER INSERT/UPDATE/DELETE).
ALTER TABLE remote_agent_memories
  ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv
  ON remote_agent_memories USING GIN (content_tsv);

CREATE OR REPLACE FUNCTION memories_content_tsv_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.content_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.content, '')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memories_content_tsv_trg ON remote_agent_memories;
CREATE TRIGGER memories_content_tsv_trg
  BEFORE INSERT OR UPDATE ON remote_agent_memories
  FOR EACH ROW EXECUTE FUNCTION memories_content_tsv_update();
-- Migration 027: RBAC core (roles, permissions, role_permissions)
--
-- Why: the legacy `users.role` column was a flat enum ('admin' | 'member')
-- that could not capture the operator's intent: a user might need sandbox
-- access without admin powers, or read-only on codebases with no chat
-- privilege. RBAC makes that explicit and adjustable from the admin UI
-- without schema migrations.
--
-- Three tables:
--   remote_agent_roles              — named bundles of permissions
--   remote_agent_permissions        — the catalog of all privileges
--   remote_agent_role_permissions   — many-to-many bridge
--
-- `roles.slug` is the stable identifier (e.g., 'admin', 'member',
-- 'sandbox-user'). Slugs are unique. `is_system=true` flags roles that
-- the operator cannot delete (default roles seeded on startup). The
-- admin UI (PR 6) enforces this; the DB accepts any insert.
--
-- `permissions.slug` is the stable identifier (e.g., 'sandbox:create',
-- 'git:revert'). Codes are colon-namespaced so the gate helper
-- (requirePermission) can group them by category for the UI.
--
-- All FKs cascade on delete so removing a role or permission also
-- removes its bindings (and removing a user drops their user_roles
-- rows in migration 028). Idempotent CREATE IF NOT EXISTS so the
-- bundled-schema apply converges across restarts.

CREATE TABLE IF NOT EXISTS remote_agent_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_agent_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(96) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  category VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permissions_category
  ON remote_agent_permissions(category);

CREATE TABLE IF NOT EXISTS remote_agent_role_permissions (
  role_id UUID NOT NULL
    REFERENCES remote_agent_roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL
    REFERENCES remote_agent_permissions(id) ON DELETE CASCADE,
  granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role
  ON remote_agent_role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission
  ON remote_agent_role_permissions(permission_id);

-- Migration 028: RBAC user bindings (user_roles, user_direct_permissions)
--
-- Why: a user has many roles; a role has many users. Plus a flat
-- per-user override for the rare case where the operator wants to
-- grant ONE specific permission to a single user without spinning up
-- a new role (e.g., a contractor needs git:revert but nothing else).
--
-- Two tables:
--   remote_agent_user_roles                — many-to-many: user ↔ role
--   remote_agent_user_direct_permissions   — per-user grant/revoke override
--
-- `user_roles.expires_at` supports temporary grants (e.g., a 30-day
-- admin boost for a teammate onboarding). NULL = permanent. The gate
-- helper filters expired rows at read time.
--
-- `user_direct_permissions.granted` is a real boolean (not just
-- presence) so the operator can REVOKE a single permission that
-- would otherwise be granted by one of the user's roles — without
-- removing the role. Rare, but the data model supports it.
--
-- Cascades: removing a user drops their bindings; removing a role
-- drops the user_roles row referencing it; removing a permission
-- drops the direct grant referencing it.

CREATE TABLE IF NOT EXISTS remote_agent_user_roles (
  user_id UUID NOT NULL
    REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL
    REFERENCES remote_agent_roles(id) ON DELETE CASCADE,
  granted_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user
  ON remote_agent_user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role
  ON remote_agent_user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_expires
  ON remote_agent_user_roles(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS remote_agent_user_direct_permissions (
  user_id UUID NOT NULL
    REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL
    REFERENCES remote_agent_permissions(id) ON DELETE CASCADE,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (user_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_direct_perms_user
  ON remote_agent_user_direct_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_direct_perms_permission
  ON remote_agent_user_direct_permissions(permission_id);

-- Migration 029: RBAC backfill — migrate legacy `users.role` into the
-- new m:n table, then drop the legacy column.
--
-- Why: the legacy column held one of two flat values ('admin',
-- 'member'). Each existing user gets exactly one user_roles row
-- pointing at the matching seeded role. The two seed roles (admin,
-- member) are referenced by slug so the backfill does not need their
-- UUIDs — but only if they were already seeded. The seed runs on
-- startup in @archon/core/db/rbac-seed, so by the time a backfill
-- executes on an existing install, the admin/member roles exist.
--
-- Idempotent:
--   - INSERT ... ON CONFLICT DO NOTHING prevents double-insert
--   - The legacy column DROP is wrapped in a DO block that checks
--     the column exists; safe to re-run on a fresh install where
--     the column was never created.
--
-- Net effect: after this migration runs once, `users.role` no longer
-- exists, and every former 'admin' user has a user_roles row pointing
-- at the seeded 'admin' role (with all its permissions, seeded in
-- 027 via rbac-seed). Same for 'member'.

-- Backfill: convert each existing users.role value into a user_roles row
-- pointing at the matching seeded role. ON CONFLICT keeps the backfill
-- safe across re-runs (e.g., when the legacy column was already dropped
-- and a stale copy of this migration replays).
INSERT INTO remote_agent_user_roles (user_id, role_id, granted_at)
SELECT
  u.id,
  r.id,
  NOW()
FROM remote_agent_users u
JOIN remote_agent_roles r ON r.slug = u.role
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Drop the legacy column. Wrapped in DO so re-running this migration
-- on a fresh install (where the column never existed) is a no-op
-- rather than a hard error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'remote_agent_users'
      AND column_name = 'role'
  ) THEN
    ALTER TABLE remote_agent_users DROP COLUMN role;
  END IF;
END
$$;

-- Migration 030: VOLUND FORGE — clients table
--
-- A client is the top-level entity in the PMO surface (Projeto → Demanda →
-- OS). Each codebase in the existing schema can be linked to a client
-- via `remote_agent_codebases.client_id` (added in 031).
--
-- Slugs are stable identifiers; the backfill adds a single default
-- client ("default") so the new column FK doesn't fail for existing
-- codebases. Operators can rename / split later.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING
-- for the seed.

CREATE TABLE IF NOT EXISTS remote_agent_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  contact_email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_status ON remote_agent_clients(status);
CREATE INDEX IF NOT EXISTS idx_clients_slug ON remote_agent_clients(slug);

-- Seed a default client so the FK on codebases doesn't fail for
-- pre-existing rows that have no client assignment yet.
INSERT INTO remote_agent_clients (slug, name, description)
VALUES ('default', 'Default', 'Catch-all client for codebases created before the PMO surface shipped.')
ON CONFLICT (slug) DO NOTHING;

-- Migration 031: VOLUND FORGE — demands table + codebase link
--
-- A demand is a unit of work in the PMO surface. The kanban board
-- groups demands by `status` (backlog / triagem / requisitos /
-- aprovacao / em-andamento / concluido / cancelado). Each demand
-- belongs to a client (FK) and optionally to a codebase (FK) — a
-- demand can be cross-project (e.g., a research spike that affects
-- multiple codebases).
--
-- Slugs follow the pattern `<CLIENT>-<KIND>-<YEAR>-<NNN>` (the
-- kanban screenshots show PSCODE-EC-FSM-2026-013, etc). The slug
-- is the operator-facing identifier; the UUID is the API handle.
--
-- The `metadata` JSONB carries the pipeline linkage + custom field
-- shapes the PMO UI may evolve (assignee, labels, attachments).
-- Keeping it JSONB avoids schema churn when new optional columns
-- are added by the UI.

CREATE TABLE IF NOT EXISTS remote_agent_demands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(96) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  client_id UUID NOT NULL REFERENCES remote_agent_clients(id) ON DELETE RESTRICT,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'backlog' CHECK (status IN (
    'backlog', 'triagem', 'requisitos', 'aprovacao_cliente',
    'em_andamento', 'concluido', 'cancelado'
  )),
  priority VARCHAR(16) NOT NULL DEFAULT 'media' CHECK (priority IN (
    'baixa', 'media', 'alta', 'urgente'
  )),
  -- Free-form metadata: assignee (user_id), labels (string[]),
  -- sprint_id (FK added in 033), pipeline links, etc. Keeping it
  -- JSONB means the UI can introduce new fields without migrations.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_date DATE,
  created_by_user_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demands_client_id ON remote_agent_demands(client_id);
CREATE INDEX IF NOT EXISTS idx_demands_codebase_id ON remote_agent_demands(codebase_id) WHERE codebase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_demands_status ON remote_agent_demands(status);
CREATE INDEX IF NOT EXISTS idx_demands_priority ON remote_agent_demands(priority);
CREATE INDEX IF NOT EXISTS idx_demands_created_at ON remote_agent_demands(created_at DESC);

-- Link codebases → clients (one client per codebase, nullable so
-- existing rows still validate). The seed inserts `default` for
-- pre-existing codebases so the FK resolves.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES remote_agent_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_codebases_client_id
  ON remote_agent_codebases(client_id) WHERE client_id IS NOT NULL;

-- Backfill: every pre-existing codebase points at the default client
-- so the kanban / projects grid still works on day one.
UPDATE remote_agent_codebases
SET client_id = (SELECT id FROM remote_agent_clients WHERE slug = 'default')
WHERE client_id IS NULL;

-- Migration 032: VOLUND FORGE — sprints
--
-- A sprint is a time-boxed commitment window that groups demands.
-- The PMO UI shows sprints as horizontal swim lanes on the kanban
-- (filter "Todas as sprints" or a specific sprint). Sprints are
-- scoped to a client (not to a codebase) so a single client can
-- have one rolling set of sprints.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS remote_agent_sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES remote_agent_clients(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'planejado' CHECK (status IN (
    'planejado', 'em_andamento', 'concluido', 'cancelado'
  )),
  goal TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_sprints_client_id ON remote_agent_sprints(client_id);
CREATE INDEX IF NOT EXISTS idx_sprints_status ON remote_agent_sprints(status);
CREATE INDEX IF NOT EXISTS idx_sprints_dates ON remote_agent_sprints(start_date DESC, end_date DESC);

-- Reference the sprint from a demand via the existing `metadata`
-- JSONB column. We deliberately do NOT add a sprint_id FK column —
-- demands without a sprint (backlog) is a valid state, and JSONB
-- keeps the demands table flat.

-- Migration 033: VOLUND FORGE — OS's (Ordens de Serviço)
--
-- An OS (Ordem de Serviço) is a unit of execution within a demand —
-- a task that someone can pick up and complete in a few hours /
-- days. The PMO UI shows OS's as a tab inside the demand detail
-- (the "OS's (0)" tab in the kanban screenshot). Each OS can be
-- assigned to a user (assignee) and tracks its own status.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS remote_agent_oss (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES remote_agent_demands(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente', 'em_andamento', 'concluida', 'cancelada', 'bloqueada'
  )),
  priority VARCHAR(16) NOT NULL DEFAULT 'media' CHECK (priority IN (
    'baixa', 'media', 'alta', 'urgente'
  )),
  assignee_user_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  estimated_hours NUMERIC(5, 2),
  actual_hours NUMERIC(5, 2),
  due_date DATE,
  completed_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oss_demand_id ON remote_agent_oss(demand_id);
CREATE INDEX IF NOT EXISTS idx_oss_assignee ON remote_agent_oss(assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oss_status ON remote_agent_oss(status);
CREATE INDEX IF NOT EXISTS idx_oss_due_date ON remote_agent_oss(due_date) WHERE due_date IS NOT NULL;

-- Migration 034: VOLUND FORGE — costs (LLM usage tracking)
--
-- One row per LLM call. Captures tokens + cost so the dashboards
-- can show TOTAL USD / TOTAL BR$ / RUNS / TOKENS and the breakdown
-- by project / pipeline / model.
--
-- The actual capture happens in packages/core/src/db/costs.ts
-- (the `recordCost` helper), called from the orchestrator / chat
-- loops. Each call writes one row with:
--   - run_id (FK to remote_agent_workflow_runs, NULL if ad-hoc)
--   - demand_id (FK to remote_agent_demands, NULL if pre-demand)
--   - codebase_id (FK to remote_agent_codebases, NULL otherwise)
--   - model, provider, kind (chat / completion / embedding / tool)
--   - tokens_in, tokens_out
--   - amount_usd (computed from model pricing)
--   - amount_brl (computed at write time from a fixed USD/BRL rate
--     recorded on the row; the conversion is informational — real
--     billing happens in USD)
--
-- Cost aggregation queries are in api-forge-costs.ts. We use a
-- partial index on (created_at DESC) so the dashboard's "last 30
-- days" query stays fast as the table grows.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS remote_agent_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  demand_id UUID REFERENCES remote_agent_demands(id) ON DELETE SET NULL,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  model VARCHAR(128) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'chat' CHECK (kind IN (
    'chat', 'completion', 'embedding', 'tool', 'image'
  )),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  amount_usd NUMERIC(10, 6) NOT NULL DEFAULT 0 CHECK (amount_usd >= 0),
  usd_brl_rate NUMERIC(10, 4) NOT NULL DEFAULT 5.0,
  amount_brl NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (amount_brl >= 0),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_costs_created_at ON remote_agent_costs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_costs_run_id ON remote_agent_costs(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_demand_id ON remote_agent_costs(demand_id) WHERE demand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_codebase_id ON remote_agent_costs(codebase_id) WHERE codebase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_model ON remote_agent_costs(model);

-- Migration 035: VOLUND FORGE — demand ↔ pipeline links
--
-- A demand can be linked to one or more HarnessOS workflow
-- pipelines. When a pipeline run is created from a demand, the
-- link is inserted here; the kanban UI uses the link list to
-- render the pipeline chips under the demand card.
--
-- The relationship is m:n (a pipeline can serve multiple demands
-- if it's a reusable workflow like `fsw` or `vigília`).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS remote_agent_demand_pipeline_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES remote_agent_demands(id) ON DELETE CASCADE,
  pipeline VARCHAR(255) NOT NULL,
  pipeline_version VARCHAR(32),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (demand_id, pipeline, pipeline_version)
);

CREATE INDEX IF NOT EXISTS idx_demand_pipeline_links_demand
  ON remote_agent_demand_pipeline_links(demand_id);
CREATE INDEX IF NOT EXISTS idx_demand_pipeline_links_pipeline
  ON remote_agent_demand_pipeline_links(pipeline);


-- Migration 036: FORGE audit trail + demand auto-move
--
-- Paulo pediu: "tudo, absolutamente tudo tem que ser registrado".
-- Esta migration adiciona a infra de DB pra:
--   1. Vincular workflow_runs a demands (m:1)
--   2. Vincular costs a messages (cada chamada LLM do chat do FORGE
--      vira 1 cost row linkado à mensagem)
--   3. Demand activities log — audit trail completo
--   4. Status 'bloqueada' no demand (para runs que falham)
--   5. demands.last_* (last_activity_at, last_run_id, runs_count, etc)
--
-- Idempotent: IF NOT EXISTS / DO blocks em tudo.

-- 1. workflow_runs.demand_id
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS demand_id UUID REFERENCES remote_agent_demands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_demand_id
  ON remote_agent_workflow_runs(demand_id) WHERE demand_id IS NOT NULL;

-- 2. costs.message_id + conversation_id
ALTER TABLE remote_agent_costs
  ADD COLUMN IF NOT EXISTS message_id UUID;
ALTER TABLE remote_agent_costs
  ADD COLUMN IF NOT EXISTS conversation_id UUID;
CREATE INDEX IF NOT EXISTS idx_costs_message_id
  ON remote_agent_costs(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_conversation_id
  ON remote_agent_costs(conversation_id) WHERE conversation_id IS NOT NULL;

-- 3. demand_activities (audit log)
CREATE TABLE IF NOT EXISTS remote_agent_demand_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES remote_agent_demands(id) ON DELETE CASCADE,
  action VARCHAR(32) NOT NULL CHECK (action IN (
    'status_change', 'priority_change', 'run_started', 'run_completed',
    'run_failed', 'message', 'note', 'created'
  )),
  from_status VARCHAR(32),
  to_status VARCHAR(32),
  from_priority VARCHAR(16),
  to_priority VARCHAR(16),
  run_id UUID,
  message_id UUID,
  user_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_demand_activities_demand_id
  ON remote_agent_demand_activities(demand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demand_activities_action
  ON remote_agent_demand_activities(demand_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demand_activities_run_id
  ON remote_agent_demand_activities(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_demand_activities_message_id
  ON remote_agent_demand_activities(message_id) WHERE message_id IS NOT NULL;

-- 4. Adicionar 'bloqueada' ao enum de status de demand
ALTER TABLE remote_agent_demands DROP CONSTRAINT IF EXISTS remote_agent_demands_status_check;
ALTER TABLE remote_agent_demands ADD CONSTRAINT remote_agent_demands_status_check
  CHECK (status IN (
    'backlog', 'triagem', 'requisitos', 'aprovacao_cliente',
    'em_andamento', 'bloqueada', 'concluido', 'cancelado'
  ));

-- 5. demands.last_activity_at + counters
ALTER TABLE remote_agent_demands
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_run_id UUID,
  ADD COLUMN IF NOT EXISTS last_run_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS runs_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messages_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_demands_last_activity_at
  ON remote_agent_demands(last_activity_at DESC NULLS LAST);

UPDATE remote_agent_demands
  SET last_activity_at = created_at
  WHERE last_activity_at IS NULL;

-- ============================================================================
-- 037: global audit log + users.last_login + workflow_runs.triggered_by
-- ============================================================================
-- Paulo pediu (FORGE sprint, 19/ago/2026): "tudo, absolutamente tudo tem
-- que ser registrado". Esta migration cuida do que NÃO é demand-specific:
-- CRUD de clients/projects/sprints/pipeline_links, login/logout, RBAC,
-- invites, settings. Tudo idempotente.

CREATE TABLE IF NOT EXISTS remote_agent_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  actor_email VARCHAR(255),
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32),
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip VARCHAR(64),
  user_agent TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'web',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON remote_agent_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON remote_agent_audit_log(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON remote_agent_audit_log(entity_type, entity_id, created_at DESC) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON remote_agent_audit_log(action, created_at DESC);

ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64);
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_last_login_at
  ON remote_agent_users(last_login_at DESC NULLS LAST);

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(32);

-- ============================================================================
-- 038: costs.metadata (forja UX: chat persistAssistantTurn needs JSONB
--     blob to record latency_ms + source. Migration 034 missed it; 036
--     added message_id/conversation_id but still missed metadata.)
-- ============================================================================
ALTER TABLE remote_agent_costs
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
