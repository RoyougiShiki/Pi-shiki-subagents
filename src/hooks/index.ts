export { createApplyPatchHook } from './apply-patch';
export type { AutoUpdateCheckerOptions } from './auto-update-checker';
export { createAutoUpdateCheckerHook } from './auto-update-checker';
export { createBackgroundTaskHook } from './background-task';
export { createChatHeadersHook } from './chat-headers';
// Declaration gates — replaces old approach-approval-gate, clarify-loop,
// and intent-gate with hard script-side enforcement
export {
  createApprovalGateHook,
  createClarifyGateHook,
  createIntentGateHook,
  createOrchestrationGateHook,
} from '../opencode/declaration-gate';
export { createDelegateTaskRetryHook } from '../opencode/delegate-task-retry';
export { createFilterAvailableSkillsHook } from './filter-available-skills';
export {
  ForegroundFallbackManager,
  isRateLimitError,
} from './foreground-fallback';
export { createHashlineEditHook } from './hashline-edit';
export { processImageAttachments } from './image-hook';
export { createJsonErrorRecoveryHook } from './json-error-recovery';
export { createPhaseReminderHook } from './phase-reminder';
export { createRalphLoopHook } from './ralph-loop';
export { createTaskSessionManagerHook } from './task-session-manager';
export { createTodoContinuationHook } from './todo-continuation';
