/**
 * Tool-Detector core — platform-agnostic logic.
 *
 * Responsibilities:
 *   1. Compare current tool list against a stored baseline
 *   2. Report what changed (added / removed / description changed)
 *   3. Generate a human-readable suggestion for updating the disambiguation table
 *
 * Pure functions — no IO, no platform APIs.
 */

import type { Baseline, ToolChange, ToolInfo } from "./types";

/**
 * Compare current tools against a baseline and return any changes.
 * Returns empty array if no changes detected.
 */
export function compareToBaseline(
  current: ToolInfo[],
  baseline: ToolInfo[],
): ToolChange[] {
  const changes: ToolChange[] = [];
  const baselineMap = new Map(baseline.map((t) => [t.name, t]));
  const currentMap = new Map(current.map((t) => [t.name, t]));

  for (const tool of current) {
    const existing = baselineMap.get(tool.name);
    if (!existing) {
      changes.push({ type: "added", tool });
    } else if (existing.description !== tool.description) {
      changes.push({
        type: "description_changed",
        tool,
        previousDescription: existing.description,
      });
    }
  }

  for (const tool of baseline) {
    if (!currentMap.has(tool.name)) {
      changes.push({ type: "removed", tool });
    }
  }

  return changes;
}

/**
 * Build a human-readable suggestion for updating the disambiguation table.
 * Returns empty string if no changes detected.
 */
export function generateDisambiguationSuggestion(changes: ToolChange[]): string {
  if (changes.length === 0) return "";

  const parts: string[] = [];
  parts.push("## Tool Changes Detected\n");

  const added = changes.filter((c) => c.type === "added");
  const removed = changes.filter((c) => c.type === "removed");
  const changed = changes.filter((c) => c.type === "description_changed");

  if (added.length > 0) {
    parts.push("**New tools:**");
    for (const c of added) {
      parts.push(`- \`${c.tool.name}\` — ${c.tool.description} (${c.tool.source})`);
    }
    parts.push("");
    parts.push(
      "Check if any of these overlap semantically with existing tools. " +
      "If so, add a disambiguation entry. If not, no action needed.\n",
    );
  }

  if (removed.length > 0) {
    parts.push("**Removed tools (no longer available):**");
    for (const c of removed) {
      parts.push(`- \`${c.tool.name}\``);
    }
    parts.push("");
    parts.push("If these had disambiguation entries, remove or update them.\n");
  }

  if (changed.length > 0) {
    parts.push("**Description changed:**");
    for (const c of changed) {
      parts.push(
        `- \`${c.tool.name}\`: "${c.previousDescription}" → "${c.tool.description}"`,
      );
    }
    parts.push("");
    parts.push("Review if the description change affects existing disambiguation entries.\n");
  }

  parts.push(
    "To update the disambiguation table, edit the file at the configured path " +
    "and verify the new baseline with the adapter.",
  );

  return parts.join("\n");
}

/**
 * Create a fresh baseline from a tool list.
 */
export function createBaseline(tools: ToolInfo[]): Baseline {
  return {
    verifiedAt: new Date().toISOString(),
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
