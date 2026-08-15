-- Agent system: installed agents + routing audit
-- Version: 24.0
-- Description: Two tables backing the Agent persona layer.
--   remote_agent_agents      — every agent visible to the user (bundled + local
--                              + installed from future registry). One row per
--                              (slug, version) — slug is unique.
--   remote_agent_agent_runs  — one row per routing decision. Append-only audit
--                              that answers "why did this go to bug-investigator?"
--                              after the fact.
--
-- Both tables use the prefix remote_agent_* to match the existing project-wide
-- table naming convention. `agent_slug` is TEXT (not FK) so we can log a run
-- for a slug that has since been uninstalled — same posture as the workflow
-- events table.
--
-- JSON-as-TEXT columns (tags_json, keywords_json, examples_json, allowed_tools_json,
-- definition_yaml, definition_json) follow the pattern from
-- remote_agent_user_ai_prefs and remote_agent_codebase_env_vars: parse in the
-- store layer so SQLite and Postgres behave identically. Defining them as
-- JSONB on Postgres only would diverge the two adapters.

-- ============================================================================
-- Table: remote_agent_agents
-- ============================================================================

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

-- Slug-only index for the "what's the latest version of this agent?" query
CREATE INDEX IF NOT EXISTS idx_agents_source
  ON remote_agent_agents(source);

-- ============================================================================
-- Table: remote_agent_agent_runs (append-only audit)
-- ============================================================================

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

-- The two queries that actually run against this table:
--   1. "Show me the last 50 routing decisions"        → ORDER BY created_at DESC
--   2. "How many times did this agent get picked?"    → GROUP BY agent_slug
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
COMMENT ON COLUMN remote_agent_agent_runs.user_message_preview IS
  'First 280 chars of the user message, stored as the routing evidence. Helps audit what triggered the choice without storing the full message.';
COMMENT ON COLUMN remote_agent_agent_runs.confidence IS
  '0.0–1.0. Always 1.0 for override/codebase_default, 0.0 for default_fallback, computed for auto_heuristic/auto_llm.';
COMMENT ON COLUMN remote_agent_agent_runs.latency_ms IS
  'Router wall-clock time. Heuristic < 50ms typical, LLM fallback < 500ms typical.';
