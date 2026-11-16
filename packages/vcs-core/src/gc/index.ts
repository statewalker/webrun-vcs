export {
  type DeltaCandidateSelectorOptions,
  type DeltaObjectInfo,
  selectDeltaCandidates,
} from "./delta-candidate-selector.js";
export {
  DEFAULT_GC_PRUNE_EXPIRE_MS,
  DEFAULT_STALE_EXPIRY_MS,
  GcOrchestrator,
  type GcRunOptions,
  type GcRunResult,
} from "./gc-orchestrator.js";
export type {
  CompactResult,
  DeltaCandidatePair,
  GcRoots,
  GcStrategy,
  StorageStats,
} from "./gc-strategy.js";
export { MemoryGcStrategy } from "./memory-gc-strategy.js";
