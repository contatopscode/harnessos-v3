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
