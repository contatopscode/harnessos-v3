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
