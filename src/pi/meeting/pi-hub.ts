/**
 * pi-hub — 消息路由中心
 *
 * 职责：
 *   1. 管理活跃会议及其 participant SDK session
 *   2. 消息广播：broadcast → 指定 meeting 的所有 participant
 *   3. 群聊中参与者发言自动中继给其他参与者
 *   4. 消息日志（供已显式接入的 overlay/bridge 查看历史；当前不注册 /chat 命令）
 *   5. 用户消息订阅（供 bridge 实时显示）
 *
 * 消息隔离：每条消息按 meetingId 路由，不同会议互不干扰
 *
 * 基于 pi SDK AgentSession，无子进程通信。
 */

import * as crypto from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const MAX_MESSAGES = 500;

export interface MeetingParticipant {
  name: string;
  agentType: string;
  session: AgentSession;
}

export interface ChatStatusMetadata {
  scope?: "workflow" | "pool" | "standalone";
  state?: "working" | "waiting" | "idle" | "failed" | "dead" | "done";
  startedAt?: number;
  fallbackRecommended?: boolean;
}

export interface ChatMessage {
  id: string;
  meetingId: string;
  from: string;
  content: string;
  timestamp: number;
}

export interface ActiveMeeting {
  id: string;
  name: string;
  type: "chat" | "group";
  participants: MeetingParticipant[];
  messages: ChatMessage[];
  startedAt: number;
  status: "active" | "ended";
  report?: string;
  chatStatus?: ChatStatusMetadata;
  onUserMessage?: (message: string) => Promise<{ response?: string; error?: string } | void>;
}

type MessageCallback = (msg: ChatMessage, meeting: ActiveMeeting) => void;

async function sendToSession(session: AgentSession, message: string): Promise<void> {
  const sess = session as any;
  try {
    if (sess.isStreaming) {
      await sess.steer(message);
    } else {
      await sess.prompt(message);
    }
  } catch (err) {
    console.error(`[pi-hub] sendToSession failed:`, err);
  }
}

class Hub {
  private meetings = new Map<string, ActiveMeeting>();
  private messageListeners = new Map<string, Set<MessageCallback>>();

  registerMeeting(id: string, name: string, participants: MeetingParticipant[]): ActiveMeeting {
    if (this.meetings.has(id)) {
      throw new Error(`Meeting "${id}" already exists`);
    }
    const meeting: ActiveMeeting = {
      id, name, type: "group", participants, messages: [],
      startedAt: Date.now(), status: "active",
    };
    this.meetings.set(id, meeting);
    for (const p of participants) this.watchParticipant(meeting, p);
    return meeting;
  }

  registerChat(
    id: string,
    name: string,
    participant: MeetingParticipant,
    onUserMessage?: ActiveMeeting["onUserMessage"],
    chatStatus?: ChatStatusMetadata,
  ): ActiveMeeting {
    if (this.meetings.has(id)) {
      throw new Error(`Meeting "${id}" already exists`);
    }
    const meeting: ActiveMeeting = {
      id, name, type: "chat", participants: [participant], messages: [],
      startedAt: Date.now(), status: "active", onUserMessage,
      chatStatus: chatStatus ?? { scope: "standalone", state: "idle", startedAt: Date.now() },
    };
    this.meetings.set(id, meeting);
    this.watchParticipant(meeting, participant);
    return meeting;
  }

  private watchParticipant(meeting: ActiveMeeting, p: MeetingParticipant) {
    // Subscribe to session events to capture assistant responses
    const unsubscribe = p.session.subscribe((event: any) => {
      if (event.type !== "agent_end") return;
      const msgs: any[] = event.messages ?? [];
      for (const m of msgs) {
        if (m.role !== "assistant") continue;
        const texts = (m.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        if (texts.length === 0) continue;
        const text = texts.join("\n").trim();
        if (!text) continue;
        this.handleAgentResponse(meeting, p, text);
      }
    });

    // Track session disposal
    (p.session as any).agent.waitForIdle().then(() => {
      /* session still active */
    }).catch(() => {
      if (meeting.status === "active" && meeting.chatStatus?.state !== "done") {
        meeting.chatStatus = { ...(meeting.chatStatus ?? {}), state: "dead", fallbackRecommended: meeting.chatStatus?.scope === "workflow" };
      }
    });
  }

  /** 处理参与者回复：记录 + 通知用户 + 群聊中继给其他参与者 */
  private async handleAgentResponse(meeting: ActiveMeeting, sender: MeetingParticipant, text: string): Promise<void> {
    this.publishMessage(meeting, sender.name, text);

    // 群聊：中继给其他参与者
    if (meeting.type === "group") {
      const others = meeting.participants.filter(p => p.name !== sender.name);
      if (others.length === 0) return;
      const relayMsg = `[${sender.name}]: ${text}`;
      const promises = others.map(p => sendToSession(p.session, relayMsg).catch(err => {
        console.error(`[pi-hub] 中继到 ${p.name} 失败: ${err.message}`);
      }));
      await Promise.all(promises);
    }
  }

  async broadcast(meetingId: string, message: string, fromName = "You"): Promise<void> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || meeting.status === "ended") return;

    this.publishMessage(meeting, fromName, message);

    if (meeting.onUserMessage && fromName === "You") {
      const result = await meeting.onUserMessage(message);
      if (result?.error) console.error(`[pi-hub] 用户消息处理失败: ${result.error}`);
      return;
    }

    const promises = meeting.participants.map(p =>
      sendToSession(p.session, message).catch(err => {
        console.error(`[pi-hub] 写入 ${p.name} 失败: ${err.message}`);
      })
    );
    await Promise.all(promises);
  }

  private publishMessage(meeting: ActiveMeeting, from: string, content: string): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(), meetingId: meeting.id, from, content, timestamp: Date.now(),
    };
    meeting.messages.push(msg);
    if (meeting.messages.length > MAX_MESSAGES) {
      meeting.messages.splice(0, meeting.messages.length - MAX_MESSAGES);
    }

    const cbs = this.messageListeners.get(meeting.id);
    if (cbs) for (const cb of cbs) cb(msg, meeting);
  }

  endMeeting(meetingId: string, report?: string): void {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return;
    meeting.status = "ended";
    meeting.report = report;
    meeting.chatStatus = { ...(meeting.chatStatus ?? {}), state: "done" };
  }

  updateChatStatus(meetingId: string, patch: ChatStatusMetadata): void {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return;
    meeting.chatStatus = { ...(meeting.chatStatus ?? {}), ...patch };
  }

  onMessage(meetingId: string, cb: MessageCallback): () => void {
    if (!this.messageListeners.has(meetingId)) this.messageListeners.set(meetingId, new Set());
    this.messageListeners.get(meetingId)!.add(cb);
    return () => this.messageListeners.get(meetingId)?.delete(cb);
  }

  getMeeting(id: string): ActiveMeeting | undefined {
    return this.meetings.get(id);
  }

  getActiveMeetings(): ActiveMeeting[] {
    return Array.from(this.meetings.values()).filter((m) => m.status === "active");
  }

  getAllMeetings(): ActiveMeeting[] {
    return Array.from(this.meetings.values());
  }
}

let instance: Hub | null = null;

export function getHub(): Hub {
  if (!instance) instance = new Hub();
  return instance;
}

export function resetHub(): void {
  instance = null;
}
