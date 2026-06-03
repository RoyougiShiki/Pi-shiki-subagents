import { describe, test, expect, beforeEach } from "bun:test";
import {
  recordDeniedToolCall,
  isDeniedToolCall,
  getDeniedToolCalls,
  resetDeniedToolMemory,
  buildDeniedToolGuardMessage,
  type DeniedToolCallRecord,
} from "./denied-tool-memory";

describe("DeniedToolMemory", () => {
  beforeEach(() => {
    resetDeniedToolMemory();
  });

  describe("recordDeniedToolCall", () => {
    test("records a denied tool call", () => {
      recordDeniedToolCall("bash", { command: "rm -rf /" }, "dangerous command");
      const records = getDeniedToolCalls();
      expect(records).toHaveLength(1);
      expect(records[0].toolName).toBe("bash");
      expect(records[0].reason).toBe("dangerous command");
    });

    test("updates existing record with same toolName and inputHash", () => {
      recordDeniedToolCall("bash", { command: "rm -rf /" }, "reason 1");
      recordDeniedToolCall("bash", { command: "rm -rf /" }, "reason 2");
      const records = getDeniedToolCalls();
      expect(records).toHaveLength(1);
      expect(records[0].reason).toBe("reason 2");
    });

    test("records different calls separately", () => {
      recordDeniedToolCall("bash", { command: "rm -rf /" }, "reason 1");
      recordDeniedToolCall("bash", { command: "ls" }, "reason 2");
      const records = getDeniedToolCalls();
      expect(records).toHaveLength(2);
    });

    test("respects maxRecords option", () => {
      for (let i = 0; i < 150; i++) {
        recordDeniedToolCall("bash", { command: `cmd${i}` }, "reason", { maxRecords: 100 });
      }
      const records = getDeniedToolCalls();
      expect(records.length).toBeLessThanOrEqual(100);
    });
  });

  describe("isDeniedToolCall", () => {
    test("returns null for non-existent call", () => {
      const result = isDeniedToolCall("bash", { command: "ls" });
      expect(result).toBeNull();
    });

    test("returns record for existing call", () => {
      recordDeniedToolCall("bash", { command: "rm -rf /" }, "dangerous");
      const result = isDeniedToolCall("bash", { command: "rm -rf /" });
      expect(result).not.toBeNull();
      expect(result?.toolName).toBe("bash");
      expect(result?.reason).toBe("dangerous");
    });

    test("ignores non-key fields in hash", () => {
      recordDeniedToolCall("bash", { command: "ls", timeout: 1000 }, "reason");
      // timeout is not a key field for bash, so this should match
      const result = isDeniedToolCall("bash", { command: "ls", timeout: 2000 });
      expect(result).not.toBeNull();
    });

    test("returns null after TTL expires", () => {
      recordDeniedToolCall("bash", { command: "ls" }, "reason", { ttlMs: 10 });
      // Wait for TTL to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const result = isDeniedToolCall("bash", { command: "ls" });
          expect(result).toBeNull();
          resolve();
        }, 20);
      });
    });
  });

  describe("getDeniedToolCalls", () => {
    test("returns copy of records", () => {
      recordDeniedToolCall("bash", { command: "ls" }, "reason");
      const records1 = getDeniedToolCalls();
      const records2 = getDeniedToolCalls();
      expect(records1).not.toBe(records2);
      expect(records1).toEqual(records2);
    });

    test("cleans expired records", () => {
      recordDeniedToolCall("bash", { command: "ls" }, "reason", { ttlMs: 10 });
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const records = getDeniedToolCalls();
          expect(records).toHaveLength(0);
          resolve();
        }, 20);
      });
    });
  });

  describe("buildDeniedToolGuardMessage", () => {
    test("builds guard message", () => {
      const record: DeniedToolCallRecord = {
        toolName: "bash",
        inputHash: "hash",
        displayInput: '{"command":"rm -rf /"}',
        reason: "dangerous command",
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
      };
      const message = buildDeniedToolGuardMessage(record);
      expect(message).toContain("bash");
      expect(message).toContain("dangerous command");
      expect(message).toContain("[guard]");
    });
  });

  describe("input hash computation", () => {
    test("uses key fields for read tool", () => {
      recordDeniedToolCall("read", { path: "/tmp/file.txt", limit: 100 }, "reason");
      // limit is not a key field, so this should match
      const result = isDeniedToolCall("read", { path: "/tmp/file.txt", limit: 200 });
      expect(result).not.toBeNull();
    });

    test("uses key fields for edit tool", () => {
      recordDeniedToolCall(
        "edit",
        { path: "/tmp/file.txt", oldText: "foo", newText: "bar" },
        "reason",
      );
      const result = isDeniedToolCall(
        "edit",
        { path: "/tmp/file.txt", oldText: "foo", newText: "bar" },
      );
      expect(result).not.toBeNull();
    });

    test("different key values produce different hashes", () => {
      recordDeniedToolCall("read", { path: "/tmp/file1.txt" }, "reason");
      const result = isDeniedToolCall("read", { path: "/tmp/file2.txt" });
      expect(result).toBeNull();
    });
  });
});
