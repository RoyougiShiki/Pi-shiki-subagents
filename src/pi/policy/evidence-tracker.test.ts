import { describe, expect, test, beforeEach } from 'bun:test';
import {
  recordEvidence,
  getEvidences,
  getEvidencesByTool,
  getWriteEvidences,
  verifyCompletion,
  auditEvidence,
  resetEvidence,
} from './evidence-tracker';

describe('EvidenceTracker', () => {
  beforeEach(() => {
    resetEvidence();
  });

  test('recordEvidence adds to list', () => {
    recordEvidence('read', 'call-1', { path: '/foo' }, 'content', true);

    const evidences = getEvidences();
    expect(evidences).toHaveLength(1);
    expect(evidences[0].toolName).toBe('read');
    expect(evidences[0].success).toBe(true);
  });

  test('getEvidencesByTool filters by tool', () => {
    recordEvidence('read', 'call-1', {}, 'result1', true);
    recordEvidence('write', 'call-2', {}, 'result2', true);
    recordEvidence('read', 'call-3', {}, 'result3', true);

    const readEvidences = getEvidencesByTool('read');
    expect(readEvidences).toHaveLength(2);
  });

  test('getWriteEvidences returns write/edit/bash', () => {
    recordEvidence('read', 'call-1', {}, 'result', true);
    recordEvidence('write', 'call-2', {}, 'result', true);
    recordEvidence('edit', 'call-3', {}, 'result', true);
    recordEvidence('bash', 'call-4', {}, 'result', true);

    const writeEvidences = getWriteEvidences();
    expect(writeEvidences).toHaveLength(3);
  });

  test('getWriteEvidences excludes failed', () => {
    recordEvidence('write', 'call-1', {}, 'result', false);
    recordEvidence('write', 'call-2', {}, 'result', true);

    const writeEvidences = getWriteEvidences();
    expect(writeEvidences).toHaveLength(1);
  });

  test('verifyCompletion with evidence passes', () => {
    recordEvidence('write', 'call-1', { path: '/foo' }, 'success', true);

    const result = verifyCompletion('Fixed the bug');
    expect(result.hasEvidence).toBe(true);
    expect(result.evidence).toHaveLength(1);
  });

  test('verifyCompletion without evidence fails', () => {
    const result = verifyCompletion('Fixed the bug');
    expect(result.hasEvidence).toBe(false);
    expect(result.missingEvidence).toBeDefined();
  });

  test('auditEvidence generates report', () => {
    recordEvidence('read', 'call-1', {}, 'result', true);
    recordEvidence('write', 'call-2', {}, 'result', true);
    recordEvidence('edit', 'call-3', {}, 'result', true);
    recordEvidence('bash', 'call-4', {}, 'result', false);

    const report = auditEvidence();
    expect(report.auditInfo.totalToolCalls).toBe(4);
    expect(report.auditInfo.successfulCalls).toBe(3);
    expect(report.auditInfo.failedCalls).toBe(1);
    // bash with success=false is not counted as write operation
    expect(report.auditInfo.writeOperations).toBe(2);
  });

  test('resetEvidence clears all', () => {
    recordEvidence('read', 'call-1', {}, 'result', true);
    expect(getEvidences()).toHaveLength(1);

    resetEvidence();
    expect(getEvidences()).toHaveLength(0);
  });
});
