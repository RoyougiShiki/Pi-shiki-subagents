/**
 * PoolMeetingBackend — Real-time multi-agent discussion.
 * Chair directly communicates with pi --mode rpc participants via stdin/stdout JSONL protocol.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_PROMPTS } from "./pi-agents";
import type {
  PiMeetingBackend, PiMeetingMessage, PiMeetingParticipantResult, PiMeetingRequest, PiMeetingResult
} from "./pi-meeting";

function sendPrompt(proc: ChildProcess, message: string): void {
  proc.stdin!.write(JSON.stringify({ type: "prompt", message }) + "\n");
}

function readResponse(proc: ChildProcess, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    const decoder = new TextDecoder();
    let response = "";
    let settled = false;

    const onData = (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (!ev || typeof ev !== "object") continue;
          if (ev.type === "agent_end") {
            const msgs = ev.messages ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m.role === "assistant") {
                const texts = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text);
                if (texts.length > 0) response = texts.join("\n").trim();
                break;
              }
            }
            settled = true;
            cleanup();
            resolve(response || "(no response)");
            return;
          }
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (!settled) { cleanup(); resolve(response || "(timeout)"); }
    }, timeoutMs);

    const cleanup = () => {
      proc.stdout?.removeListener("data", onData);
      clearTimeout(timer);
    };

    proc.stdout?.on("data", onData);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class PoolMeetingBackend implements PiMeetingBackend {
  async run(request: PiMeetingRequest, ctx: ExtensionContext): Promise<PiMeetingResult> {
    const transcript: PiMeetingMessage[] = [];
    const participantResults = new Map<string, PiMeetingParticipantResult>();
    const spawnedProcs: ChildProcess[] = [];
    let roundsCompleted = 0;

    try {
      // Spawn participants
      for (let i = 0; i < request.participants.length; i++) {
        const p = request.participants[i];
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

        const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PI_AGENT_NAME: p.name },
        });
        spawnedProcs.push(proc);
        participantResults.set(p.name, { name: p.name, agent: p.agent, model: p.model, status: "completed" });

        // Send initial participant task
        sendPrompt(proc, task);
      }

      // Wait for initial processing
      await sleep(5000);

      // Run discussion rounds
      const maxRounds = Math.min(request.maxRounds || 3, 5);
      const phases: Array<"opening" | "discussion" | "final"> = ["opening", "discussion", "final"];

      for (let round = 0; round < maxRounds; round++) {
        const phase = phases[round] || "discussion";

        const contextSummary = transcript.filter(m => m.round < round)
          .map(m => "[" + m.from + "]: " + (m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content))
          .join("\n") || "(no prior discussion)";

        const phasePrompt = phase === "opening"
          ? "Provide your initial analysis of the question."
          : phase === "discussion"
            ? "Review others' views. Agree or disagree with reasoning."
            : "Provide your final position and recommendation.";

        const roundPrompt = "--- Round " + (round + 1) + " (" + phase + ") ---\n\nQuestion: " + request.question + "\n\nPrior discussion:\n" + contextSummary + "\n\n" + phasePrompt;

        // Send to all participants concurrently
        const responsePromises = request.participants.map((p, i) => {
          const proc = spawnedProcs[i];
          if (!proc || proc.killed) return Promise.resolve({ name: p.name, agent: p.agent, response: "(process dead)" });
          sendPrompt(proc, roundPrompt);
          return readResponse(proc, 60000).then(response => ({ name: p.name, agent: p.agent, response }));
        });

        const responses = await Promise.all(responsePromises);

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

        roundsCompleted = round + 1;
      }

      // Build result
      const finalPositions = transcript.filter(m => m.round === roundsCompleted - 1)
        .map(m => "**" + m.from + "** (" + m.role + "): " + m.content.slice(0, 1000));

      const report = "## Meeting Result\n\n### Question\n" + request.question +
        "\n\n### Rounds Completed\n" + roundsCompleted +
        (finalPositions.length > 0 ? "\n\n### Final Positions\n\n" + finalPositions.join("\n\n") : "") +
        (transcript.length > 0 ? "\n\n### Discussion\n\n" +
          transcript.map(m => "**" + m.from + "** (round " + (m.round + 1) + "/" + m.phase + "): " + m.content.slice(0, 300)).join("\n\n") : "");

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
      for (const proc of spawnedProcs) { try { proc.kill(); } catch {} }
    }
  }
}
