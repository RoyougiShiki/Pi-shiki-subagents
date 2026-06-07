import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_PROMPTS } from "./pi-agents";
import { PoolMeetingBackend } from "./pi-meeting-pool";
import type { OmniMoConfig, PiCouncilParticipantConfig } from "../config-types";
import {
  extractAssistantTextFromMessages,
  resolvePiCouncilParticipants,
  resolvePiModel,
  type PiCouncilParticipant,
} from "./pi-council";

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

export type PiMeetingBackendName = "session" | "pool";

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
const POLL_INTERVAL_MS = 1000;
const PHASE_WAIT_MS = 45000;

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
  if (value === "pool" || value === "collaborating") return "pool";
  return "session";
}

function createPiMeetingId(): string {
  return `omo-meet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute word-level overlap ratio between two texts.
 * Filters out short words (<4 chars) to ignore noise.
 * Returns 0.0–1.0 where 1.0 = identical substantive content.
 */
function computeSemanticOverlap(a: string, b: string): number {
  const tokenize = (t: string) =>
    new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
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
    // Track previous discussion messages for convergence detection
    let previousDiscussionContent = new Map<string, string>();
    for (let round = 1; round <= request.maxRounds; round++) {
      await runPhase("discussion", round);
      roundsCompleted = round;
      // Convergence check: if all participants are repeating themselves,
      // skip remaining discussion rounds.
      if (round < request.maxRounds && previousDiscussionContent.size > 0) {
        const currentDiscussion = new Map<string, string>();
        for (const msg of transcript) {
          if (msg.phase === "discussion" && msg.round === round) {
            currentDiscussion.set(msg.from, msg.content);
          }
        }
        if (currentDiscussion.size >= request.participants.length) {
          const thresholds = [0.75, 0.70, 0.65];
          const threshold = thresholds[round - 1] ?? 0.55;
          let convergedCount = 0;
          for (const [name, content] of currentDiscussion) {
            const prev = previousDiscussionContent.get(name);
            if (prev) {
              const overlap = computeSemanticOverlap(prev, content);
              if (overlap >= threshold) convergedCount++;
            }
          }
          if (convergedCount >= request.participants.length) {
            // All converged — skip to final immediately
            break;
          }
        }
      }
      // Store current discussion for next round's comparison
      previousDiscussionContent.clear();
      for (const msg of transcript) {
        if (msg.phase === "discussion" && (msg.round === round || (round > 0 && msg.round === round))) {
          previousDiscussionContent.set(msg.from, msg.content);
        }
      }
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

export function resolvePiMeetingBackend(value: string | undefined): PiMeetingBackendResolution {
  const requestedBackend = normalizePiMeetingBackend(value);

  if (requestedBackend === "pool") {
    return {
      requestedBackend,
      backendUsed: "pool",
      backend: new PoolMeetingBackend(),
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
  backend?: string;
  ctx: ExtensionContext;
  config: OmniMoConfig | null;
}): Promise<{ result?: PiMeetingResult; error?: string }> {
  const resolved = resolvePiCouncilParticipants({
    config: args.config,
    preset: args.preset,
    participants: args.participants,
  });
  if (resolved.error) return { error: resolved.error };

  const resolution = resolvePiMeetingBackend(args.backend || args.config?.council?.meeting_backend);

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

    return { error: message };
  }
}
