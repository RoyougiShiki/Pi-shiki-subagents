/**
 * Verifier Verdict Parser — 解析 verifier agent 输出
 *
 * 设计原则：
 * - 纯函数，无 Pi API 依赖
 * - 解析格式来自 cc-haha verificationAgent prompt contract
 * - 不依赖具体 agent 名/工具名
 *
 * 用途：
 * - 解析独立 verifier 输出的 VERDICT: PASS|FAIL|PARTIAL
 * - 提取 Command run / Output observed / Result 证据块
 * - 为 completion auditor 提供强验证证据类型
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type VerifierVerdictStatus = 'PASS' | 'FAIL' | 'PARTIAL';

export interface VerifierCheckBlock {
  checkDescription: string;
  commandRun: string;
  outputObserved: string;
  result: 'PASS' | 'FAIL';
  expectedVsActual?: string;
}

export interface VerifierVerdict {
  verdict: VerifierVerdictStatus;
  checkBlocks: VerifierCheckBlock[];
  hasCommandRun: boolean;
  hasOutputObserved: boolean;
  failDetails?: string;
  partialDetails?: string;
}

export interface VerifierVerdictParseResult {
  success: boolean;
  verdict?: VerifierVerdict;
  error?: string;
}

// ─── Default Patterns (Single Source of Truth) ─────────────────────────────

const VERDICT_PATTERN = /^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/m;

const CHECK_BLOCK_PATTERN =
  /### Check:\s*(.+?)\n\*\*Command run:\*\*\n([\s\S]*?)\n\*\*Output observed:\*\*\n([\s\S]*?)\n\*\*Result:\s*(PASS|FAIL)\*\*/g;

const EXPECTED_VS_ACTUAL_PATTERN = /\*\*Expected vs Actual:\*\*\s*(.+?)\n/;

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractVerdictStatus(text: string): VerifierVerdictStatus | null {
  const match = text.match(VERDICT_PATTERN);
  if (!match) return null;
  const status = match[1];
  if (status === 'PASS' || status === 'FAIL' || status === 'PARTIAL') {
    return status;
  }
  return null;
}

function extractCheckBlocks(text: string): VerifierCheckBlock[] {
  const blocks: VerifierCheckBlock[] = [];
  const pattern = new RegExp(
    CHECK_BLOCK_PATTERN.source,
    CHECK_BLOCK_PATTERN.flags,
  );

  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const checkDescription = (match[1] ?? '').trim();
    const commandRun = (match[2] ?? '').trim();
    const outputObserved = (match[3] ?? '').trim();
    const result = match[4] === 'PASS' ? 'PASS' : 'FAIL';

    const expectedMatch = text
      .slice(match.index)
      .match(EXPECTED_VS_ACTUAL_PATTERN);
    const expectedVsActual = expectedMatch?.[1]?.trim();

    blocks.push({
      checkDescription,
      commandRun,
      outputObserved,
      result,
      expectedVsActual,
    });
    match = pattern.exec(text);
  }
  return blocks;
}

function hasCommandRunBlocks(blocks: VerifierCheckBlock[]): boolean {
  return blocks.some((block) => block.commandRun.length > 0);
}

function hasOutputObservedBlocks(blocks: VerifierCheckBlock[]): boolean {
  return blocks.some((block) => block.outputObserved.length > 0);
}

function extractFailDetails(text: string): string | undefined {
  if (!text.includes('VERDICT: FAIL')) return undefined;

  // 提取 FAIL 后的说明文字
  const failSection = text.slice(text.indexOf('VERDICT: FAIL'));
  const lines = failSection.split('\n').slice(1, 10);
  return lines
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

function extractPartialDetails(text: string): string | undefined {
  if (!text.includes('VERDICT: PARTIAL')) return undefined;

  const partialSection = text.slice(text.indexOf('VERDICT: PARTIAL'));
  const lines = partialSection.split('\n').slice(1, 10);
  return lines
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * 解析 verifier agent 输出
 *
 * @param text verifier 输出文本
 * @returns 解析结果
 */
export function parseVerifierVerdict(text: string): VerifierVerdictParseResult {
  if (!text || text.trim().length === 0) {
    return { success: false, error: 'Empty text' };
  }

  const verdictStatus = extractVerdictStatus(text);
  if (!verdictStatus) {
    return {
      success: false,
      error: 'No VERDICT: PASS|FAIL|PARTIAL line found',
    };
  }

  const checkBlocks = extractCheckBlocks(text);

  const verdict: VerifierVerdict = {
    verdict: verdictStatus,
    checkBlocks,
    hasCommandRun: hasCommandRunBlocks(checkBlocks),
    hasOutputObserved: hasOutputObservedBlocks(checkBlocks),
    failDetails:
      verdictStatus === 'FAIL' ? extractFailDetails(text) : undefined,
    partialDetails:
      verdictStatus === 'PARTIAL' ? extractPartialDetails(text) : undefined,
  };

  return { success: true, verdict };
}

/**
 * 判断文本是否包含 verifier verdict 格式
 *
 * @param text 待检测文本
 * @returns 是否包含 VERDICT 行
 */
export function hasVerifierVerdict(text: string): boolean {
  return VERDICT_PATTERN.test(text);
}

/**
 * 获取 verdict 状态（不解析完整结构）
 *
 * @param text 待检测文本
 * @returns verdict 状态或 null
 */
export function getVerdictStatus(text: string): VerifierVerdictStatus | null {
  return extractVerdictStatus(text);
}
