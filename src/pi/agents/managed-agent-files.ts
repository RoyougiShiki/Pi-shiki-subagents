import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultAgentPromptsDir } from "../../adapters/default-agent-assets";
import { AGENT_PROMPTS, reloadAgentPrompts } from "../meeting/pi-agents";

interface AgentModelConfig {
  model?: string;
}

interface AgentSyncConfig {
  preset?: string;
  presets?: Record<string, Record<string, AgentModelConfig | unknown> | undefined>;
  agents?: Record<string, AgentModelConfig | unknown>;
}

const DEFAULT_MODELS: Record<string, string> = {
  oracle: "openai/gpt-4.1",
  fixer: "openai/gpt-4o-mini",
};

function getDefaultModel(
  agentName: string,
  config: AgentSyncConfig | null,
): string {
  if (!config) return DEFAULT_MODELS[agentName] ?? "openai/gpt-4o-mini";
  const presetName = config.preset ?? "default";
  const preset = config.presets?.[presetName];
  const agentOverride = preset?.[agentName];
  const agentsOverride = config.agents?.[agentName];

  return (
    (agentOverride as any)?.model ??
    (agentsOverride as any)?.model ??
    DEFAULT_MODELS[agentName] ??
    "openai/gpt-4o-mini"
  );
}

function getManagedAgentSourceHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function withManagedAgentMetadata(content: string): string {
  const sourceHash = getManagedAgentSourceHash(content);
  if (!content.startsWith("---\n")) {
    return content;
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return content;
  }
  const block = content.slice(4, end);
  const body = content.slice(end);
  const metadata = [
    "omo-managed: true",
    `omo-source-hash: ${sourceHash}`,
  ];
  const nextBlock = [
    ...block.split("\n").filter((line) => !/^omo-(managed|source-hash):/.test(line.trim())),
    ...metadata,
  ].join("\n");
  return `---\n${nextBlock}${body}`;
}

function parseAgentFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---", 4);
  if (end === -1) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim();
  }
  return frontmatter;
}

function isManagedAgentContent(content: string): boolean {
  return parseAgentFrontmatter(content)["omo-managed"] === "true";
}

function stripManagedMetadata(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^omo-(managed|source-hash):/.test(line.trim()))
    .join("\n");
}

function normalizeAgentContentForComparison(content: string): string {
  return stripManagedMetadata(content)
    .split("\n")
    .filter((line) => !/^(model|thinking|tools):/.test(line.trim()))
    .join("\n")
    .trim();
}

const LEGACY_GENERATED_AGENT_BODY_MARKERS: Record<string, readonly RegExp[]> = {
  "oracle.md": [/You are Oracle - a strategic technical advisor and code reviewer\./],
  "fixer.md": [/You are Fixer\b/, /Fast implementation specialist/],
};

function getAgentNameFromFileLabel(label: string): string {
  return label.replace(/\.md$/, "");
}

function getAgentBody(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? content : content.slice(end + 4).trim();
}

function isLegacyGeneratedAgentContent(existing: string, label: string): boolean {
  const frontmatter = parseAgentFrontmatter(existing);
  if (frontmatter.name !== getAgentNameFromFileLabel(label)) return false;
  const body = getAgentBody(existing);
  const markers = LEGACY_GENERATED_AGENT_BODY_MARKERS[label] ?? [];
  return markers.some((marker) => marker.test(body));
}

function isLegacyOmoAgentContent(existing: string, sourceContent: string, label: string): boolean {
  return normalizeAgentContentForComparison(existing) === normalizeAgentContentForComparison(sourceContent) ||
    isLegacyGeneratedAgentContent(existing, label);
}

interface AgentFileSyncOptions {
  quiet?: boolean;
}

function logAgentFileSync(message: string, options?: AgentFileSyncOptions): void {
  if (!options?.quiet) console.error(`[oh-my-opencode-slim] ${message}`);
}

function writeManagedAgentFile(target: string, managedContent: string, label: string, options?: AgentFileSyncOptions): "updated" {
  const existing = fs.readFileSync(target, "utf-8");
  fs.writeFileSync(`${target}.bak`, existing, "utf-8");
  fs.writeFileSync(target, managedContent, "utf-8");
  logAgentFileSync(`Updated managed agent file: ${label}`, options);
  return "updated";
}

function syncAgentFile(target: string, sourceContent: string, label: string, options?: AgentFileSyncOptions): "created" | "updated" | "skipped" {
  const managedContent = withManagedAgentMetadata(sourceContent);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, managedContent, "utf-8");
    logAgentFileSync(`Generated agent file: ${label}`, options);
    return "created";
  }

  const existing = fs.readFileSync(target, "utf-8");
  if (!isManagedAgentContent(existing)) {
    if (!isLegacyOmoAgentContent(existing, sourceContent, label)) {
      return "skipped";
    }
    return writeManagedAgentFile(target, managedContent, label, options);
  }
  if (existing === managedContent) {
    return "skipped";
  }

  return writeManagedAgentFile(target, managedContent, label, options);
}

function generateAgentMd(
  name: string,
  prompt: string,
  description: string,
): string {
  return `---
name: ${name}
description: ${description}
---

${prompt}
`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function escapeTomlMultilineString(value: string): string {
  // TOML multiline basic strings end at triple quotes; split accidental
  // occurrences so generated agent prompts remain parseable.
  return value.replace(/"""/g, '""\\"');
}

function generateAgentToml(
  name: string,
  prompt: string,
  description: string,
  model: string,
): string {
  return `name = "${escapeTomlBasicString(name)}"
description = "${escapeTomlBasicString(description)}"
model = "${escapeTomlBasicString(model)}"
reasoning = "low"
prompt = """${escapeTomlMultilineString(prompt)}
"""
`;
}

export function getPiAgentsDirForSync(): string {
  return path.join(path.dirname(getAgentDir()), "agents");
}

function removeStaleManagedAgentFiles(agentsDir: string, sourceFiles: Set<string>): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(agentsDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith(".md") || sourceFiles.has(file)) continue;
    const target = path.join(agentsDir, file);
    let existing = "";
    try {
      existing = fs.readFileSync(target, "utf-8");
    } catch {
      continue;
    }
    if (!isManagedAgentContent(existing)) continue;
    try {
      fs.writeFileSync(`${target}.bak`, existing, "utf-8");
      fs.rmSync(target, { force: true });
      logAgentFileSync(`Removed stale managed agent file: ${file}`);
    } catch {}
  }
}

export function ensureAgentFiles(): void {
  const agentsDir = getPiAgentsDirForSync();
  const defaultAgentsDir = getDefaultAgentPromptsDir();
  fs.mkdirSync(agentsDir, { recursive: true });
  try {
    if (!fs.existsSync(defaultAgentsDir)) return;
    const files = fs.readdirSync(defaultAgentsDir).filter((file) => file.endsWith(".md"));
    const sourceFiles = new Set(files);
    removeStaleManagedAgentFiles(agentsDir, sourceFiles);
    for (const file of files) {
      const target = path.join(agentsDir, file);
      const content = fs.readFileSync(path.join(defaultAgentsDir, file), "utf-8");
      syncAgentFile(target, content, file);
    }
    reloadAgentPrompts();
  } catch {}
}

export function updateAgentModels(config: AgentSyncConfig | null, presetName: string): void {
  const agentsDir = getPiAgentsDirForSync();
  const preset = config?.presets?.[presetName];
  if (!preset) return;

  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    const agentOverride = preset[name] as { model?: string } | undefined;
    const model = agentOverride?.model ?? getDefaultModel(name, config);

    const mdPath = path.join(agentsDir, `${name}.md`);
    if (fs.existsSync(mdPath)) {
      const content = generateAgentMd(name, info.prompt, info.description);
      syncAgentFile(mdPath, content, `${name}.md`, { quiet: true });
    }

    const tomlPath = path.join(agentsDir, `${name}.toml`);
    if (fs.existsSync(tomlPath)) {
      const content = generateAgentToml(name, info.prompt, info.description, model);
      fs.writeFileSync(tomlPath, content, "utf-8");
    }
  }
}
