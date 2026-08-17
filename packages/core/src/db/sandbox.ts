/**
 * Sandbox Mode DB helpers — re-export the sandbox-specific query helpers
 * from `isolation-environments.ts` under a narrower, more discoverable name.
 *
 * The underlying table is the same `remote_agent_isolation_environments` —
 * sandboxes are stored with `workflow_type='sandbox'`. This module is a
 * thin facade so orchestrator + UI code can `import * as sandboxDb` and
 * find the four calls they need without scrolling through the larger
 * isolation_environments surface (which has 25+ helpers for the
 * issue/pr/review/thread/task workflows that sandbox code never touches).
 */
export {
  findActiveSandboxByCwd,
  recordSandboxTurn,
  finalizeSandbox,
  clearConversationsOnWorktree,
} from './isolation-environments';
