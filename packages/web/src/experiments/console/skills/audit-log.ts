/**
 * Audit log — thin fetch wrapper for the global audit API.
 *
 * Forja UX (FORGE sprint, 19/ago/2026): "tudo, absolutamente tudo
 * tem que ser registrado". This file is the Console UI's read-only
 * access to that audit trail.
 *
 * The remote_agent_audit_log table (migration 037) is the source of
 * truth. Each row carries:
 *   - actor_id / actor_email: who did it (NULL = system)
 *   - action: e.g. 'login.succeeded', 'client.created', 'demand.updated'
 *   - entity_type / entity_id: what was touched
 *   - metadata JSONB: action-specific details
 *   - ip / user_agent / source: origin
 *   - created_at: when
 *
 * Permission: `admin:users` (admin-only — the log includes IPs).
 */
import { requestJson } from '../lib/http';

export type AuditLogAction =
  // CRUD
  | 'client.created'
  | 'client.updated'
  | 'client.deleted'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'sprint.created'
  | 'sprint.updated'
  | 'sprint.deleted'
  | 'demand.created'
  | 'demand.updated'
  | 'demand.deleted'
  | 'pipeline_link.created'
  | 'pipeline_link.deleted'
  // Auth
  | 'login.succeeded'
  | 'login.failed'
  | 'logout'
  | 'invite.created'
  | 'invite.accepted'
  | 'invite.revoked'
  // RBAC
  | 'rbac.role.created'
  | 'rbac.role.updated'
  | 'rbac.role.deleted'
  | 'rbac.permission.granted'
  | 'rbac.permission.revoked'
  | 'rbac.user.role_assigned'
  | 'rbac.user.role_revoked'
  | 'rbac.user.permission_granted'
  | 'rbac.user.permission_revoked'
  // System
  | 'setting.changed'
  | 'system.error';

export type AuditLogSource =
  | 'web'
  | 'forge'
  | 'console'
  | 'slack'
  | 'telegram'
  | 'github'
  | 'cli'
  | 'cron'
  | 'system';

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: AuditLogAction;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  source: AuditLogSource;
  created_at: string;
}

export interface ListAuditLogResponse {
  entries: AuditLogEntry[];
  total: number;
  limit: number;
}

export interface ListAuditLogOptions {
  limit?: number;
  action?: AuditLogAction;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  since?: string;
}

export function listAuditLog(opts: ListAuditLogOptions = {}): Promise<ListAuditLogResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.action) params.set('action', opts.action);
  if (opts.entityType) params.set('entityType', opts.entityType);
  if (opts.entityId) params.set('entityId', opts.entityId);
  if (opts.actorId) params.set('actorId', opts.actorId);
  if (opts.since) params.set('since', opts.since);
  const q = params.toString();
  return requestJson<ListAuditLogResponse>(`/api/audit/log${q ? '?' + q : ''}`);
}

export function listAuditLogForEntity(
  entityType: string,
  entityId: string,
  limit = 50
): Promise<{ entity_type: string; entity_id: string; entries: AuditLogEntry[] }> {
  return requestJson(
    `/api/audit/log/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}?limit=${String(limit)}`
  );
}

// Friendly labels for the action badge column
export const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  'client.created': { label: 'Cliente criado', color: 'oklch(0.72 0.16 150)' },
  'client.updated': { label: 'Cliente atualizado', color: 'oklch(0.72 0.13 230)' },
  'client.deleted': { label: 'Cliente removido', color: 'oklch(0.65 0.18 25)' },
  'project.created': { label: 'Projeto criado', color: 'oklch(0.72 0.16 150)' },
  'project.updated': { label: 'Projeto atualizado', color: 'oklch(0.72 0.13 230)' },
  'project.deleted': { label: 'Projeto removido', color: 'oklch(0.65 0.18 25)' },
  'sprint.created': { label: 'Sprint criada', color: 'oklch(0.72 0.16 150)' },
  'sprint.updated': { label: 'Sprint atualizada', color: 'oklch(0.72 0.13 230)' },
  'sprint.deleted': { label: 'Sprint removida', color: 'oklch(0.65 0.18 25)' },
  'demand.created': { label: 'Demanda criada', color: 'oklch(0.72 0.16 150)' },
  'demand.updated': { label: 'Demanda atualizada', color: 'oklch(0.72 0.13 230)' },
  'demand.deleted': { label: 'Demanda removida', color: 'oklch(0.65 0.18 25)' },
  'pipeline_link.created': { label: 'Pipeline linkado', color: 'oklch(0.72 0.13 280)' },
  'pipeline_link.deleted': { label: 'Pipeline desligado', color: 'oklch(0.65 0.18 25)' },
  'login.succeeded': { label: 'Login', color: 'oklch(0.72 0.14 170)' },
  'login.failed': { label: 'Login falhou', color: 'oklch(0.65 0.18 25)' },
  logout: { label: 'Logout', color: 'oklch(0.7 0.05 230)' },
  'invite.created': { label: 'Convite criado', color: 'oklch(0.72 0.16 80)' },
  'invite.accepted': { label: 'Convite aceito', color: 'oklch(0.72 0.16 150)' },
  'invite.revoked': { label: 'Convite revogado', color: 'oklch(0.65 0.18 25)' },
  'rbac.role.created': { label: 'Role criada', color: 'oklch(0.72 0.13 280)' },
  'rbac.role.updated': { label: 'Role atualizada', color: 'oklch(0.72 0.13 230)' },
  'rbac.role.deleted': { label: 'Role removida', color: 'oklch(0.65 0.18 25)' },
  'rbac.permission.granted': { label: 'Permissão concedida', color: 'oklch(0.72 0.16 150)' },
  'rbac.permission.revoked': { label: 'Permissão revogada', color: 'oklch(0.65 0.18 25)' },
  'rbac.user.role_assigned': { label: 'Role atribuída', color: 'oklch(0.72 0.13 280)' },
  'rbac.user.role_revoked': { label: 'Role removida do user', color: 'oklch(0.65 0.18 25)' },
  'rbac.user.permission_granted': { label: 'Perm direta concedida', color: 'oklch(0.72 0.16 150)' },
  'rbac.user.permission_revoked': { label: 'Perm direta revogada', color: 'oklch(0.65 0.18 25)' },
  'setting.changed': { label: 'Setting alterado', color: 'oklch(0.7 0.05 230)' },
  'system.error': { label: 'Erro de sistema', color: 'oklch(0.65 0.18 25)' },
};

export function actionLabel(action: string): { label: string; color: string } {
  return ACTION_LABELS[action] ?? { label: action, color: 'oklch(0.7 0.05 230)' };
}
