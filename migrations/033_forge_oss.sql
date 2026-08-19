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
