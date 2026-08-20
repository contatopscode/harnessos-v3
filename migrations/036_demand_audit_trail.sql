-- Migration 036: FORGE audit trail + demand auto-move
--
-- Paulo pediu: "tudo, absolutamente tudo tem que ser registrado".
-- Esta migration adiciona a infra de DB pra:
--   1. Vincular workflow_runs a demands (m:1) — o run "pertence" a uma
--      demanda, e quando termina move o status dela automaticamente
--   2. Vincular costs a messages — cada chamada LLM do chat do FORGE
--      vira 1 cost row linkado à mensagem correspondente (não só ao run)
--   3. Demand activities log — audit trail de toda mudança (status,
--      priority, runs, mensagens, notas manuais). É o "single source of
--      truth" pra responder "onde está cada demanda"
--   4. Status 'bloqueada' no demand — quando um run falha, a demanda
--      vai pra bloqueada com nota do erro
--
-- Idempotent: IF NOT EXISTS / DO blocks em tudo.

-- =============================================================================
-- 1. workflow_runs.demand_id — vincula o run à demanda
-- =============================================================================
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS demand_id UUID REFERENCES remote_agent_demands(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_demand_id
  ON remote_agent_workflow_runs(demand_id)
  WHERE demand_id IS NOT NULL;

-- =============================================================================
-- 2. costs.message_id — linka cada cost row à mensagem do chat que a gerou
-- =============================================================================
ALTER TABLE remote_agent_costs
  ADD COLUMN IF NOT EXISTS message_id UUID;
ALTER TABLE remote_agent_costs
  ADD COLUMN IF NOT EXISTS conversation_id UUID;

CREATE INDEX IF NOT EXISTS idx_costs_message_id
  ON remote_agent_costs(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_conversation_id
  ON remote_agent_costs(conversation_id) WHERE conversation_id IS NOT NULL;

-- =============================================================================
-- 3. demand_activities — audit log completo
-- =============================================================================
CREATE TABLE IF NOT EXISTS remote_agent_demand_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES remote_agent_demands(id) ON DELETE CASCADE,
  -- action: qual tipo de evento
  --   'status_change' — transição manual ou auto de status
  --   'priority_change' — mudança de prioridade
  --   'run_started' — workflow run começou
  --   'run_completed' — workflow run terminou (succeeded)
  --   'run_failed' — workflow run terminou com erro
  --   'message' — mensagem do chat (FORGE) linkada à demanda
  --   'note' — nota manual adicionada por um humano
  --   'created' — demand foi criada (linha inicial)
  action VARCHAR(32) NOT NULL CHECK (action IN (
    'status_change', 'priority_change', 'run_started', 'run_completed',
    'run_failed', 'message', 'note', 'created'
  )),
  from_status VARCHAR(32),
  to_status VARCHAR(32),
  from_priority VARCHAR(16),
  to_priority VARCHAR(16),
  -- run_id e message_id são opcionais — depende do action
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

-- =============================================================================
-- 4. Adicionar 'bloqueada' ao enum de status de demand
-- =============================================================================
-- O CHECK constraint atual: status IN ('backlog', 'triagem', 'requisitos',
-- 'aprovacao_cliente', 'em_andamento', 'concluido', 'cancelado')
-- Precisamos dropar e recriar com 'bloqueada' incluído
ALTER TABLE remote_agent_demands DROP CONSTRAINT IF EXISTS remote_agent_demands_status_check;
ALTER TABLE remote_agent_demands ADD CONSTRAINT remote_agent_demands_status_check
  CHECK (status IN (
    'backlog', 'triagem', 'requisitos', 'aprovacao_cliente',
    'em_andamento', 'bloqueada', 'concluido', 'cancelado'
  ));

-- =============================================================================
-- 5. demands.last_* — campos de "atividade recente" pra queries rápidas
-- =============================================================================
ALTER TABLE remote_agent_demands
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_run_id UUID,
  ADD COLUMN IF NOT EXISTS last_run_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS runs_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messages_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_demands_last_activity_at
  ON remote_agent_demands(last_activity_at DESC NULLS LAST);

-- Backfill: demands existentes já criadas devem ter last_activity_at = created_at
UPDATE remote_agent_demands
  SET last_activity_at = created_at
  WHERE last_activity_at IS NULL;
