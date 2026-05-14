/**
 * Tool-Detector types — platform-agnostic.
 */

/** A tool as seen by the agent platform. */
export interface ToolInfo {
  name: string;
  description: string;
  source: "builtin" | "extension" | "mcp" | "sdk" | "unknown";
}

/** A detected change between baseline and current tool set. */
export interface ToolChange {
  type: "added" | "removed" | "description_changed";
  tool: ToolInfo;
  previousDescription?: string;
}

/** Baseline snapshot stored after verification. */
export interface Baseline {
  /** ISO timestamp of when the baseline was last verified. */
  verifiedAt: string;
  tools: ToolInfo[];
}
