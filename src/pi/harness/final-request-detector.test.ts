import { describe, test, expect } from "bun:test";
import {
  detectFinalRequest,
  detectFinalRequestFromMessages,
  DEFAULT_FINAL_REQUEST_PATTERNS,
  type UserMessage,
  type FinalRequestPatternConfig,
} from "./final-request-detector";

describe("FinalRequestDetector", () => {
  describe("DEFAULT_FINAL_REQUEST_PATTERNS", () => {
    test("has completion patterns", () => {
      expect(DEFAULT_FINAL_REQUEST_PATTERNS.completion).toBeDefined();
      expect(DEFAULT_FINAL_REQUEST_PATTERNS.completion!.length).toBeGreaterThan(0);
    });

    test("has statusCheck patterns", () => {
      expect(DEFAULT_FINAL_REQUEST_PATTERNS.statusCheck).toBeDefined();
      expect(DEFAULT_FINAL_REQUEST_PATTERNS.statusCheck!.length).toBeGreaterThan(0);
    });

    test("has anythingElse patterns", () => {
      expect(DEFAULT_FINAL_REQUEST_PATTERNS.anythingElse).toBeDefined();
      expect(DEFAULT_FINAL_REQUEST_PATTERNS.anythingElse!.length).toBeGreaterThan(0);
    });
  });

  describe("detectFinalRequest", () => {
    test("returns false for empty messages", () => {
      expect(detectFinalRequest([])).toBe(false);
    });

    test("returns false for non-final messages", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "帮我修复这个 bug" },
        { role: "user", content: "为什么用这个方案？" },
      ];
      expect(detectFinalRequest(messages)).toBe(false);
    });

    test("detects explicit completion request (Chinese)", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "做完了吗？" },
      ];
      expect(detectFinalRequest(messages)).toBe(true);
    });

    test("detects explicit completion request (English)", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "Are you done?" },
      ];
      expect(detectFinalRequest(messages)).toBe(true);
    });

    test("detects 'anything else' pattern", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "还有什么要做的吗" },
      ];
      expect(detectFinalRequest(messages)).toBe(true);
    });

    test("detects short status check as final request", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "进度？" },
      ];
      expect(detectFinalRequest(messages)).toBe(true);
    });

    test("does not detect long status description as final request", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "请详细说明当前的进度和遇到的问题" },
      ];
      expect(detectFinalRequest(messages)).toBe(false);
    });

    test("checks only recent messages", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "帮我修复这个 bug" },
        { role: "user", content: "为什么用这个方案？" },
        { role: "user", content: "好的，继续" },
        { role: "user", content: "做完了吗？" },
      ];
      // Default recentMessageCount = 3, so last 3 messages are checked
      expect(detectFinalRequest(messages)).toBe(true);
    });

    test("respects recentMessageCount option", () => {
      const messages: UserMessage[] = [
        { role: "user", content: "做完了吗？" },
        { role: "user", content: "好的，继续" },
        { role: "user", content: "帮我修复这个 bug" },
      ];
      // Only check last 1 message
      expect(detectFinalRequest(messages, { recentMessageCount: 1 })).toBe(false);
    });

    test("handles content array", () => {
      const messages: UserMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "做完了吗？" }],
        },
      ];
      expect(detectFinalRequest(messages)).toBe(true);
    });

    test("handles mixed content array", () => {
      const messages: UserMessage[] = [
        {
          role: "user",
          content: [
            { type: "image", url: "http://example.com/image.png" },
            { type: "text", text: "完成了吗" },
          ],
        },
      ];
      expect(detectFinalRequest(messages)).toBe(true);
    });
  });

  describe("detectFinalRequestFromMessages", () => {
    test("filters user messages from full message list", () => {
      const allMessages = [
        { role: "user", content: "帮我修复这个 bug" },
        { role: "assistant", content: "好的，我来处理" },
        { role: "user", content: "做完了吗？" },
        { role: "assistant", content: "是的，已完成" },
      ];
      expect(detectFinalRequestFromMessages(allMessages)).toBe(true);
    });

    test("returns false when no user messages", () => {
      const allMessages = [
        { role: "assistant", content: "好的" },
      ];
      expect(detectFinalRequestFromMessages(allMessages)).toBe(false);
    });
  });

  describe("custom patterns", () => {
    test("uses custom completion patterns", () => {
      const customPatterns: FinalRequestPatternConfig = {
        completion: ["custom-done-pattern"],
      };
      const messages: UserMessage[] = [
        { role: "user", content: "custom-done-pattern" },
      ];
      expect(detectFinalRequest(messages, { patterns: customPatterns })).toBe(true);
    });

    test("ignores default patterns when custom provided", () => {
      const customPatterns: FinalRequestPatternConfig = {
        completion: ["only-this-pattern"],
      };
      const messages: UserMessage[] = [
        { role: "user", content: "做完了吗？" }, // Default pattern, should not match
      ];
      expect(detectFinalRequest(messages, { patterns: customPatterns })).toBe(false);
    });
  });
});