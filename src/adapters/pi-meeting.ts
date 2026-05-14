import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_PROMPTS } from "./pi-agents";
import type { OmniMoConfig, PiCouncilParticipantConfig } from "./pi";
import {
  extractAssistantTextFromMessages,
  resolvePiCouncilParticipants,
  resolvePiModel,
  type PiCouncilParticipant,
} from "./pi-council";

// ── Load embedded participant Node scripts ──────────────────────────
const __participantDir = path.dirname(fileURLToPath(import.meta.url));
const POLL_SCRIPT = fs.readFileSync(path.join(__participantDir, "collab-poll.js"), "utf8");
const JOIN_SCRIPT = fs.readFileSync(path.join(__participantDir, "collab-join.js"), "utf8");
const SEND_SCRIPT = fs.readFileSync(path.join(__participantDir, "collab-send.js"), "utf8");

export type PiMeetingObjective = "brainstorm" | "review" | "design" | "debug" | "decision";

export interface PiMeetingRequest {
  meetingId: string;
  question: string;
  preset?: string;
  participants: PiCouncilParticipant[];
  objective: PiMeetingObjective;
  maxRounds: number;
  maxDurationMs: number;
  includeTranscript: boolean;
}

export interface PiMeetingMessage {
  id: string;
  meetingId: string;
  round: number;
  phase: "opening" | "discussion" | "final" | "chair";
  from: string;
  role: string;
  content: string;
  timestamp: number;
}

export interface PiMeetingParticipantResult {
  name: string;
  agent: string;
  model?: string;
  status: "completed" | "failed" | "timed_out";
  finalPosition?: string;
  error?: string;
}

export type PiMeetingBackendName = "session" | "collaborating";

export interface PiMeetingResult {
  meetingId: string;
  question: string;
  objective: PiMeetingObjective;
  status: "completed" | "partial" | "failed" | "timed_out";
  roundsCompleted: number;
  participants: PiMeetingParticipantResult[];
  report: string;
  keySignals: string[];
  transcript?: PiMeetingMessage[];
  requestedBackend: PiMeetingBackendName;
  backendUsed: PiMeetingBackendName;
  fallbackReason?: string;
}

export interface PiMeetingBackend {
  run(request: PiMeetingRequest, ctx: ExtensionContext): Promise<PiMeetingResult>;
}

export interface PiMeetingBackendResolution {
  requestedBackend: PiMeetingBackendName;
  backendUsed: PiMeetingBackendName;
  fallbackReason?: string;
  backend: PiMeetingBackend;
}

type CollabDirs = {
  base: string;
  registry: string;
  inbox: string;
  messageLog: string;
};

type CollabMessageLogEvent = {
  id: string;
  from: string;
  to: string | "all";
  text: string;
  kind: string;
  timestamp: string;
};

type CollabSpawnTask = {
  agent: string;
  task: string;
  cwd?: string;
};

type CollabSpawnAgentDefinition = {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "bundled" | "user" | "project";
  filePath: string;
};

type CollabSpawnResult = {
  name: string;
  exitCode: number;
  output: string;
  error?: string;
};

type CollabConfig = {
  subagentLaunchMode: "process" | "cmux-pane";
  closeCompletedCmuxPanes: boolean;
};

type CollabStoreModule = {
  registerSelf: (dirs: CollabDirs, registration: Record<string, unknown>) => boolean;
  unregisterSelf: (dirs: CollabDirs, owner: { name: string; pid: number; sessionId?: string }) => void;
  sendDirect: (
    dirs: CollabDirs,
    from: string,
    to: string,
    text: string,
    replyTo?: string,
    urgent?: boolean,
  ) => { ok: true } | { ok: false; error: string };
  readMessageLog: (dirs: CollabDirs) => CollabMessageLogEvent[];
};

type CollabPathsModule = { resolveDirs: () => CollabDirs };

type CollabSpawnModule = {
  runSpawnTask: (
    runtimeCwd: string,
    task: CollabSpawnTask,
    agentDef: CollabSpawnAgentDefinition,
    options: {
      index: number;
      runId: string;
      defaultCwd?: string;
      enableSessionControl?: boolean;
      recursionDepth: number;
      parentAgentName?: string;
      launchDelayMs?: number;
      launchMode?: "process" | "cmux-pane";
      closeCompletedCmuxPane?: boolean;
      cmuxResultTimeoutMs?: number;
      onLaunch?: (launch: { name: string }) => void | Promise<void>;
    },
  ) => Promise<CollabSpawnResult>;
};

type CollabConfigModule = { loadConfig: (cwd: string) => CollabConfig };

type MeetingEnvelope = {
  meetingId: string;
  phase: "opening" | "discussion" | "final";
  round: number;
  role: string;
  body: string;
};

const PI_MEETING_OBJECTIVES: PiMeetingObjective[] = ["brainstorm", "review", "design", "debug", "decision"];
const COLLAB_AGENT_PREFIX = "omo-collab-chair";
const POLL_INTERVAL_MS = 1000;
const PHASE_WAIT_MS = 45000;
const requireFromMeeting = createRequire(import.meta.url);
const COLLAB_PACKAGE_NAME = "@baochunli/pi-collaborating-agents";
const COLLAB_GLOBAL_PACKAGE_ROOT = path.join(homedir(), ".npm-global", "lib", "node_modules", COLLAB_PACKAGE_NAME);
const COLLAB_PI_EXTENSION_ROOT = path.join(homedir(), ".pi", "agent", "extensions", "collaborating-agents");

export function normalizePiMeetingObjective(value: string | undefined): PiMeetingObjective {
  return PI_MEETING_OBJECTIVES.includes(value as PiMeetingObjective)
    ? value as PiMeetingObjective
    : "decision";
}

export function normalizePiMeetingMaxRounds(value: number | undefined): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(5, Math.floor(value as number)));
}

export function normalizePiMeetingBackend(value: string | undefined): PiMeetingBackendName {
  // "persistent" is a deprecated alias for "collaborating"
  if (value === "persistent" || value === "collaborating") return "collaborating";
  return "session";
}

function createPiMeetingId(): string {
  return `omo-meet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncateForDigest(text: string, maxChars = 900): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

function extractKeySignalsFromReport(report: string): string[] {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((line) => /^### Key Signals From Discussion\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const signals: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^###\s+/.test(line)) break;
    const match = line.match(/^[-*]\s+(.+)/);
    if (match?.[1]?.trim()) signals.push(match[1].trim());
  }
  return signals;
}

function formatPiMeetingDigest(messages: PiMeetingMessage[]): string {
  if (messages.length === 0) return "(No prior meeting messages.)";

  const byPhase = (phase: PiMeetingMessage["phase"]) => messages.filter((m) => m.phase === phase);
  const formatMessages = (items: PiMeetingMessage[]) => items
    .slice(-8)
    .map((m) => `- ${m.from} (${m.role}, round ${m.round}): ${truncateForDigest(m.content, 500)}`)
    .join("\n") || "- (none)";

  return `## Current Hidden Meeting Digest\n\n` +
    `### Opening Positions\n${formatMessages(byPhase("opening"))}\n\n` +
    `### Discussion So Far\n${formatMessages(byPhase("discussion"))}\n\n` +
    `### Final Positions\n${formatMessages(byPhase("final"))}`;
}

function formatParticipantPrompt(args: {
  request: PiMeetingRequest;
  participant: PiCouncilParticipant;
  phase: "opening" | "discussion" | "final";
  round: number;
  digest: string;
}): string {
  const { request, participant, phase, round, digest } = args;
  const roleGuidance = participant.prompt ? `Role-specific guidance:\n${participant.prompt}\n\n` : "";
  const base = `${AGENT_PROMPTS[participant.agent]?.prompt ?? ""}\n\n` +
    `You are participant "${participant.name}" in a hidden OMO realtime meeting.\n` +
    `The main agent is not participating and will not see raw discussion noise.\n` +
    `Meeting ID: ${request.meetingId}\n` +
    `Objective: ${request.objective}\n\n` +
    `${roleGuidance}` +
    `Question:\n${request.question}\n\n`;

  if (phase === "opening") {
    return `${base}Give your opening position. Return concise sections:\n` +
      `Recommendation:\nAssumptions:\nRisks:\nEvidence needed:\nConfidence:\n`;
  }

  if (phase === "discussion") {
    return `${base}Meeting digest visible to you:\n${digest}\n\n` +
      `Discussion round ${round}. Return concise sections:\n` +
      `Challenge:\nResponse to another participant:\nUpdated view:\nKey signal for final decision:\nConfidence:\n` +
      `Do not repeat your opening statement unless your view changed.`;
  }

  return `${base}Meeting digest visible to you:\n${digest}\n\n` +
    `Give your final position. Return exactly these sections:\n` +
    `Recommendation:\nChanged view:\nRemaining disagreement:\nKey evidence:\nRisks:\nConfidence:\nNext action:\n`;
}

async function runPiMeetingParticipantTurn(args: {
  request: PiMeetingRequest;
  participant: PiCouncilParticipant;
  phase: "opening" | "discussion" | "final";
  round: number;
  digest: string;
  ctx: ExtensionContext;
  timeoutMs: number;
}): Promise<{ message?: PiMeetingMessage; result?: PiMeetingParticipantResult }> {
  const { request, participant, phase, round, digest, ctx, timeoutMs } = args;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const model = resolvePiModel(ctx, participant.model);
    if (participant.model && !model) {
      return {
        result: {
          name: participant.name,
          agent: participant.agent,
          model: participant.model,
          status: "failed",
          error: `Model not found: ${participant.model}`,
        },
      };
    }

    const created = await createAgentSession({
      cwd: ctx.cwd,
      model,
      thinkingLevel: "low",
      tools: ["read", "bash", "grep", "find", "ls"],
      sessionManager: SessionManager.inMemory(),
    });
    session = created.session;

    const prompt = formatParticipantPrompt({ request, participant, phase, round, digest });
    const promptPromise = session.prompt(prompt, { source: "extension" });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Meeting participant turn timed out")), timeoutMs);
    });

    await Promise.race([promptPromise, timeoutPromise]);
    const text = extractAssistantTextFromMessages((session as any).state?.messages ?? (session as any).messages ?? []);
    const content = text || "(completed with no text output)";

    return {
      message: {
        id: `${request.meetingId}-${phase}-${round}-${participant.name}`,
        meetingId: request.meetingId,
        round,
        phase,
        from: participant.name,
        role: participant.agent,
        content,
        timestamp: Date.now(),
      },
      result: phase === "final"
        ? {
            name: participant.name,
            agent: participant.agent,
            model: participant.model,
            status: "completed",
            finalPosition: content,
          }
        : undefined,
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return {
      result: {
        name: participant.name,
        agent: participant.agent,
        model: participant.model,
        status: message.includes("timed out") ? "timed_out" : "failed",
        error: message,
      },
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

function formatParticipantStatusLines(participants: PiMeetingParticipantResult[]): string {
  return participants
    .map((p) => {
      const detail = p.error ? ` — ${truncateForDigest(p.error, 220)}` : "";
      return `- ${p.name} (${p.agent}, ${p.status})${detail}`;
    })
    .join("\n");
}

function fallbackPiMeetingReport(result: Omit<PiMeetingResult, "report" | "keySignals">): string {
  const finalPositions = result.participants
    .map((p) => `- ${p.name} (${p.agent}, ${p.status}): ${truncateForDigest(p.finalPosition ?? p.error ?? "No final position", 700)}`)
    .join("\n");

  return `## Realtime Meeting Result\n\n` +
    `### Question\n${result.question}\n\n` +
    `### Objective\n${result.objective}\n\n` +
    `### Status\n${result.status}\n\n` +
    `### Participants\n${formatParticipantStatusLines(result.participants)}\n\n` +
    `### Recommendation\nReview the participant final positions below; hidden chair synthesis was unavailable.\n\n` +
    `### Consensus\nPartial consensus could not be automatically synthesized.\n\n` +
    `### Key Disagreements\nSee final positions.\n\n` +
    `### Key Signals From Discussion\n- Hidden meeting completed with deterministic fallback synthesis.\n\n` +
    `### Risks\n- Chair synthesis did not produce a structured report.\n\n` +
    `### Confidence\nLow to medium, depending on participant completion.\n\n` +
    `### Suggested Next Actions\n1. Use the final positions to make a constrained decision.\n2. Re-run with includeTranscript=true only if debugging the meeting runtime.\n\n` +
    `### Participant Final Positions\n${finalPositions || "- (none)"}\n\n` +
    `### Metadata\n- meetingId: ${result.meetingId}\n- roundsCompleted: ${result.roundsCompleted}\n- requestedBackend: ${result.requestedBackend}\n- backendUsed: ${result.backendUsed}${result.fallbackReason ? `\n- fallbackReason: ${result.fallbackReason}` : ""}\n- transcript omitted: yes`;
}

async function runPiMeetingChairSynthesis(args: {
  request: PiMeetingRequest;
  transcript: PiMeetingMessage[];
  participants: PiMeetingParticipantResult[];
  status: PiMeetingResult["status"];
  roundsCompleted: number;
  ctx: ExtensionContext;
  timeoutMs: number;
}): Promise<string> {
  const { request, transcript, participants, status, roundsCompleted, ctx, timeoutMs } = args;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const created = await createAgentSession({
      cwd: ctx.cwd,
      thinkingLevel: "low",
      tools: ["read", "bash", "grep", "find", "ls"],
      sessionManager: SessionManager.inMemory(),
    });
    session = created.session;

    const prompt = `You are the hidden chair of an OMO realtime meeting.\n\n` +
      `The main agent did not participate and must not see raw discussion noise.\n` +
      `Return a compact report for the main agent. Do not include raw transcript.\n\n` +
      `Question:\n${request.question}\n\n` +
      `Objective: ${request.objective}\nStatus: ${status}\nRounds completed: ${roundsCompleted}\n\n` +
      `Participants:\n${formatParticipantStatusLines(participants)}\n\n` +
      `Meeting digest:\n${formatPiMeetingDigest(transcript)}\n\n` +
      `Return exactly this markdown structure:\n` +
      `## Realtime Meeting Result\n` +
      `### Question\n` +
      `### Objective\n` +
      `### Status\n` +
      `### Participants\n` +
      `### Recommendation\n` +
      `### Consensus\n` +
      `### Key Disagreements\n` +
      `### Key Signals From Discussion\n` +
      `### Risks\n` +
      `### Confidence\n` +
      `### Suggested Next Actions\n` +
      `### Metadata\n` +
      `Metadata must include meetingId ${request.meetingId}, roundsCompleted ${roundsCompleted}, and transcript omitted: yes.\n`;

    const promptPromise = session.prompt(prompt, { source: "extension" });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Meeting chair synthesis timed out")), timeoutMs);
    });

    await Promise.race([promptPromise, timeoutPromise]);
    return extractAssistantTextFromMessages((session as any).state?.messages ?? (session as any).messages ?? []);
  } catch {
    return "";
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

function getCtxModelLabel(ctx: ExtensionContext): string {
  const model = (ctx as any).model;
  return model ? `${model.provider}/${model.id}` : "unknown";
}

function buildMeetingEnvelope(args: {
  meetingId: string;
  phase: MeetingEnvelope["phase"];
  round: number;
  role: string;
  body: string;
}): string {
  return `[meeting:${args.meetingId}][phase:${args.phase}][round:${args.round}][role:${args.role}]\n${args.body}`;
}

function parseMeetingEnvelope(text: string): MeetingEnvelope | undefined {
  const match = text.match(/^\[meeting:([^\]]+)\]\[phase:(opening|discussion|final)\]\[round:(\d+)\]\[role:([^\]]+)\]\n?([\s\S]*)$/);
  if (!match) return undefined;
  return {
    meetingId: match[1],
    phase: match[2] as MeetingEnvelope["phase"],
    round: Number(match[3]),
    role: match[4],
    body: (match[5] ?? "").trim(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCollaboratingSpawnOptions(args: {
  meetingId: string;
  phase: "opening" | "discussion" | "final";
  round: number;
  index: number;
  chairName: string;
  collabConfig: {
    subagentLaunchMode?: "process" | "cmux-pane";
    closeCompletedCmuxPanes?: boolean;
  };
  onLaunch?: (launch: { name: string }) => void | Promise<void>;
}) {
  return {
    index: args.index,
    runId: `${args.meetingId}-${args.phase}-${args.round}`,
    recursionDepth: Number(process.env.PI_COLLAB_SUBAGENT_DEPTH ?? "0") || 0,
    parentAgentName: args.chairName,
    // pi-collaborating-agents spawned child processes do not accept
    // --session-control. Keep this explicit: it is the critical contract that
    // made the collaborating backend complete a full live meeting smoke.
    enableSessionControl: false,
    launchMode: args.collabConfig.subagentLaunchMode,
    closeCompletedCmuxPane: args.collabConfig.closeCompletedCmuxPanes,
    launchDelayMs: args.index * 150,
    onLaunch: args.onLaunch,
  };
}

function resolveChairName(meetingId: string): string {
  return `${COLLAB_AGENT_PREFIX}-${meetingId}`.slice(0, 64);
}

export function resolveCollaboratingPackageRoot(): string {
  const candidates: string[] = [];

  try {
    candidates.push(path.dirname(requireFromMeeting.resolve(`${COLLAB_PACKAGE_NAME}/package.json`)));
  } catch {
    // ignore and continue to fallback paths
  }

  candidates.push(COLLAB_GLOBAL_PACKAGE_ROOT);
  candidates.push(COLLAB_PI_EXTENSION_ROOT);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const packageJson = path.join(normalized, "package.json");
    const extensionIndex = path.join(normalized, "extensions", "collaborating-agents", "index.ts");
    const extensionRootIndex = path.join(normalized, "index.ts");

    if (fs.existsSync(packageJson) && fs.existsSync(extensionIndex)) return normalized;
    if (fs.existsSync(extensionRootIndex) && fs.existsSync(path.join(normalized, "store.ts"))) return normalized;
  }

  throw new Error(`Cannot resolve ${COLLAB_PACKAGE_NAME} package root from current Pi extension runtime.`);
}

async function importCollaboratingModule<T>(modulePath: string): Promise<T> {
  const packageRoot = resolveCollaboratingPackageRoot();
  const extensionBaseDir = fs.existsSync(path.join(packageRoot, "extensions", "collaborating-agents", "index.ts"))
    ? path.join(packageRoot, "extensions", "collaborating-agents")
    : packageRoot;
  const fileUrl = pathToFileURL(path.join(extensionBaseDir, modulePath)).href;
  return await import(fileUrl) as T;
}

async function loadCollaboratingRuntime(): Promise<{
  store: CollabStoreModule;
  paths: CollabPathsModule;
  spawn: CollabSpawnModule;
  config: CollabConfigModule;
}> {
  const [store, paths, spawn, config] = await Promise.all([
    importCollaboratingModule<CollabStoreModule>("store.ts"),
    importCollaboratingModule<CollabPathsModule>("paths.ts"),
    importCollaboratingModule<CollabSpawnModule>("subagent-spawn.ts"),
    importCollaboratingModule<CollabConfigModule>("config.ts"),
  ]);
  return { store, paths, spawn, config };
}

export class CreateAgentSessionMeetingBackend implements PiMeetingBackend {
  async run(request: PiMeetingRequest, ctx: ExtensionContext): Promise<PiMeetingResult> {
    const transcript: PiMeetingMessage[] = [];
    const participantResults = new Map<string, PiMeetingParticipantResult>();
    const perTurnTimeoutMs = Math.max(10_000, Math.min(60_000, Math.floor(request.maxDurationMs / 3)));

    const runPhase = async (phase: "opening" | "discussion" | "final", round: number) => {
      const digest = phase === "opening" ? "" : formatPiMeetingDigest(transcript);
      const turnResults = await Promise.all(request.participants.map((participant) =>
        runPiMeetingParticipantTurn({ request, participant, phase, round, digest, ctx, timeoutMs: perTurnTimeoutMs }),
      ));

      for (const turn of turnResults) {
        if (turn.message) transcript.push(turn.message);
        if (turn.result) {
          const previous = participantResults.get(turn.result.name);
          if (phase === "final" || !previous || previous.status !== "completed") {
            participantResults.set(turn.result.name, {
              ...previous,
              ...turn.result,
              finalPosition: turn.result.finalPosition ?? previous?.finalPosition,
            });
          }
        }
      }
    };

    await runPhase("opening", 0);
    let roundsCompleted = 0;
    for (let round = 1; round <= request.maxRounds; round++) {
      await runPhase("discussion", round);
      roundsCompleted = round;
    }
    await runPhase("final", request.maxRounds + 1);

    for (const participant of request.participants) {
      if (!participantResults.has(participant.name)) {
        const latest = [...transcript].reverse().find((m) => m.from === participant.name);
        participantResults.set(participant.name, {
          name: participant.name,
          agent: participant.agent,
          model: participant.model,
          status: latest ? "completed" : "failed",
          finalPosition: latest?.content,
          error: latest ? undefined : "No meeting output produced",
        });
      }
    }

    const participants = request.participants.map((p) => participantResults.get(p.name)!).filter(Boolean);
    const completed = participants.filter((p) => p.status === "completed").length;
    const status: PiMeetingResult["status"] = completed === 0
      ? "failed"
      : completed === participants.length
        ? "completed"
        : "partial";

    const baseResult: Omit<PiMeetingResult, "report" | "keySignals"> = {
      meetingId: request.meetingId,
      question: request.question,
      objective: request.objective,
      status,
      roundsCompleted,
      participants,
      transcript: request.includeTranscript ? transcript : undefined,
      requestedBackend: "session",
      backendUsed: "session",
      fallbackReason: undefined,
    };

    const chairReport = await runPiMeetingChairSynthesis({
      request,
      transcript,
      participants,
      status,
      roundsCompleted,
      ctx,
      timeoutMs: perTurnTimeoutMs,
    });
    const report = chairReport.trim() || fallbackPiMeetingReport(baseResult);
    const keySignals = extractKeySignalsFromReport(report);

    return {
      ...baseResult,
      report,
      keySignals: keySignals.length > 0 ? keySignals : ["No explicit key signals extracted from chair report."],
    };
  }
}


// The spawned subagent reads a Node poll script's stdout to detect round
// prompts, then ITSELF generates substantive content and broadcasts it.
// This avoids the template-broadcasting problem of the old Node-only approach.

const PERSISTENT_PARTICIPANT_TASK = (args: {
  meetingId: string;
  participantName: string;
  agentType: string;
  chairName: string;
  question: string;
  objective: string;
  maxRounds: number;
  roleGuidance: string;
  agentPrompt: string;
}): string => {
  const sId = args.meetingId.replace(/[^a-zA-Z0-9_-]/g, "");
  const sName = args.participantName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `You are participant "${sName}" (${args.agentType}) in persistent OMO meeting ${sId}.

${args.agentPrompt}

Role guidance:
${args.roleGuidance || "(none)"}

Meeting question:
${args.question}

Objective: ${args.objective}

--- Persistent Meeting Protocol (LLM-driven loop) ---
You are NOT respawned each round. You drive the loop yourself.

Step 0 — Send READY to chair:
  agent_message status, agent_message list (only status/list — never use send or broadcast),
  then run:
  bash -c "cat > /tmp/_omo_join.js << 'OMONODE'
${JOIN_SCRIPT}
OMONODE
  node /tmp/_omo_join.js '${args.chairName}' '${sId}' '${args.agentType}'"

Step 1 — Poll for next round:
  bash -c "cat > /tmp/_omo_poll.js << 'OMONODE'
${POLL_SCRIPT}
OMONODE
  timeout 120 node /tmp/_omo_poll.js '${sId}'"

Read stdout for: ROUND:N:PHASE:text, END, or TIMEOUT.

Step 2 — When you see "ROUND:round:phase:promptText":
  a. agent_message feed limit 80  (read latest messages for context)
  b. If phase=opening:
       Build a recommendation with: Recommendation, Assumptions, Risks, Evidence, and Confidence.
       Reference the meeting question.
  c. If phase=discussion:
       Read what other participants said. Challenge or respond. State updated view, key signal.
  d. If phase=final:
       Give final Recommendation, Changed view, Remaining disagreement, Key evidence, Risks, Confidence.
  e. Send to chair:\n       bash -c "cat > /tmp/_omo_send.js << 'OMONODE'
${SEND_SCRIPT}
OMONODE
  node /tmp/_omo_send.js '${args.chairName}' '$RESPONSE'"
  f. Go to Step 1 (poll for next round)

Step 3 — When you see "END":
  Send final position to chair (same step 2e script) and stop.

Step 4 — When you see "TIMEOUT":
  Nothing happened in 120s. Stop gracefully.

IMPORTANT: Do NOT send empty/template responses. Every response must contain substantive analysis you generated.
`;
};

/**
 * Persistent collaborating meeting backend.
 * Spawns each participant ONCE with a polling-loop task.
 * Participants stay alive, see raw messages, and respond to rounds
 * by monitoring the collaborating-agents message log.
 */
export class PersistentCollaboratingMeetingBackend implements PiMeetingBackend {
  async run(request: PiMeetingRequest, ctx: ExtensionContext): Promise<PiMeetingResult> {
    const runtime = await loadCollaboratingRuntime();
    const dirs = runtime.paths.resolveDirs();
    const chairName = resolveChairName(request.meetingId);
    const startedAt = new Date().toISOString();

    const chairRegistration = {
      name: chairName,
      pid: process.pid,
      sessionId: `${request.meetingId}-chair`,
      sessionFile: undefined,
      cwd: ctx.cwd,
      model: getCtxModelLabel(ctx),
      startedAt,
      lastSeenAt: startedAt,
      role: "orchestrator" as const,
      reservations: undefined,
    };

    if (!runtime.store.registerSelf(dirs, chairRegistration)) {
      throw new Error("Failed to register persistent meeting chair.");
    }

    // Rotate message log to prevent unbounded growth: keep last 500 entries
    try {
      const logPath = dirs.messageLog;
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length > 500) {
          fs.writeFileSync(logPath, lines.slice(-500).join("\n") + "\n", "utf8");
        }
      }
    } catch {
      // best-effort rotation
    }

    const collabConfig = runtime.config.loadConfig(ctx.cwd);
    const transcript: PiMeetingMessage[] = [];
    const participantResults = new Map<string, PiMeetingParticipantResult>();
    const spawnedNames = new Set<string>();

    try {
      // Phase 1: Spawn all participants once (fire-and-forget — don't await
      // runSpawnTask because it blocks until the spawned subprocess exits.
      // The onLaunch callback fires synchronously after spawn, so spawnedNames
      // is populated before the round loop begins.
      request.participants.forEach((participant, index) => {
        runtime.spawn.runSpawnTask(
          ctx.cwd,
          {
            agent: participant.agent,
            task: PERSISTENT_PARTICIPANT_TASK({
              meetingId: request.meetingId,
              participantName: participant.name,
              agentType: participant.agent,
              chairName,
              question: request.question,
              objective: request.objective,
              maxRounds: request.maxRounds,
              roleGuidance: participant.prompt ?? "",
              agentPrompt: AGENT_PROMPTS[participant.agent]?.prompt ?? "You are a meeting participant.",
            }),
          },
          {
            name: participant.agent,
            description: AGENT_PROMPTS[participant.agent]?.description ?? participant.agent,
            model: participant.model,
            tools: undefined,
            systemPrompt: "You are a persistent meeting participant. Stay alive and poll for new rounds.",
            source: "user",
            filePath: `omo://${participant.agent}`,
          },
          createCollaboratingSpawnOptions({
            meetingId: request.meetingId,
            phase: "opening",
            round: 0,
            index,
            chairName,
            collabConfig,
            onLaunch: (launch) => { spawnedNames.add(launch.name); },
          }),
        ).catch(() => {});
      });

      // Wait for join broadcasts to arrive before sending round prompts
      await sleep(8000);

      let roundsCompleted = 0;
      const roundPhases: Array<{ phase: "opening" | "discussion" | "final"; round: number }> = [
        { phase: "opening", round: 0 },
      ];
      for (let i = 1; i <= request.maxRounds; i++) {
        roundPhases.push({ phase: "discussion", round: i });
      }
      roundPhases.push({ phase: "final", round: request.maxRounds + 1 });

      for (const { phase, round } of roundPhases) {
        let roundQuestion = "";
        if (phase === "opening") {
          roundQuestion = `Give your opening position on the question: ${request.question}`;
        } else if (phase === "discussion") {
          const rawFeed = runtime.store.readMessageLog(dirs);
          const relevantMessages = rawFeed
            .filter((m) => m.text && m.text.includes(request.meetingId))
            .slice(-20)
            .map((m) => `- ${m.from}: ${m.text.slice(0, 300)}`)
            .join("\\n");
          roundQuestion = `Discussion round ${round}. Current participant views:\\n${relevantMessages || "(none yet)"}\\n\\nChallenge or refine positions.`;
        } else {
          roundQuestion = `Final round. Give your final position after considering other participants.`;
        }

        const promptText = `[meeting:${request.meetingId}][round:${round}][phase:${phase}][action:prompt]\\n${roundQuestion}`;

        // Check participant liveness before this round
        const aliveSet = new Set<string>();
        const regDir = dirs.registry;
        if (fs.existsSync(regDir)) {
          try {
            for (const f of fs.readdirSync(regDir)) {
              if (!f.endsWith(".json")) continue;
              try {
                const reg = JSON.parse(fs.readFileSync(path.join(regDir, f), "utf8"));
                if (reg.name && reg.pid && spawnedNames.has(reg.name)) {
                  try { process.kill(reg.pid, 0); aliveSet.add(reg.name); } catch {}
                }
              } catch {}
            }
          } catch {}
        }

        for (const spawnedName of spawnedNames) {
          runtime.store.sendDirect(dirs, chairName, spawnedName, promptText, undefined, false);
        }

        // Wait for all participants to respond, with generous per-round
        // timeout as safety net. The minimum per-round wait is 3 minutes
        // so participants have time to generate substantive responses.
        const perRoundTimeoutMs = Math.max(180_000, Math.floor(request.maxDurationMs / 2));
        const pollDeadline = Date.now() + perRoundTimeoutMs;

        let aliveParticipants = [...spawnedNames].filter((n) => aliveSet.has(n));
        if (aliveParticipants.length === 0) aliveParticipants = [...spawnedNames];

        while (Date.now() < pollDeadline) {
          await sleep(2000);
          const events = runtime.store.readMessageLog(dirs);
          const roundEvents = events.filter(
            (e) => e.text &&
                  e.text.includes(`[meeting:${request.meetingId}][round:${round}][phase:${phase}]`) &&
                  spawnedNames.has(e.from),
          );

          for (const event of roundEvents) {
            const existingIdx = transcript.findIndex(
              (m) => m.from === event.from && m.round === round && m.phase === phase,
            );
            const newMsg: PiMeetingMessage = {
              id: `${request.meetingId}-${phase}-${round}-${event.from}`,
              meetingId: request.meetingId,
              round,
              phase,
              from: event.from,
              role: event.from,
              content: event.text,
              timestamp: Date.parse(event.timestamp) || Date.now(),
            };
            if (existingIdx >= 0) transcript[existingIdx] = newMsg;
            else transcript.push(newMsg);
          }

          const responded = new Set(roundEvents.map((e) => e.from));
          if (aliveParticipants.every((n) => responded.has(n))) break;
        }

        if (phase !== "opening") roundsCompleted++;
      }

      const endText = `[meeting:${request.meetingId}][phase:end]\\nMeeting complete. Broadcast your final position and exit.`;
      for (const spawnedName of spawnedNames) {
        runtime.store.sendDirect(dirs, chairName, spawnedName, endText, undefined, false);
      }
      await sleep(10000);

      const finalEvents = runtime.store.readMessageLog(dirs).filter(
        (e) => e.text && e.text.includes(`[meeting:${request.meetingId}][phase:final]`) && spawnedNames.has(e.from),
      );

      for (const participant of request.participants) {
        const spawnedName = [...spawnedNames].find((n) => n.includes(participant.agent)) || participant.name;
        const lastMsg = [...transcript].reverse().find((m) => m.from === spawnedName || m.role === participant.agent);
        const finalMsg = finalEvents.find((e) => e.from === spawnedName);
        participantResults.set(participant.name, {
          name: participant.name,
          agent: participant.agent,
          model: participant.model,
          status: lastMsg ? "completed" : "failed",
          finalPosition: finalMsg?.text || lastMsg?.content,
          error: lastMsg ? undefined : "No persistent meeting output produced",
        });
      }

      const participants = request.participants.map((p) => participantResults.get(p.name)!).filter(Boolean);
      const completed = participants.filter((p) => p.status === "completed").length;
      const status: PiMeetingResult["status"] =
        completed === 0 ? "failed" : completed === participants.length ? "completed" : "partial";

      const baseResult: Omit<PiMeetingResult, "report" | "keySignals"> = {
        meetingId: request.meetingId,
        question: request.question,
        objective: request.objective,
        status,
        roundsCompleted,
        participants,
        transcript: request.includeTranscript ? transcript : undefined,
        requestedBackend: "collaborating",
        backendUsed: "collaborating",
        fallbackReason: undefined,
      };

      const chairReport = await runPiMeetingChairSynthesis({
        request,
        transcript,
        participants,
        status,
        roundsCompleted,
        ctx,
        timeoutMs: Math.max(10_000, Math.min(60_000, Math.floor(request.maxDurationMs / 3))),
      });
      const report = chairReport.trim() || fallbackPiMeetingReport(baseResult);
      const keySignals = extractKeySignalsFromReport(report);

      return {
        ...baseResult,
        report,
        keySignals: keySignals.length > 0 ? keySignals : ["No explicit key signals extracted from chair report."],
      };
    } finally {
      runtime.store.unregisterSelf(dirs, {
        name: chairName,
        pid: process.pid,
        sessionId: `${request.meetingId}-chair`,
      });
    }
  }
}

export function resolvePiMeetingBackend(value: string | undefined): PiMeetingBackendResolution {
  const requestedBackend = normalizePiMeetingBackend(value);
  if (requestedBackend === "collaborating") {
    return {
      requestedBackend,
      backendUsed: "collaborating",
      backend: new PersistentCollaboratingMeetingBackend(),
    };
  }

  return {
    requestedBackend,
    backendUsed: "session",
    backend: new CreateAgentSessionMeetingBackend(),
  };
}

export function formatPiMeetingResult(result: PiMeetingResult): string {
  let output = result.report.trim();
  const backendLines = [
    `- requestedBackend: ${result.requestedBackend}`,
    `- backendUsed: ${result.backendUsed}`,
    result.fallbackReason ? `- fallbackReason: ${result.fallbackReason}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (!output.includes("requestedBackend:")) {
    if (!output.includes("### Metadata")) output += `\n\n### Metadata`;
    output += `\n${backendLines.join("\n")}`;
  }

  if (!output.includes("transcript omitted:") && !result.transcript) {
    output += `\n- meetingId: ${result.meetingId}\n- roundsCompleted: ${result.roundsCompleted}\n- transcript omitted: yes`;
  }

  if (result.transcript) {
    output += `\n\n## Transcript Appendix\nTranscript included because includeTranscript=true.\n\n` +
      result.transcript
        .map((m) => `### ${m.phase} round ${m.round} — ${m.from} (${m.role})\n${m.content}`)
        .join("\n\n");
  }

  return output;
}

export async function runPiMeeting(args: {
  question: string;
  preset?: string;
  participants?: PiCouncilParticipantConfig[];
  objective?: string;
  maxRounds?: number;
  maxDurationMs?: number;
  includeTranscript?: boolean;
  ctx: ExtensionContext;
  config: OmniMoConfig | null;
}): Promise<{ result?: PiMeetingResult; error?: string }> {
  const resolved = resolvePiCouncilParticipants({
    config: args.config,
    preset: args.preset,
    participants: args.participants,
  });
  if (resolved.error) return { error: resolved.error };

  const resolution = resolvePiMeetingBackend(args.config?.council?.meeting_backend);

  const request: PiMeetingRequest = {
    meetingId: createPiMeetingId(),
    question: args.question,
    preset: args.preset,
    participants: resolved.participants,
    objective: normalizePiMeetingObjective(args.objective),
    maxRounds: normalizePiMeetingMaxRounds(args.maxRounds),
    maxDurationMs: args.maxDurationMs ?? args.config?.council?.timeout ?? 180000,
    includeTranscript: args.includeTranscript ?? false,
  };

  try {
    const result = await resolution.backend.run(request, args.ctx);
    return {
      result: {
        ...result,
        requestedBackend: resolution.requestedBackend,
        backendUsed: resolution.backendUsed,
        fallbackReason: resolution.fallbackReason,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resolution.requestedBackend === "collaborating") {
      const fallback = await new CreateAgentSessionMeetingBackend().run(request, args.ctx);
      return {
        result: {
          ...fallback,
          requestedBackend: "collaborating",
          backendUsed: "session",
          fallbackReason: message || "collaborating backend failed",
        },
      };
    }
    return { error: message };
  }
}
