import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { createRecoveredEvidenceSummaryState, updateRecoveredEvidenceSummaryState } from "./evidence-summary-state";
import { getEvidenceSummaryPath, loadEvidenceSummaryState, saveEvidenceSummaryState } from "./evidence-summary-persistence";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "omo-evidence-summary-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("evidence summary persistence", () => {
  test("saves and loads recovered evidence summary state", async () => {
    await withTempDir(async (dir) => {
      const state = updateRecoveredEvidenceSummaryState(createRecoveredEvidenceSummaryState(), {
        toolName: "edit",
        toolCallId: "edit-1",
        args: { path: "file.ts" },
        result: "edited",
        timestamp: 123,
        success: true,
      });

      expect(await saveEvidenceSummaryState(state, dir, "session-1")).toBe(true);
      const loaded = await loadEvidenceSummaryState(dir, "session-1");

      expect(loaded?.kinds).toContain("modification");
      expect(loaded?.lastModifiedAt).toBe(123);
    });
  });

  test("missing or invalid state returns null", async () => {
    const warnSpy = spyOn(console, "warn");
    try {
      await withTempDir(async (dir) => {
        expect(await loadEvidenceSummaryState(dir, "missing-session")).toBeNull();

        await saveEvidenceSummaryState(createRecoveredEvidenceSummaryState(), dir, "broken-session");
        await writeFile(getEvidenceSummaryPath(dir, "broken-session"), "not json", "utf8");

        expect(await loadEvidenceSummaryState(dir, "broken-session")).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
