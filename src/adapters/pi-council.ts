import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_PROMPTS } from "./pi-agents";
import type { OmniMoConfig, PiCouncilParticipantConfig } from "./pi";

// ─── Pi Council helpers ───────────────────────────────────────────────────

export interface PiCouncilParticipant {
  name: string;
  agent: string;
  model?: string;
  variant?: string;
  prompt?: string;
}

export interface PiCouncilRunResult {
  name: string;
  agent: string;
  model?: string;
  status: "completed" | "failed" | "timed_out";
  result?: string;
  error?: string;
}

function normalizeCouncilParticipant(
  key: string,
  raw: PiCouncilParticipantConfig,
): PiCouncilParticipant {
  const name = raw.name?.trim() || key;
  const agent = raw.agent?.trim() || name;
  return {
    name,
    agent,
    model: raw.model?.trim() || undefined,
    variant: raw.variant?.trim() || undefined,
    prompt: raw.prompt?.trim() || undefined,
  };
}

export function resolvePiCouncilParticipants(args: {
  config: OmniMoConfig | null;
  preset?: string;
  participants?: PiCouncilParticipantConfig[];
}): { participants: PiCouncilParticipant[]; error?: string } {
  if (args.participants && args.participants.length > 0) {
    return {
      participants: args.participants.map((raw, index) =>
        normalizeCouncilParticipant(raw.name || raw.agent || `participant-${index + 1}`, raw),
      ),
    };
  }

  const council = args.config?.council;
  if (!council?.presets) {
    return {
      participants: [],
      error:
        'Council is not configured. Add council.presets to oh-my-opencode-slim.json/jsonc, or pass participants[].',
    };
  }

  const presetName = args.preset ?? council.default_preset ?? "default";
  const preset = council.presets[presetName];
  if (!preset) {
    const available = Object.keys(council.presets).join(", ") || "(none)";
    return {
      participants: [],
      error: `Council preset "${presetName}" not found. Available presets: ${available}`,
    };
  }

  const participants = Object.entries(preset)
    .filter(([key]) => key !== "master")
    .map(([key, raw]) => normalizeCouncilParticipant(key, raw));

  if (participants.length === 0) {
    return {
      participants,
      error: `Council preset "${presetName}" has no participants.`,
    };
  }

  return { participants };
}

function formatPiCouncilPrompt(question: string, participant: PiCouncilParticipant): string {
  const role = participant.prompt ? `${participant.prompt}\n\n---\n\n` : "";
  return `${role}You are councillor "${participant.name}" in an isolated council.\n\n` +
    `Analyze the question independently. Do not assume other councillors' views. ` +
    `Return concrete findings, risks, and recommendations.\n\n` +
    `Question:\n${question}`;
}

export function extractAssistantTextFromMessages(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

export function resolvePiModel(ctx: ExtensionContext, modelId: string | undefined): any | undefined {
  if (!modelId) return undefined;
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  const provider = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  return ctx.modelRegistry.find(provider, model);
}

export async function runPiCouncilParticipant(args: {
  participant: PiCouncilParticipant;
  question: string;
  ctx: ExtensionContext;
  timeoutMs: number;
}): Promise<PiCouncilRunResult> {
  const { participant, question, ctx, timeoutMs } = args;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const model = resolvePiModel(ctx, participant.model);
    if (participant.model && !model) {
      return {
        name: participant.name,
        agent: participant.agent,
        model: participant.model,
        status: "failed",
        error: `Model not found: ${participant.model}`,
      };
    }

    const created = await (createAgentSession as any)({
      cwd: ctx.cwd,
      model,
      thinkingLevel: "low",
      tools: ["read", "bash", "grep", "find", "ls"],
      sessionManager: SessionManager.inMemory(),
      appendSystemPrompt: "__OMO_SUB_AGENT__",
    });
    session = created.session;
    if (!session) {
      return { name: participant.name, agent: participant.agent, status: "failed" as const, error: "Failed to create agent session" };
    }

    const prompt = `${AGENT_PROMPTS[participant.agent]?.prompt ?? ""}\n\n${formatPiCouncilPrompt(question, participant)}`;
    const promptPromise = session.prompt(prompt, { source: "extension" });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Council participant timed out")), timeoutMs);
    });

    await Promise.race([promptPromise, timeoutPromise]);
    const text = extractAssistantTextFromMessages((session as any).state?.messages ?? (session as any).messages ?? []);

    return {
      name: participant.name,
      agent: participant.agent,
      model: participant.model,
      status: "completed",
      result: text || "(completed with no text output)",
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return {
      name: participant.name,
      agent: participant.agent,
      model: participant.model,
      status: message.includes("timed out") ? "timed_out" : "failed",
      error: message,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (session) {
      try {
        await session.abort();
      } catch {
        // ignore
      }
      session.dispose();
    }
  }
}

export function formatPiCouncilResults(
  question: string,
  results: PiCouncilRunResult[],
): string {
  const completed = results.filter((r) => r.status === "completed");
  const failed = results.filter((r) => r.status !== "completed");

  const details = results
    .map((r) => {
      const model = r.model ? ` (${r.model})` : "";
      if (r.status !== "completed") {
        return `### ${r.name}${model}\nStatus: ${r.status}\nError: ${r.error ?? "Unknown"}`;
      }
      return `### ${r.name}${model}\n${r.result ?? "(no output)"}`;
    })
    .join("\n\n");

  const confidence = failed.length === 0
    ? "all participants completed"
    : completed.length > 0
      ? "partial council"
      : "all participants failed";

  return `## Isolated Council Results\n\nOriginal question:\n${question}\n\n` +
    `Completed: ${completed.length}/${results.length} (${confidence})\n\n` +
    `${details}\n\n` +
    `---\nSynthesize these independent councillor responses. Preserve disagreements and cite councillors by name.`;
}
