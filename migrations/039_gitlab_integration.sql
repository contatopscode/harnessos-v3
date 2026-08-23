-- ============================================================================
-- Migration 039: GitLab Integration (global org-level settings + issue links)
--
-- Phase 1 of the GitLab integration:
--   - `remote_agent_gitlab_settings` — org-level singleton (1 row, id=1)
--     holding the global access token + GitLab base URL + sync enable flag
--     + last-test diagnostic. One per installation; an admin updates it
--     from the Settings page.
--   - `remote_agent_gitlab_issue_links` — many rows; the join table that
--     links a FORGE demand to a GitLab issue. Holds sync metadata
--     (last_synced_at, last_synced_remote_updated_at, last_direction,
--     last_error) so the bidirectional loop can be guarded and the
--     UI can show "last synced 5 min ago" + a sync error if any.
--
-- Phase 2 (issue board view) and Phase 3 (webhook receiver) will reuse
-- the link table — no schema changes needed there.
--
-- Token is encrypted at rest with TOKEN_ENCRYPTION_KEY (same AES-256-GCM
-- helper used for user_github_tokens and user_provider_keys). The
-- application layer fails closed if the key is missing.
-- ============================================================================

-- Org-level GitLab settings (singleton: PRIMARY KEY id = 1 enforced via
-- CHECK constraint + UNIQUE; there is no per-user override at this scope
-- because the user asked for a "global token").
CREATE TABLE IF NOT EXISTS remote_agent_gitlab_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- e.g. "https://gitlab.com" or "https://gitlab.contatopscode.com.br".
  -- Self-hosted CE/EE instances use the same REST v4 API.
  gitlab_url TEXT NOT NULL,
  -- PAT (Personal Access Token) with `api` scope. Encrypted.
  access_token_encrypted TEXT NOT NULL,
  -- Optional allowlist of project paths to expose in FORGE; null = all
  -- projects the token can see. Format: "group/project" entries separated
  -- by newline. Stored as a single text column for simplicity — the count
  -- of entries is in the dozens at most.
  project_filter TEXT,
  -- Master switch — when false, sync is paused but the credentials stay.
  sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Last successful "test connection" — admin diagnostic only.
  last_tested_at TIMESTAMP WITH TIME ZONE,
  -- Username returned by GET /user on last successful test.
  last_test_user TEXT,
  -- "ok" | "auth_failed" | "network_error" | null = never tested
  last_test_status TEXT,
  last_test_error TEXT,
  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert the singleton row on first install (id=1). All other columns
-- are NULL / false until the admin saves the token from Settings.
INSERT INTO remote_agent_gitlab_settings (id, gitlab_url, access_token_encrypted)
VALUES (1, 'https://gitlab.com', '')
ON CONFLICT (id) DO NOTHING;

-- Issue link: a FORGE demand ↔ a GitLab issue (project_id + issue_iid).
-- demand_id is nullable so the link can survive demand deletion (we
-- surface it as a "ghost" until the user cleans up).
CREATE TABLE IF NOT EXISTS remote_agent_gitlab_issue_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID REFERENCES remote_agent_demands(id) ON DELETE SET NULL,
  -- GitLab's project_id (numeric) — derived from the encoded path on first
  -- resolve and cached here so we don't round-trip to GET /projects for
  -- every API call.
  project_id BIGINT NOT NULL,
  -- Display path for the project (e.g. "contatopscode/sinapse"). Kept
  -- alongside the numeric id for UI rendering without an extra join.
  project_path TEXT NOT NULL,
  -- issue_iid is the per-project sequential number; together with
  -- project_id it uniquely identifies the issue. Not the global id —
  -- GitLab UI shows iid and the REST API accepts both.
  issue_iid INTEGER NOT NULL,
  -- "out" = FORGE → GitLab was the last write. "in" = GitLab → FORGE.
  -- "synced" = both sides match (used as a soft guard before applying
  -- a webhook push, so the loop doesn't echo).
  last_direction TEXT NOT NULL DEFAULT 'synced',
  -- Last successful sync of this link.
  last_synced_at TIMESTAMP WITH TIME ZONE,
  -- updated_at from GitLab at the time of the last sync — used as the
  -- if-match version guard on the next push.
  last_synced_remote_updated_at TIMESTAMP WITH TIME ZONE,
  -- Same idea, FORGE-side. demand_activities timestamp or demand.updated_at
  -- at the time of the last sync.
  last_synced_local_updated_at TIMESTAMP WITH TIME ZONE,
  -- Last sync error (if any) — surfaced in the UI so the user knows
  -- the link is broken without having to read server logs.
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- One link per (project, iid) — a GitLab issue cannot be linked to
  -- two FORGE demands. The reverse (one demand ↔ multiple GitLab
  -- issues) is allowed because a demand can span multiple GitLab issues
  -- (e.g. a backend issue + a frontend issue).
  UNIQUE(project_id, issue_iid)
);

CREATE INDEX IF NOT EXISTS gitlab_issue_links_demand_id_idx
  ON remote_agent_gitlab_issue_links(demand_id);

CREATE INDEX IF NOT EXISTS gitlab_issue_links_project_iid_idx
  ON remote_agent_gitlab_issue_links(project_id, issue_iid);
