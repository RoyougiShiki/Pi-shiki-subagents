/**
 * Hashline Edit Hook (Slim)
 *
 * Intercepts `edit` tool calls to validate LINE#ID tags in the
 * old content. When a mismatch is detected (file has been modified
 * since the tags were generated), a {@link HashlineMismatchError}
 * is thrown to prevent silent data corruption.
 *
 * Strips LINE#ID prefixes from both oldString and newString before
 * the native edit tool processes them.
 */

import { log } from '../../utils/logger'
import {
  HashlineMismatchError,
  computeLineHash,
  generateHashlineTag,
  validateHashlineRef,
} from '../../utils/hashline'

const HASHLINE_RE = /^[0-9]+#[A-Z]{2}\|/

const EDIT_TOOL_NAMES = new Set(['edit'])

interface ToolExecuteBeforeInput {
  tool: string
  directory?: string
}

interface ToolExecuteBeforeOutput {
  args?: {
    filePath?: unknown
    oldString?: unknown
    newString?: unknown
    [key: string]: unknown
  }
}

interface ToolExecuteAfterInput {
  tool: string
}

interface ToolExecuteAfterOutput {
  output?: unknown
}

/**
 * Options for the hashline edit hook.
 */
export interface HashlineEditHookOptions {
  /** Enable or disable the hook. Defaults to `true`. */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a LINE#ID ref from a line that starts with a tag prefix.
 * Returns `{ ref, content }` or `null` if the line has no tag.
 */
function extractTaggedLine(line: string): {
  ref: string
  content: string
} | null {
  const pipeIdx = line.indexOf('|')
  if (pipeIdx < 0) return null

  const prefix = line.slice(0, pipeIdx)
  if (!prefix.match(/^[0-9]+#[A-Z]{2}$/)) return null

  return { ref: prefix, content: line.slice(pipeIdx + 1) }
}

/**
 * Validate all LINE#ID tags in a multi-line string.
 * Returns an array of mismatches (empty = all valid).
 */
function validateAllTags(
  text: string,
): Array<{
  lineNumber: number
  expectedRef: string
  actualContent: string
  computedHash: string
}> {
  const mismatches: Array<{
    lineNumber: number
    expectedRef: string
    actualContent: string
    computedHash: string
  }> = []

  const lines = text.split('\n')
  for (const line of lines) {
    const tagged = extractTaggedLine(line)
    if (!tagged) continue

    if (!validateHashlineRef(tagged.ref, tagged.content)) {
      const parts = tagged.ref.split('#')
      const lineNumber = Number.parseInt(parts[0]!, 10)
      const hash = computeLineHash(lineNumber, tagged.content)
      mismatches.push({
        lineNumber,
        expectedRef: tagged.ref,
        actualContent: tagged.content,
        computedHash: hash,
      })
    }
  }

  return mismatches
}

/**
 * Strip LINE#ID tag prefixes from each line.
 *
 * `"10#VK|function hello()"` → `"function hello()"`
 */
function stripTags(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const tagged = extractTaggedLine(line)
      return tagged ? tagged.content : line
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create a hashline edit hook that validates LINE#ID tags before
 * the native `edit` tool processes the replacement.
 *
 * @example
 * ```ts
 * const hook = createHashlineEditHook({ enabled: true })
 * // Register with the plugin:
 * // plugin.hook('tool.execute.before', hook['tool.execute.before'])
 * ```
 */
export function createHashlineEditHook(
  config: HashlineEditHookOptions = {},
) {
  const enabled = config.enabled !== false

  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (!enabled) return
      if (!EDIT_TOOL_NAMES.has(input.tool)) return

      const args = output.args
      if (!args) return

      const oldString =
        typeof args.oldString === 'string' ? args.oldString : null
      const newString =
        typeof args.newString === 'string' ? args.newString : null

      if (!oldString) return

      const hasTags = oldString.split('\n').some((l) =>
        HASHLINE_RE.test(l),
      )
      if (!hasTags) return

      log('[hashline-edit] Validating tags in edit oldString', {
        hasOldTags: true,
        oldStringLines: oldString.split('\n').length,
      })

      const mismatches = validateAllTags(oldString)
      if (mismatches.length > 0) {
        const first = mismatches[0]!
        log('[hashline-edit] MISMATCH detected', {
          mismatchCount: mismatches.length,
          firstLine: first.lineNumber,
        })
        throw new HashlineMismatchError(first)
      }

      // Strip tags so the native edit works with clean content
      args.oldString = stripTags(oldString)
      if (newString) {
        args.newString = stripTags(newString)
      }

      log('[hashline-edit] Tags validated and stripped', {
        oldLines: oldString.split('\n').length,
        newLines: newString ? newString.split('\n').length : 0,
      })
    },

    'tool.execute.after': async (
      _input: ToolExecuteAfterInput,
      _output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      // Reserved for future use: e.g. re-tagging output content
    },
  }
}
