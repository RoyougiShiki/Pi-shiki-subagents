import { describe, expect, test } from 'bun:test';
import {
  getVerdictStatus,
  hasVerifierVerdict,
  parseVerifierVerdict,
} from './verifier-verdict-parser';

const PASS_OUTPUT = `
### Check: POST /api/register rejects short password
**Command run:**
  curl -s -X POST localhost:8000/api/register -H 'Content-Type: application/json' \\
    -d '{"email":"t@t.co","password":"short"}' | python3 -m json.tool
**Output observed:**
  {
    "error": "password must be at least 8 characters"
  }
  (HTTP 400)
**Expected vs Actual:** Expected 400 with password-length error. Got exactly that.
**Result: PASS**

VERDICT: PASS
`;

const FAIL_OUTPUT = `
### Check: Database connection works
**Command run:**
  psql -c "SELECT 1"
**Output observed:**
  connection refused
**Result: FAIL**

VERDICT: FAIL
The database is not running. Start it with: docker-compose up -d db
`;

const PARTIAL_OUTPUT = `
### Check: Frontend renders correctly
**Command run:**
  npm run dev
**Output observed:**
  Server started on localhost:3000
**Result: PASS**

VERDICT: PARTIAL
Browser automation tools not available. Manual verification needed.
`;

const NO_VERDICT_OUTPUT = `
I checked the code and it looks correct.
`;

const EMPTY_OUTPUT = '';

describe('verifier verdict parser', () => {
  test('parses PASS verdict with check blocks', () => {
    const result = parseVerifierVerdict(PASS_OUTPUT);
    expect(result.success).toBe(true);
    expect(result.verdict?.verdict).toBe('PASS');
    expect(result.verdict?.checkBlocks.length).toBeGreaterThan(0);
    expect(result.verdict?.hasCommandRun).toBe(true);
    expect(result.verdict?.hasOutputObserved).toBe(true);
  });

  test('parses FAIL verdict with failDetails', () => {
    const result = parseVerifierVerdict(FAIL_OUTPUT);
    expect(result.success).toBe(true);
    expect(result.verdict?.verdict).toBe('FAIL');
    expect(result.verdict?.failDetails).toBeDefined();
    expect(result.verdict?.checkBlocks.length).toBeGreaterThan(0);
  });

  test('parses PARTIAL verdict with partialDetails', () => {
    const result = parseVerifierVerdict(PARTIAL_OUTPUT);
    expect(result.success).toBe(true);
    expect(result.verdict?.verdict).toBe('PARTIAL');
    expect(result.verdict?.partialDetails).toBeDefined();
  });

  test('extracts check block fields correctly', () => {
    const result = parseVerifierVerdict(PASS_OUTPUT);
    expect(result.success).toBe(true);
    const block = result.verdict?.checkBlocks[0];
    expect(block?.checkDescription).toContain('POST /api/register');
    expect(block?.commandRun).toContain('curl');
    expect(block?.outputObserved).toContain(
      'password must be at least 8 characters',
    );
    expect(block?.result).toBe('PASS');
    expect(block?.expectedVsActual).toContain('Expected 400');
  });

  test('returns error for empty text', () => {
    const result = parseVerifierVerdict(EMPTY_OUTPUT);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Empty text');
  });

  test('returns error for missing VERDICT line', () => {
    const result = parseVerifierVerdict(NO_VERDICT_OUTPUT);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No VERDICT');
  });

  test('hasVerifierVerdict returns true for PASS output', () => {
    expect(hasVerifierVerdict(PASS_OUTPUT)).toBe(true);
  });

  test('hasVerifierVerdict returns true for FAIL output', () => {
    expect(hasVerifierVerdict(FAIL_OUTPUT)).toBe(true);
  });

  test('hasVerifierVerdict returns false for no verdict', () => {
    expect(hasVerifierVerdict(NO_VERDICT_OUTPUT)).toBe(false);
  });

  test('getVerdictStatus returns PASS', () => {
    expect(getVerdictStatus(PASS_OUTPUT)).toBe('PASS');
  });

  test('getVerdictStatus returns FAIL', () => {
    expect(getVerdictStatus(FAIL_OUTPUT)).toBe('FAIL');
  });

  test('getVerdictStatus returns null for no verdict', () => {
    expect(getVerdictStatus(NO_VERDICT_OUTPUT)).toBeNull();
  });

  test('handles multiple check blocks', () => {
    const multipleBlocks = `
### Check: Build succeeds
**Command run:**
  npm run build
**Output observed:**
  Build completed successfully
**Result: PASS**

### Check: Tests pass
**Command run:**
  npm test
**Output observed:**
  All tests passed
**Result: PASS**

VERDICT: PASS
`;
    const result = parseVerifierVerdict(multipleBlocks);
    expect(result.success).toBe(true);
    expect(result.verdict?.checkBlocks.length).toBe(2);
  });

  test('handles verdict without check blocks', () => {
    const simpleVerdict = 'VERDICT: PASS';
    const result = parseVerifierVerdict(simpleVerdict);
    expect(result.success).toBe(true);
    expect(result.verdict?.verdict).toBe('PASS');
    expect(result.verdict?.checkBlocks.length).toBe(0);
    expect(result.verdict?.hasCommandRun).toBe(false);
  });
});
