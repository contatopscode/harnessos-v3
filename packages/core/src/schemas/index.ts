/**
 * Core Zod schemas and derived types.
 *
 * All data-shape types are derived from schemas via `z.infer<typeof schema>`.
 * Import `z` from `@hono/zod-openapi` in all schema files (project convention).
 */

// Conversation
export { conversationRowSchema, identityPlatformSchema } from './conversation';
export type { Conversation, IdentityPlatform } from './conversation';

// Message
export { messageRowSchema } from './message';
export type { MessageRow } from './message';

// User
export { userRowSchema, userIdentityRowSchema, userRoleSchema } from './user';
export type { User, UserIdentity, UserRole } from './user';
export { userGithubTokenRowSchema } from './user-github-token-row';
export type { UserGithubTokenRow } from './user-github-token-row';
export { userAiPrefsRowSchema } from './user-ai-prefs-row';
export type { UserAiPrefsRow } from './user-ai-prefs-row';

// Codebase
export { codebaseRowSchema } from './codebase';
export type { Codebase } from './codebase';

// Session
export { sessionRowSchema, sessionMetadataSchema } from './session';
export type { Session, SessionMetadata } from './session';

// WorkflowEvent
export { workflowEventRowSchema } from './workflow-event';
export type { WorkflowEventRow } from './workflow-event';

// EnvVar
export { codebaseEnvVarSchema } from './env-var';
export type { CodebaseEnvVar } from './env-var';

// WorkflowRun (dashboard types)
export {
  dashboardWorkflowRunSchema,
  listDashboardRunsOptionsSchema,
  dashboardRunsResultSchema,
} from './workflow-run';
export type {
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
  DashboardRunsResult,
} from './workflow-run';

export {
  roleRowSchema,
  createRoleBodySchema,
  assignPermissionBodySchema,
  assignUserRoleBodySchema,
  createUserBodySchema,
  permissionRowSchema,
  userRoleRowSchema,
  userDirectPermissionRowSchema,
  userWithPermissionsSchema,
  roleWithPermissionsSchema,
} from './rbac';
export type {
  Role,
  Permission,
  UserRoleBinding,
  UserDirectPermission,
  UserWithPermissions,
  RoleWithPermissions,
} from './rbac';

// Agent
export {
  agentSlugSchema,
  agentSourceSchema,
  routingDecisionSchema,
  agentDefinitionSchema,
  agentRowSchema,
  agentRunRowSchema,
  routingInputSchema,
  routingResultSchema,
  discoveredAgentSchema,
  listAgentsOptionsSchema,
  listAgentsResultSchema,
} from './agent';
export type {
  AgentSlug,
  AgentSource,
  RoutingDecision,
  AgentDefinition,
  Agent,
  AgentRun,
  RoutingInput,
  RoutingResult,
  DiscoveredAgent,
  ListAgentsOptions,
  ListAgentsResult,
} from './agent';

// Memory system (path B — Memory + RAG) — exported so the CLI, orchestrator
// and Web UI can reference `Memory`, `MemoryKind`, etc. without reaching into
// the schema subpath.
export {
  memorySchema,
  memoryScopeSchema,
  memoryKindSchema,
  memorySourceSchema,
  memoryInsertSchema,
  recallMemoryRequestSchema,
  listMemoriesQuerySchema,
} from './memory';
export type {
  Memory,
  MemoryScope,
  MemoryKind,
  MemorySource,
  MemoryInsert,
  RecallMemoryRequest,
  ListMemoriesQuery,
} from './memory';

// VOLUND FORGE — PMO surface
export {
  clientStatusSchema,
  clientRowSchema,
  createClientBodySchema,
  updateClientBodySchema,
  demandStatusSchema,
  demandPrioritySchema,
  demandRowSchema,
  createDemandBodySchema,
  updateDemandBodySchema,
  updateDemandStatusBodySchema,
  sprintStatusSchema,
  sprintRowSchema,
  createSprintBodySchema,
  osStatusSchema,
  osRowSchema,
  createOsBodySchema,
  updateOsBodySchema,
  costKindSchema,
  costRowSchema,
  recordCostBodySchema,
  costSummarySchema,
  costBreakdownEntrySchema,
  costBreakdownSchema,
  projectSummarySchema,
  demandBoardColumnSchema,
  demandBoardSchema,
} from './forge';
export type {
  ClientStatus,
  Client,
  DemandStatus,
  DemandPriority,
  Demand,
  SprintStatus,
  Sprint,
  OsStatus,
  Os,
  CostKind,
  Cost,
  CostSummary,
  CostBreakdown,
  ProjectSummary,
  DemandBoard,
} from './forge';
