/**
 * Global audit log schemas.
 *
 * Paulo pediu (FORGE sprint, 19/ago/2026): "tudo, absolutamente tudo tem
 * que ser registrado". O audit log captura QUALQUER evento relevante do
 * sistema que NÃO seja uma atividade de demanda (que tem a tabela
 * dedicada `remote_agent_demand_activities`).
 *
 * Categorias cobertas:
 *   - CRUD: client.*, project.*, sprint.*, demand.* (manuais), pipeline_link.*
 *   - Auth: login.*, logout, invite.*
 *   - RBAC: rbac.role.*, rbac.permission.*, rbac.user.*
 *   - System: setting.changed, system.error
 *
 * A tabela é genérica (entity_type + entity_id + metadata JSONB) — não
 * precisa migration cada vez que um novo tipo de evento é adicionado.
 *
 * Migração: `migrations/037_global_audit_log.sql`.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

/**
 * The exhaustive set of audit log actions. Kept as a const tuple (not
 * enum) so the validator and the runtime share the same string list.
 *
 * Convention: `<entity>.<verb>` ou `<entity>.<verb>.<qualifier>`.
 * Examples: 'client.created', 'login.succeeded', 'rbac.user.role_assigned'.
 */
export const auditLogActionSchema = z.enum([
  // Clients
  'client.created',
  'client.updated',
  'client.deleted',
  // Projects (codebases)
  'project.created',
  'project.updated',
  'project.deleted',
  // Sprints
  'sprint.created',
  'sprint.updated',
  'sprint.deleted',
  // Demands (manual CRUD — auto-move from runs goes to demand_activities)
  'demand.created',
  'demand.updated',
  'demand.deleted',
  // Demand → workflow run dispatch ("Disparar RUN" button on the Kanban).
  // Distinct from the auto-fired `run_started` demand_activity because
  // the dispatch click is the human action; the run_started activity
  // is the system consequence.
  'demand.run_dispatched',
  // Pipeline links (demand ↔ workflow)
  'pipeline_link.created',
  'pipeline_link.deleted',
  // Auth
  'login.succeeded',
  'login.failed',
  'logout',
  // Invites
  'invite.created',
  'invite.accepted',
  'invite.revoked',
  // RBAC
  'rbac.role.created',
  'rbac.role.updated',
  'rbac.role.deleted',
  'rbac.permission.granted',
  'rbac.permission.revoked',
  'rbac.user.role_assigned',
  'rbac.user.role_revoked',
  'rbac.user.permission_granted',
  'rbac.user.permission_revoked',
  // Settings / system
  'setting.changed',
  'system.error',
]);
export type AuditLogAction = z.infer<typeof auditLogActionSchema>;

/**
 * Source vocabulary — the platform that originated the event.
 */
export const auditLogSourceSchema = z.enum([
  'web',
  'forge',
  'console',
  'slack',
  'telegram',
  'github',
  'cli',
  'cron',
  'system',
]);
export type AuditLogSource = z.infer<typeof auditLogSourceSchema>;

// ---------------------------------------------------------------------------
// Row + payload schemas
// ---------------------------------------------------------------------------

/**
 * One row in `remote_agent_audit_log`.
 */
export const auditLogRowSchema = z.object({
  id: z.string(),
  actor_id: z.string().nullable(),
  actor_email: z.string().nullable(),
  action: auditLogActionSchema,
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  source: auditLogSourceSchema,
  created_at: z.string(),
});
export type AuditLogRow = z.infer<typeof auditLogRowSchema>;

/**
 * Input shape for `recordAuditLog()`. All fields except `action` are
 * optional — the helper fills in `ip`, `user_agent`, `source`, `actor_*`
 * from context when available.
 */
export const recordAuditLogInputSchema = z.object({
  action: auditLogActionSchema,
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().nullable().optional(),
  actorEmail: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  source: auditLogSourceSchema.optional(),
});
export type RecordAuditLogInput = z.infer<typeof recordAuditLogInputSchema>;

/**
 * Query options for the listing endpoint.
 */
export const listAuditLogOptionsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  action: auditLogActionSchema.optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.string().optional(),
  since: z.string().optional(),
});
export type ListAuditLogOptions = z.infer<typeof listAuditLogOptionsSchema>;

/**
 * Response shape for the list endpoint.
 */
export const listAuditLogResponseSchema = z.object({
  entries: z.array(auditLogRowSchema),
  total: z.number().int(),
  limit: z.number().int(),
});
export type ListAuditLogResponse = z.infer<typeof listAuditLogResponseSchema>;

/**
 * Response shape for the per-entity endpoint.
 */
export const entityAuditLogResponseSchema = z.object({
  entity_type: z.string(),
  entity_id: z.string(),
  entries: z.array(auditLogRowSchema),
});
export type EntityAuditLogResponse = z.infer<typeof entityAuditLogResponseSchema>;
