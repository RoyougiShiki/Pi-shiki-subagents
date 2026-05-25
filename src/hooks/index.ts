export { createApplyPatchHook } from '../opencode/apply-patch';
export type { AutoUpdateCheckerOptions } from '../opencode/auto-update-checker';
export { createAutoUpdateCheckerHook } from '../opencode/auto-update-checker';
export { createBackgroundTaskHook } from '../opencode/background-task';
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
export { createFilterAvailableSkillsHook } from '../opencode/filter-available-skills';
export {
  ForegroundFallbackManager,
  isRateLimitError,
} from '../opencode/foreground-fallback';
export { createHashlineEditHook } from '../opencode/hashline-edit';
export { processImageAttachments } from './image-hook';
export { createJsonErrorRecoveryHook } from '../opencode/json-error-recovery';
export { createPhaseReminderHook } from '../opencode/phase-reminder';
export { createRalphLoopHook } from '../opencode/ralph-loop';
export { createTaskSessionManagerHook } from '../opencode/task-session-manager';
export { createTodoContinuationHook } from '../opencode/todo-continuation';
