/**
 * Hashline Utilities (Slim)
 *
 * Provides LINE#ID tag computation and validation for precise edit
 * verification. Each line in a tagged file carries a suffix like
 * `10#VK|<content>` where `VK` is a 2-character hash derived from
 * the line number and content.
 *
 * Cross-runtime compatible: uses Node.js `crypto` instead of
 * Bun.hash.xxHash32().
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 16-character alphabet for hash encoding. */
export const NIBBLE_STR = 'ZPMQVRWSNKTXJBYH';

/**
 * Pre-computed 256-entry lookup table mapping a byte value to a
 * 2-character hash string. Each character is drawn from
 * {@link NIBBLE_STR} (high nibble → char, low nibble → char).
 *
 * @example
 * ```ts
 * HASHLINE_DICT[0]   // 'ZZ'
 * HASHLINE_DICT[255] // 'HH'
 * HASHLINE_DICT[0x4B] // 'QB'
 * ```
 */
export const HASHLINE_DICT: string[] = Array.from({ length: 256 }, (_, i) => {
  const high = i >>> 4;
  const low = i & 15;
  return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`;
});

/**
 * Matches a standalone LINE#ID reference tag.
 *
 * @example
 * ```ts
 * HASHLINE_REF_PATTERN.test('10#VK')  // true
 * HASHLINE_REF_PATTERN.test('0#ZZ')   // true
 * HASHLINE_REF_PATTERN.test('abc')    // false
 * ```
 */
export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the 2-character hash tag for a single line.
 *
 * Uses MD5 over `"${seed}:${normalized}"` where `seed` is `0` when
 * the line contains alphanumeric characters, or the line number
 * otherwise. The first byte of the digest indexes into
 * {@link HASHLINE_DICT}.
 *
 * @param lineNumber - 1-based line number
 * @param content    - raw line content (may include trailing `\n`)
 * @returns 2-character hash string from {@link NIBBLE_STR}
 */
export function computeLineHash(lineNumber: number, content: string): string {
  const normalized = content.replace(/\r/g, '').trimEnd();
  const seed = /[\p{L}\p{N}]/u.test(normalized) ? 0 : lineNumber;
  const hash = createHash('md5').update(`${seed}:${normalized}`).digest();
  const index = hash[0] % 256;
  return HASHLINE_DICT[index];
}

// ---------------------------------------------------------------------------
// Tag generation / parsing
// ---------------------------------------------------------------------------

/**
 * Generate a full LINE#ID tag for a line.
 *
 * @param lineNumber - 1-based line number
 * @param content    - raw line content (without trailing newline)
 * @returns tag in the format `{lineNumber}#{hash}` (e.g. `"10#VK"`)
 */
export function generateHashlineTag(
  lineNumber: number,
  content: string,
): string {
  const hash = computeLineHash(lineNumber, content);
  return `${lineNumber}#${hash}`;
}

/**
 * Parse a standalone LINE#ID reference string.
 *
 * @param ref - a string like `"10#VK"`
 * @returns the parsed line number and hash, or `null` if invalid
 */
export function parseHashlineRef(
  ref: string,
): { lineNumber: number; hash: string } | null {
  const match = ref.match(HASHLINE_REF_PATTERN);
  if (!match) return null;
  return {
    lineNumber: Number.parseInt(match[1], 10),
    hash: match[2],
  };
}

/**
 * Validate that a LINE#ID reference matches the given content.
 *
 * @param ref           - a string like `"10#VK"`
 * @param actualContent - the content to verify against
 * @returns `true` if the hash matches, `false` otherwise
 */
export function validateHashlineRef(
  ref: string,
  actualContent: string,
): boolean {
  const parsed = parseHashlineRef(ref);
  if (!parsed) return false;
  const expected = computeLineHash(parsed.lineNumber, actualContent);
  return parsed.hash === expected;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a LINE#ID hash does not match the expected content
 * during an edit operation.
 *
 * Contains structured details about the mismatch for diagnostics.
 */
export class HashlineMismatchError extends Error {
  /** The line number where the mismatch occurred. */
  readonly lineNumber: number;

  /** The LINE#ID reference that failed validation. */
  readonly expectedRef: string;

  /** The actual content that was present. */
  readonly actualContent: string;

  /** The hash that was recomputed from the actual content. */
  readonly computedHash: string;

  constructor(params: {
    lineNumber: number;
    expectedRef: string;
    actualContent: string;
    computedHash: string;
  }) {
    const message = [
      `Hashline mismatch at line ${params.lineNumber}:`,
      `  expected ref "${params.expectedRef}"`,
      `  computed hash "${params.computedHash}"`,
      `  content "${params.actualContent.slice(0, 80)}${params.actualContent.length > 80 ? '…' : ''}"`,
    ].join('\n');
    super(message);
    this.name = 'HashlineMismatchError';
    this.lineNumber = params.lineNumber;
    this.expectedRef = params.expectedRef;
    this.actualContent = params.actualContent;
    this.computedHash = params.computedHash;
  }
}
