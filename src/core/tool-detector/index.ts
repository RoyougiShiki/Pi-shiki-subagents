/**
 * Tool-Detector — detect tool changes and suggest mapping.md updates.
 *
 * Usage (Pi adapter):
 *   const tools = pi.getAllTools().map(t => ({ name: t.name, description: t.description, source: detectSource(t) }));
 *   const changes = compareToBaseline(tools, baseline);
 *   if (changes.length > 0) notify user with generateMappingSuggestion(changes);
 */

export type { Baseline, ToolChange, ToolInfo } from "./types";
export { compareToBaseline, createBaseline, generateMappingSuggestion } from "./detector";
