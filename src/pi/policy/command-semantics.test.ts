import { describe, expect, test } from "bun:test";
import {
  interpretCommandSemantic,
  getDefaultCommandSemantics,
  type CommandSemanticConfig,
} from "./command-semantics";

describe("command semantics", () => {
  test("treats exit code 0 as success for unknown commands", () => {
    const result = interpretCommandSemantic("git status", 0);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("success");
    expect(result.message).toBeUndefined();
  });

  test("treats non-zero exit code as error for unknown commands", () => {
    const result = interpretCommandSemantic("git status", 1);
    expect(result.isError).toBe(true);
    expect(result.semantic).toBe("error");
    expect(result.message).toContain("exit code 1");
  });

  test("treats grep exit code 1 as no_matches, not error", () => {
    const result = interpretCommandSemantic("grep -R pattern src", 1);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("no_matches");
    expect(result.message).toBe("No matches found");
  });

  test("treats grep exit code 0 as success", () => {
    const result = interpretCommandSemantic("grep pattern file.txt", 0);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("success");
  });

  test("treats grep exit code 2 as error", () => {
    const result = interpretCommandSemantic("grep pattern missing_file", 2);
    expect(result.isError).toBe(true);
    expect(result.semantic).toBe("error");
  });

  test("treats rg (ripgrep) same as grep", () => {
    const result = interpretCommandSemantic("rg pattern src", 1);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("no_matches");
  });

  test("treats find exit code 1 as partial_success, not error", () => {
    const result = interpretCommandSemantic("find / -name file", 1);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("partial_success");
    expect(result.message).toBe("Some directories were inaccessible");
  });

  test("treats diff exit code 1 as files_differ, not error", () => {
    const result = interpretCommandSemantic("diff file1.txt file2.txt", 1);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("files_differ");
  });

  test("treats test exit code 1 as condition_false, not error", () => {
    const result = interpretCommandSemantic("test -f missing_file", 1);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("condition_false");
  });

  test("supports config override", () => {
    const customConfig: CommandSemanticConfig = {
      myapp: {
        exitCodeMap: { 0: "success", 3: "no_matches" },
        defaultSemantic: "error",
        messages: { 3: "No results" },
      },
    };

    const result = interpretCommandSemantic("myapp search query", 3, customConfig);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("no_matches");
    expect(result.message).toBe("No results");
  });

  test("getDefaultCommandSemantics returns copy", () => {
    const defaults = getDefaultCommandSemantics();
    expect(defaults.grep).toBeDefined();
    expect(defaults.rg).toBeDefined();
    expect(defaults.find).toBeDefined();
    // Mutating copy does not affect module defaults
    defaults.grep.exitCodeMap[99] = "success";
    const fresh = getDefaultCommandSemantics();
    expect(fresh.grep.exitCodeMap[99]).toBeUndefined();
  });

  test("handles empty command text", () => {
    const result = interpretCommandSemantic("", 0);
    expect(result.isError).toBe(false);
    expect(result.semantic).toBe("success");
  });
});