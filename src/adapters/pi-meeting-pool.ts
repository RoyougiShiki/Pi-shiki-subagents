/**
 * PoolMeetingBackend — Real-time multi-agent discussion using pi --mode rpc pool.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { AGENT_PROMPTS } from "./pi-agents";
import type { PiMeetingBackend, PiMeetingMessage, PiMeetingParticipantResult, PiMeetingRequest, PiMeetingResult } from "./pi-meeting";

function createMeetingDir(meetingId: string): string {
  const dir = path.join(os.tmpdir(), `omo-meeting-${meetingId}`);
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "messages.jsonl"), "", "utf-8");
  return dir;
}
function cleanupMeetingDir(dir: string): void { try { fs.rmSync(dir, { recursive: true }); } catch {} }

function postMessage(dir: string, from: string, to: string, text: string, kind: "direct" | "broadcast"): void {
  const entry = { id: crypto.randomUUID(), from, to, text, kind, timestamp: new Date().toISOString() };
  fs.appendFileSync(path.join(dir, "messages.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  const inboxDir = path.join(dir, "inbox", to);
  fs.mkdirSync(inboxDir, { recursive: true });
  const fn = Date.now() + "-" + process.pid;
  fs.writeFileSync(path.join(inboxDir, fn + ".tmp"), JSON.stringify(entry), "utf-8");
  fs.renameSync(path.join(inboxDir, fn + ".tmp"), path.join(inboxDir, fn + ".json"));
}

function readMessageCount(dir: string): number {
  const logPath = path.join(dir, "messages.jsonl");
  if (!fs.existsSync(logPath)) return 0;
  const c = fs.readFileSync(logPath, "utf-8").trim();
  return c ? c.split("\n").filter(Boolean).length : 0;
}

function readNewMessages(dir: string, sinceCount: number): string[] {
  const logPath = path.join(dir, "messages.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).slice(sinceCount);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function waitForParticipants(dir: string, expected: number, timeoutMs = 30000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const joined = readNewMessages(dir, 0).filter(l => l.includes("[phase:join]")).length;
    if (joined >= expected) return joined;
    await sleep(500);
  }
  return readNewMessages(dir, 0).filter(l => l.includes("[phase:join]")).length;
}

async function waitForResponses(dir: string, beforeCount: number, expected: number, timeoutMs = 60000): Promise<{responses: string[]; count: number}> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentCount = readMessageCount(dir);
    if (currentCount <= beforeCount) { await sleep(500); continue; }
    const newMsgs = readNewMessages(dir, beforeCount);
    const participantMsgs = newMsgs.filter(l => !l.includes("[action:prompt]") && !l.includes("[phase:join]"));
    if (participantMsgs.length >= expected) return { responses: participantMsgs.slice(-expected), count: currentCount };
    await sleep(500);
  }
  const newMsgs = readNewMessages(dir, beforeCount);
  return { responses: newMsgs.filter(l => !l.includes("[action:prompt]") && !l.includes("[phase:join]")), count: readMessageCount(dir) };
}

export class PoolMeetingBackend implements PiMeetingBackend {
  async run(request: PiMeetingRequest, ctx: ExtensionContext): Promise<PiMeetingResult> {
    const dir = createMeetingDir(request.meetingId);
    const chairName = "chair-" + request.meetingId.slice(0, 55);
    const transcript: PiMeetingMessage[] = [];
    const participantResults = new Map<string, PiMeetingParticipantResult>();
    const spawnedProcs: ChildProcess[] = [];

    try {
      // Spawn participants - using direct spawn instead of pool to avoid circular dependency
      for (let i = 0; i < request.participants.length; i++) {
        const p = request.participants[i];
        const agentPrompt = AGENT_PROMPTS[p.agent]?.prompt || "You are a specialist.";
        const makeReadyCmd = `export COLLABORATING_AGENTS_DIR=${dir}; node -e "require('fs').appendFileSync(process.env.COLLABORATING_AGENTS_DIR+'/messages.jsonl',JSON.stringify({id:require('crypto').randomUUID(),from:process.env.PI_AGENT_NAME,to:'${chairName}',text:'[meeting:${request.meetingId}][round:0][phase:join][role:${p.agent}] ready',kind:'direct',timestamp:new Date().toISOString()})+'\\n');console.log('JOIN_OK');"`;
        const pollCmd = `export COLLABORATING_AGENTS_DIR=${dir}; node -e "
const L=process.env.COLLABORATING_AGENTS_DIR+'/messages.jsonl';
const S=process.env.PI_AGENT_NAME||'x';
const Q='${request.meetingId}';
let n=0;
try{const c=require('fs').readFileSync(L,'utf8').trim();n=c?c.split('\\n').length:0;}catch{}
function poll(){return new Promise(r=>{let i=0;const iv=setInterval(()=>{i++;try{const lines=require('fs').readFileSync(L,'utf8').trim().split('\\n').filter(Boolean);if(lines.length<=n)return;n=lines.length;for(const ln of lines.slice(-10)){let e;try{e=JSON.parse(ln)}catch{continue}if(!e.text||e.from===S)continue;if(e.text.includes('[meeting:${request.meetingId}][phase:end]')){clearInterval(iv);r('END');return}const m=e.text.match(/\\[meeting:([^\\]]+)\\]\\[round:(\\d+)\\]\\[phase:(opening|discussion|final)\\]\\[action:prompt\\]/);if(m&&m[1]==='${request.meetingId}'){clearInterval(iv);r('ROUND:'+m[2]+':'+m[3]+':'+e.text.slice(0,1000));return}}if(i>=60){clearInterval(iv);r('TIMEOUT')}}catch{}setTimeout(()=>{},2000)},2000)})}
poll().then(r=>{console.log(r);process.exit(0)}).catch(e=>process.exit(1));
"`;

        const participantTask = "You are " + p.name + " (" + p.agent + ") in meeting " + request.meetingId + ".\n" +
          "Question: " + request.question + "\n\n" +
          agentPrompt + "\n\n" +
          "--- Protocol ---\n" +
          "1. Run this to join: bash -c '" + makeReadyCmd + "'\n" +
          "2. Then loop: result=$(bash -c '" + pollCmd + "'); echo $result\n" +
          "3. If result starts with ROUND: analyse the round prompt and respond\n" +
          "4. Mark your response with [round:MSGCOUNT]\n" +
          "5. Loop back to step 2\n" +
          "6. If result is END: post final position and stop";

        const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PI_AGENT_NAME: p.name, COLLABORATING_AGENTS_DIR: dir },
        });
        proc.stdin!.write(JSON.stringify({ type: "prompt", message: participantTask }) + "\n");
        spawnedProcs.push(proc);

        participantResults.set(p.name, { name: p.name, agent: p.agent, model: p.model, status: "completed" });
      }

      await waitForParticipants(dir, request.participants.length, 30000);

      let beforeCount = readMessageCount(dir);
      let roundsCompleted = 0;
      const maxRounds = Math.min(request.maxRounds || 3, 5);
      const phases: Array<"opening" | "discussion" | "final"> = ["opening", "discussion", "final"];

      for (let round = 0; round < maxRounds; round++) {
        const phase = phases[round] || "discussion";
        const recentMsgs = readNewMessages(dir, 0);
        const contextLines = recentMsgs.filter(l => !l.includes("[phase:join]")).slice(-20).map(l => {
          try { const e = JSON.parse(l); return "[" + e.from + "]: " + (e.text.length > 500 ? e.text.slice(0, 500) + "..." : e.text); } catch { return ""; }
        }).filter(Boolean);

        const phasePrompt = phase === "opening" ? "Provide your initial analysis of the question."
          : phase === "discussion" ? "Review others' views. Agree/disagree with evidence. Challenge or support other viewpoints."
          : "Final position. This is your last chance to state your view.";

        const roundPrompt = "[meeting:" + request.meetingId + "][round:" + round + "][phase:" + phase + "][action:prompt]\n\nRound " + (round + 1) + " (" + phase + ")\nQuestion: " + request.question + "\n\n" + (contextLines.length > 0 ? "Discussion so far:\n" + contextLines.join("\n") + "\n\n" : "") + phasePrompt;

        postMessage(dir, chairName, "@all", roundPrompt, "broadcast");
        await sleep(2000);

        const { responses, count } = await waitForResponses(dir, beforeCount, request.participants.length, 60000);
        for (const r of responses) {
          try { const e = JSON.parse(r); transcript.push({ id: e.id, meetingId: request.meetingId, round, phase, from: e.from, role: request.participants.find(p => p.name === e.from)?.agent || "unknown", content: e.text, timestamp: new Date(e.timestamp).getTime() }); } catch {}
        }
        beforeCount = count;
        roundsCompleted = round + 1;
      }

      postMessage(dir, chairName, "@all", "[meeting:" + request.meetingId + "][phase:end] Meeting concluded. Post your final position.", "broadcast");
      await sleep(5000);

      const finalMsgs = readNewMessages(dir, beforeCount);
      const finalPositions = request.participants.map(p => {
        const msgs = finalMsgs.filter(l => { try { return JSON.parse(l).from === p.name; } catch { return false; } });
        try { const e = msgs.length > 0 ? JSON.parse(msgs[msgs.length - 1]) : null; return "**" + p.name + "** (" + p.agent + "): " + (e ? e.text.slice(0, 1000) : "(no final position)"); } catch { return "**" + p.name + "**: (no final position)"; }
      });

      const report = "## Meeting Result\n\n### Question\n" + request.question + "\n\n### Rounds Completed\n" + roundsCompleted + "\n\n### Final Positions\n\n" + finalPositions.join("\n\n") + (transcript.length > 0 ? "\n\n### Discussion Highlights\n\n" + transcript.map(m => "**" + m.from + "** (round " + m.round + "/" + m.phase + "): " + m.content.slice(0, 300)).join("\n\n") : "");

      return { meetingId: request.meetingId, question: request.question, objective: request.objective, status: roundsCompleted > 0 ? "completed" : "failed", roundsCompleted, participants: Array.from(participantResults.values()), report, keySignals: [], transcript: request.includeTranscript ? transcript : undefined, requestedBackend: "pool", backendUsed: "pool" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { meetingId: request.meetingId, question: request.question, objective: request.objective, status: "failed", roundsCompleted: 0, participants: Array.from(participantResults.values()), report: "Meeting failed: " + message, keySignals: [], requestedBackend: "pool", backendUsed: "pool" };
    } finally {
      for (const proc of spawnedProcs) { try { proc.kill(); } catch {} }
      cleanupMeetingDir(dir);
    }
  }
}
