/**
 * PoolMeetingBackend — Real-time multi-agent discussion via SDK sessions.
 *
 * Each participant runs as an in-process AgentSession.
 * Chair directly communicates with participants via session.prompt/session.steer.
 */
import * as crypto from "node:crypto";
import type { ExtensionContext, AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_PROMPTS } from "./pi-agents";
import type {
  PiMeetingBackend, PiMeetingMessage, PiMeetingParticipantResult, PiMeetingRequest, PiMeetingResult,
} from "./pi-meeting";

function extractAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
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

export class PoolMeetingBackend implements PiMeetingBackend {
  async run(request: PiMeetingRequest, ctx: ExtensionContext): Promise<PiMeetingResult> {
    const transcript: PiMeetingMessage[] = [];
    const participantResults = new Map<string, PiMeetingParticipantResult>();
    const sessions: AgentSession[] = [];
    let roundsCompleted = 0;

    // Set sub-agent env markers
    const prevEnv = process.env.OMO_SUB_AGENT;
    process.env.OMO_SUB_AGENT = "1";

    try {
      // Create participants via SDK
      for (const p of request.participants) {
        const agentPrompt = AGENT_PROMPTS[p.agent]?.prompt || "You are a specialist.";
        const roleGuidance = p.prompt ? "\nRole guidance: " + p.prompt : "";

        const task = [
          "You are " + p.name + " (" + p.agent + ") in a design discussion.",
          "Question: " + request.question,
          "Objective: " + request.objective,
          "",
          agentPrompt,
          roleGuidance || "",
          "",
          "--- Protocol ---",
          "You will receive round prompts from the chair. For each round:",
          "1. Analyse the question and discussion context",
          "2. Provide your analysis, referencing prior discussion if applicable",
          "3. Keep responses concise but thorough",
          "When you receive the final round, provide your concluding position.",
        ].filter(Boolean).join("\n");

        const created = await createAgentSession({
          cwd: ctx.cwd,
          sessionManager: SessionManager.inMemory(),
          tools: ["read", "bash", "grep", "find", "ls"],
        });
        sessions.push(created.session);
        participantResults.set(p.name, { name: p.name, agent: p.agent, model: p.model, status: "completed" });

        // Send initial participant task
        await created.session.prompt(task);
      }

      // Run discussion rounds with early-stop on convergence
      const maxRounds = Math.min(request.maxRounds || 3, 5);
      if (maxRounds <= 0) throw new Error("maxRounds must be >= 1");
      const previousResponses = new Map<string, string>();

      for (let round = 0; round < maxRounds; round++) {
        const phases: Array<"opening" | "discussion" | "final"> = ["opening", "discussion", "final"];
        const phase = phases[round] || "discussion";

        // Convergence check
        if (phase === "discussion" && previousResponses.size > 0) {
          const thresholds = [0.75, 0.70, 0.65, 0.60];
          const threshold = thresholds[round - 1] ?? 0.55;
          let convergedCount = 0;
          for (const [name, prev] of previousResponses) {
            const latest = [...transcript].reverse().find(m => m.from === name && m.phase === "discussion");
            if (latest && computeSemanticOverlap(prev, latest.content) >= threshold) {
              convergedCount++;
            }
          }
          if (convergedCount >= request.participants.length) {
            // All converged — final round
            if (request.participants.length > 0) {
              const finalRound = maxRounds - 1;
              const contextSummary = transcript
                .map(m => `[${m.from}]: ${m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content}`)
                .join("\n") || "(no prior discussion)";
              const roundPrompt = `--- Round ${finalRound + 1} (final) ---\n\nQuestion: ${request.question}\n\nFull discussion:\n${contextSummary}\n\nProvide your final position and recommendation.`;

              const finalResponses = await Promise.all(
                request.participants.map(async (p, i) => {
                  const session = sessions[i];
                  if (!session) return { name: p.name, agent: p.agent, response: "(session dead)" };
                  try {
                    await session.prompt(roundPrompt);
                    const text = extractAssistantText((session as any).messages ?? []);
                    return { name: p.name, agent: p.agent, response: text || "(no response)" };
                  } catch {
                    return { name: p.name, agent: p.agent, response: "(error)" };
                  }
                }),
              );

              for (const r of finalResponses) {
                transcript.push({
                  id: crypto.randomUUID(),
                  meetingId: request.meetingId,
                  round: finalRound,
                  phase: "final",
                  from: r.name,
                  role: r.agent,
                  content: r.response,
                  timestamp: Date.now(),
                });
              }
              roundsCompleted = finalRound + 1;
            } else {
              roundsCompleted = round;
            }
            break;
          }
        }

        const contextSummary = transcript.filter(m => m.round < round)
          .map(m => `[${m.from}]: ${m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content}`)
          .join("\n") || "(no prior discussion)";

        const phasePrompt = phase === "opening"
          ? "Provide your initial analysis of the question."
          : phase === "discussion"
            ? "Review others' views. Agree or disagree with reasoning."
            : "Provide your final position and recommendation.";

        const roundPrompt = `--- Round ${round + 1} (${phase}) ---\n\nQuestion: ${request.question}\n\nPrior discussion:\n${contextSummary}\n\n${phasePrompt}`;

        // Send to all participants concurrently
        const responses = await Promise.all(
          request.participants.map(async (p, i) => {
            const session = sessions[i];
            if (!session) return { name: p.name, agent: p.agent, response: "(session dead)" };
            try {
              await session.prompt(roundPrompt);
              const text = extractAssistantText((session as any).messages ?? []);
              return { name: p.name, agent: p.agent, response: text || "(no response)" };
            } catch {
              return { name: p.name, agent: p.agent, response: "(error)" };
            }
          }),
        );

        for (const r of responses) {
          transcript.push({
            id: crypto.randomUUID(),
            meetingId: request.meetingId,
            round,
            phase,
            from: r.name,
            role: r.agent,
            content: r.response,
            timestamp: Date.now(),
          });
        }

        // Store for convergence detection
        if (phase === "opening" || phase === "discussion") {
          for (const r of responses) {
            previousResponses.set(r.name, r.response);
          }
        }

        roundsCompleted = round + 1;
      }

      // Build result
      const finalPositions = transcript.filter(m => m.round === roundsCompleted - 1)
        .map(m => `**${m.from}** (${m.role}): ${m.content.slice(0, 1000)}`);

      const report = "## Meeting Result\n\n### Question\n" + request.question +
        "\n\n### Rounds Completed\n" + roundsCompleted +
        (finalPositions.length > 0 ? "\n\n### Final Positions\n\n" + finalPositions.join("\n\n") : "") +
        (transcript.length > 0 ? "\n\n### Discussion\n\n" +
          transcript.map(m => `**${m.from}** (round ${m.round + 1}/${m.phase}): ${m.content.slice(0, 300)}`).join("\n\n") : "");

      return {
        meetingId: request.meetingId,
        question: request.question,
        objective: request.objective,
        status: roundsCompleted > 0 ? "completed" : "failed",
        roundsCompleted,
        participants: Array.from(participantResults.values()),
        report,
        keySignals: [],
        transcript: request.includeTranscript ? transcript : undefined,
        requestedBackend: "pool",
        backendUsed: "pool",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        meetingId: request.meetingId,
        question: request.question,
        objective: request.objective,
        status: "failed",
        roundsCompleted: 0,
        participants: Array.from(participantResults.values()),
        report: "Meeting failed: " + message,
        keySignals: [],
        requestedBackend: "pool",
        backendUsed: "pool",
      };
    } finally {
      // Cleanup all sessions
      for (const session of sessions) {
        try { await session.abort(); } catch {}
        session.dispose();
      }
      if (prevEnv === undefined) delete process.env.OMO_SUB_AGENT;
      else process.env.OMO_SUB_AGENT = prevEnv;
    }
  }
}
