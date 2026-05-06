/**
 * Ralph Loop — Core State Management (Slim)
 *
 * Self-referencing loop mechanism that detects `<promise>DONE</promise>`
 * completion tags in agent output and automatically continues until the
 * task is truly complete. State is persisted as a frontmatter markdown
 * file at `.sisyphus/ralph-loop.local.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { log } from './logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hook identifier used for logging and file paths. */
const HOOK_NAME = 'ralph-loop';

/** Default path for the state file (relative to project root). */
const DEFAULT_STATE_FILE = '.sisyphus/ralph-loop.local.md';

/** Maximum iterations for standard Ralph Loop. */
const DEFAULT_MAX_ITERATIONS = 100;

/** Maximum iterations for ULW (ultrawork) mode. */
const ULTRAWORK_MAX_ITERATIONS = 500;

/** Default completion promise tag content. */
const DEFAULT_COMPLETION_PROMISE = 'DONE';

/** ULW verification promise tag content. */
const ULTRAWORK_VERIFICATION_PROMISE = 'VERIFIED';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Strategy for continuing after a max-iteration limit is reached. */
export type LoopStrategy = 'reset' | 'continue';

/** Persisted state for an active Ralph Loop session. */
export interface RalphLoopState {
  /** Whether the loop is currently active. */
  active: boolean;
  /** Current iteration number (1-indexed). */
  iteration: number;
  /** Maximum allowed iterations before auto-stop. */
  max_iterations: number;
  /** Expected promise tag content (e.g. "DONE"). */
  completion_promise: string;
  /** ISO-8601 timestamp when the loop was started. */
  started_at: string;
  /** The original task prompt. */
  prompt: string;
  /** OpenCode session ID bound to this loop. */
  session_id?: string;
  /** Whether ULW (ultrawork) mode is enabled. */
  ultrawork?: boolean;
  /** Strategy when max iterations are exhausted. */
  strategy?: LoopStrategy;
}

/** Options for starting a new Ralph Loop. */
export interface StartLoopOptions {
  /** Maximum iterations (defaults to 100 or 500 in ULW mode). */
  maxIterations?: number;
  /** Whether to enable ULW mode (500 iterations + verified promise). */
  ultrawork?: boolean;
  /** Completion promise string override. */
  completionPromise?: string;
  /** Strategy when max iterations are exhausted. */
  strategy?: LoopStrategy;
}

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

/** Regex to detect `<promise>VALUE</promise>` tags in agent output. */
const COMPLETION_TAG_PATTERN = /<promise>\s*(\S+?)\s*<\/promise>/is;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the state file.
 * Creates the `.sisyphus/` directory if it does not exist.
 */
function resolveStatePath(directory: string): string {
  const stateDir = path.join(directory, '.sisyphus');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    // Directory creation may fail on read-only FS — callers will
    // see the error on write.
  }
  return path.join(stateDir, 'ralph-loop.local.md');
}

/**
 * Serialize a {@link RalphLoopState} to frontmatter markdown format.
 *
 * Format:
 * ```
 * ---
 * active: true
 * iteration: 1
 * ...
 * ---
 * Original task prompt
 * ```
 */
function serializeState(state: RalphLoopState): string {
  const lines = [
    '---',
    `active: ${state.active}`,
    `iteration: ${state.iteration}`,
    `max_iterations: ${state.max_iterations}`,
    `completion_promise: "${state.completion_promise}"`,
    `started_at: "${state.started_at}"`,
  ];

  if (state.session_id) {
    lines.push(`session_id: "${state.session_id}"`);
  }
  if (state.ultrawork !== undefined) {
    lines.push(`ultrawork: ${state.ultrawork}`);
  }
  if (state.strategy) {
    lines.push(`strategy: ${state.strategy}`);
  }

  lines.push('---', state.prompt);
  return lines.join('\n');
}

/**
 * Parse frontmatter markdown back into a {@link RalphLoopState}.
 * Returns `null` if the file content is malformed.
 */
function parseState(content: string): RalphLoopState | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatter, body] = match;
  if (!frontmatter || body === undefined) return null;

  const get = (key: string): string | undefined => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const m = frontmatter.match(re);
    return m?.[1]?.trim();
  };

  const rawActive = get('active');
  const rawIteration = get('iteration');
  const rawMax = get('max_iterations');
  const rawPromise = get('completion_promise');
  const rawStarted = get('started_at');

  if (!rawActive || !rawIteration || !rawMax || !rawPromise || !rawStarted) {
    return null;
  }

  // Strip surrounding quotes from values
  const unquote = (v: string) => v.replace(/^["']|["']$/g, '');

  return {
    active: rawActive === 'true',
    iteration: Number.parseInt(rawIteration, 10),
    max_iterations: Number.parseInt(rawMax, 10),
    completion_promise: unquote(rawPromise),
    started_at: unquote(rawStarted),
    prompt: body.trim(),
    session_id: get('session_id')?.replace(/^["']|["']$/g, ''),
    ultrawork: get('ultrawork') === 'true',
    strategy: get('strategy') as LoopStrategy | undefined,
  };
}

// ---------------------------------------------------------------------------
// RalphLoopManager
// ---------------------------------------------------------------------------

/**
 * Core state manager for the Ralph Loop self-referencing mechanism.
 *
 * Responsibilities:
 * - Persist / read loop state to `.sisyphus/ralph-loop.local.md`
 * - Detect completion promise tags (`<promise>DONE</promise>`)
 * - Manage iteration counters and loop lifecycle
 *
 * @example
 * ```ts
 * const manager = createRalphLoopManager(ctx)
 *
 * // Start a loop
 * manager.startLoop('ses_abc', 'Fix the bug in auth module')
 *
 * // Check agent output for completion
 * const result = manager.detectCompletion(agentOutput)
 * if (result) {
 *   console.log('Loop complete!')
 * } else {
 *   manager.incrementIteration()
 * }
 * ```
 */
export function createRalphLoopManager(ctx: PluginInput) {
  const { directory } = ctx;

  // In-memory cache — avoids re-parsing the file on every check.
  let cachedState: RalphLoopState | null = null;

  // -----------------------------------------------------------------------
  // File I/O
  // -----------------------------------------------------------------------

  /**
   * Read the persisted loop state from disk.
   * Returns `null` if no state file exists or parsing fails.
   */
  function readState(): RalphLoopState | null {
    const filePath = resolveStatePath(directory);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      cachedState = parseState(content);
      return cachedState;
    } catch {
      // File doesn't exist or unreadable — no active loop
      cachedState = null;
      return null;
    }
  }

  /**
   * Write loop state to disk and update the in-memory cache.
   * Creates the `.sisyphus/` directory if needed.
   * Returns `true` on success, `false` on I/O error.
   */
  function writeState(state: RalphLoopState): boolean {
    const filePath = resolveStatePath(directory);
    try {
      fs.writeFileSync(filePath, serializeState(state), 'utf-8');
      cachedState = state;
      return true;
    } catch (err) {
      log(`[${HOOK_NAME}] Failed to write state`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Delete the state file and clear the in-memory cache.
   * Returns `true` on success (or if the file didn't exist).
   */
  function clearState(): boolean {
    const filePath = resolveStatePath(directory);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File doesn't exist — that's fine
    }
    cachedState = null;
    return true;
  }

  // -----------------------------------------------------------------------
  // State accessors
  // -----------------------------------------------------------------------

  /**
   * Get the current in-memory state, falling back to disk read.
   * Returns `null` if no active loop.
   */
  function getState(): RalphLoopState | null {
    if (cachedState?.active) return cachedState;
    return readState();
  }

  // -----------------------------------------------------------------------
  // Loop lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a new Ralph Loop session.
   *
   * @param sessionID - OpenCode session to bind the loop to.
   * @param prompt    - Original task prompt.
   * @param options   - Optional overrides (maxIterations, ultrawork, etc.).
   * @returns `true` if the loop was started successfully.
   */
  function startLoop(
    sessionID: string,
    prompt: string,
    options?: StartLoopOptions,
  ): boolean {
    const ultrawork = options?.ultrawork ?? false;
    const maxIterations =
      options?.maxIterations ??
      (ultrawork ? ULTRAWORK_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS);
    const completionPromise =
      options?.completionPromise ??
      (ultrawork ? ULTRAWORK_VERIFICATION_PROMISE : DEFAULT_COMPLETION_PROMISE);

    const state: RalphLoopState = {
      active: true,
      iteration: 1,
      max_iterations: maxIterations,
      completion_promise: completionPromise,
      started_at: new Date().toISOString(),
      prompt,
      session_id: sessionID,
      ultrawork,
      strategy: options?.strategy,
    };

    const ok = writeState(state);
    if (ok) {
      log(`[${HOOK_NAME}] Loop started`, {
        sessionID,
        iteration: 1,
        maxIterations,
        completionPromise,
        ultrawork,
      });
    }
    return ok;
  }

  /**
   * Cancel the active loop for a given session.
   *
   * @param sessionID - Session whose loop should be cancelled.
   * @returns `true` if a loop was found and cancelled.
   */
  function cancelLoop(sessionID: string): boolean {
    const state = getState();
    if (!state || !state.active) {
      log(`[${HOOK_NAME}] Cancel failed — no active loop`, { sessionID });
      return false;
    }
    if (state.session_id && state.session_id !== sessionID) {
      log(`[${HOOK_NAME}] Cancel failed — session mismatch`, {
        sessionID,
        boundSession: state.session_id,
      });
      return false;
    }

    state.active = false;
    writeState(state);
    log(`[${HOOK_NAME}] Loop cancelled`, {
      sessionID,
      iteration: state.iteration,
    });
    return true;
  }

  // -----------------------------------------------------------------------
  // Completion detection
  // -----------------------------------------------------------------------

  /**
   * Detect whether agent output contains the completion promise tag.
   *
   * @param text - Agent output to scan.
   * @returns The matched promise string if found, `null` otherwise.
   *
   * @example
   * ```ts
   * const promise = detectCompletion('Here is the fix.\n<promise>DONE</promise>')
   * // → 'DONE'
   * ```
   */
  function detectCompletion(text: string): string | null {
    const match = text.match(COMPLETION_TAG_PATTERN);
    return match?.[1] ?? null;
  }

  /**
   * Increment the iteration counter and persist the updated state.
   * If max iterations are reached, the loop is marked inactive.
   *
   * @returns Updated state, or `null` if no active loop or after max iterations.
   */
  function incrementIteration(): RalphLoopState | null {
    const state = getState();
    if (!state || !state.active) return null;

    state.iteration += 1;

    if (state.iteration > state.max_iterations) {
      state.active = false;
      writeState(state);
      log(`[${HOOK_NAME}] Max iterations reached — loop stopped`, {
        maxIterations: state.max_iterations,
        sessionID: state.session_id,
      });
      return null;
    }

    writeState(state);
    log(`[${HOOK_NAME}] Iteration incremented`, {
      iteration: state.iteration,
      maxIterations: state.max_iterations,
    });
    return state;
  }

  // -----------------------------------------------------------------------
  // Prompt building
  // -----------------------------------------------------------------------

  /**
   * Build the continuation prompt to inject when the agent hasn't
   * output the completion promise.
   *
   * @param state - Current loop state.
   * @returns Formatted continuation prompt string.
   */
  function buildContinuationPrompt(state: RalphLoopState): string {
    return [
      `[RALPH LOOP ${state.iteration}/${state.max_iterations}]`,
      '',
      'Your previous attempt did not output the completion promise.',
      'Continue working on the task.',
      '',
      '- Review your progress so far',
      '- Continue from where you left off',
      `- When FULLY complete, output: <promise>${state.completion_promise}</promise>`,
      '- Do not stop until the task is truly done',
      '',
      'Original task:',
      state.prompt,
    ].join('\n');
  }

  // -----------------------------------------------------------------------
  // Return public API
  // -----------------------------------------------------------------------

  return {
    readState,
    writeState,
    clearState,
    startLoop,
    cancelLoop,
    getState,
    detectCompletion,
    incrementIteration,
    buildContinuationPrompt,
  };
}

// Re-export constants for use in hooks
export {
  DEFAULT_COMPLETION_PROMISE,
  DEFAULT_MAX_ITERATIONS,
  HOOK_NAME,
  ULTRAWORK_MAX_ITERATIONS,
  ULTRAWORK_VERIFICATION_PROMISE,
};
