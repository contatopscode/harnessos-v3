-- Migration 037: Global audit log + login tracking
--
-- Paulo pediu (FORGE sprint, 19/ago/2026): "tudo, absolutamente tudo tem
-- que ser registrado". A migration 036 cuidou do audit de DEMANDAS. Esta
-- migration 037 cuida de TUDO O RESTO:
--
--   1. Audit log genérico (login, CRUD de clients/projects/sprints/
--      pipeline_links, RBAC roles/permissions, invites, settings)
--   2. users.last_login_at / last_login_ip — saber "quem logou quando
--      e de onde" sem precisar de tabela de sessions
--   3. workflow_runs.triggered_by — pra distinguir runs de chat, API,
--      cron, auto, manual no timeline
--
-- Tudo idempotente (IF NOT EXISTS / DO blocks).

-- =============================================================================
-- 1. remote_agent_audit_log — evento genérico, indexado por entity + actor
-- =============================================================================
-- action vocabulary (extensível, validado por CHECK):
--   'client.created'        'client.updated'        'client.deleted'
--   'project.created'       'project.updated'       'project.deleted'
--   'sprint.created'        'sprint.updated'        'sprint.deleted'
--   'demand.created'        'demand.updated'        'demand.deleted'
--   'pipeline_link.created' 'pipeline_link.deleted'
--   'login.succeeded'       'login.failed'          'logout'
--   'invite.created'        'invite.accepted'       'invite.revoked'
--   'rbac.role.created'     'rbac.role.updated'     'rbac.role.deleted'
--   'rbac.permission.granted' 'rbac.permission.revoked'
--   'rbac.user.role_assigned' 'rbac.user.role_revoked'
--   'rbac.user.permission_granted' 'rbac.user.permission_revoked'
--   'setting.changed'
CREATE TABLE IF NOT EXISTS remote_agent_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quem fez (NULL = system, e.g. cron, auto-move)
  actor_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL,
  actor_email VARCHAR(255),
  -- O que foi feito (CHECK abaixo)
  action VARCHAR(64) NOT NULL,
  -- Em qual entidade (client, project, sprint, demand, pipeline_link, user,
  -- role, permission, session, invite, setting)
  entity_type VARCHAR(32),
  entity_id UUID,
  -- Detalhes específicos do evento (old/new values, params, error msg)
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Origem do request (pra segurança: detectar logins de IP novo, etc)
  ip VARCHAR(64),
  user_agent TEXT,
  -- Plataforma que originou o evento (web, slack, telegram, cli, system)
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

-- =============================================================================
-- 2. users.last_login_at / last_login_ip — pra mostrar "último acesso" e
--    detectar logins de IP novo (segurança)
-- =============================================================================
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64);
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_last_login_at
  ON remote_agent_users(last_login_at DESC NULLS LAST);

-- =============================================================================
-- 3. workflow_runs.triggered_by — distingue a origem do run
-- =============================================================================
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(32);

-- Backfill: inferir de onde faz sentido. NULL = unknown legacy.
-- Runs antigos ficam NULL; novos vão vir com 'chat' | 'api' | 'cron' |
-- 'auto' | 'manual' setado pelo caller.
