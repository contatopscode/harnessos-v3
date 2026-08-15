/**
 * Agent system public surface.
 *
 * Consumers import from `@archon/core` (which re-exports `agents` from
 * `src/index.ts`) or from `@archon/core/agents` for direct subpath access.
 */
export {
  loadAllAgents,
  loadBundledAgents,
  loadGlobalAgents,
  loadLocalAgents,
  loadAgentFromFile,
  parseAgentYaml,
  setBundledDirForTests,
  fsReadFile,
  fsReaddir,
  fsStat,
} from './loader';
export type { LoadedAgent, AgentLoadError, AgentOverride, AgentLoadResult } from './loader';

export { routeMessage, parseAgentOverride } from './router';
export type { LlmClassifier } from './router';

export {
  buildM3Classifier,
  isM3ClassifierEnabled,
  type M3ClassifierOptions,
  type M3ClassifierHandle,
} from './m3-classifier';

export { bootstrapBundledAgents } from './bootstrap';
export type { BootstrapResult } from './bootstrap';

export {
  resolveAgentForMessage,
  buildAgentPromptSection,
  type AgentResolution,
  type AgentResolutionResult,
} from './orchestrator-integration';

export {
  buildMemoryPromptSection,
  detectMemorySignal,
  persistMemorySignal,
  type MemorySignal,
} from './memory-integration';
