/**
 * pi-chat-bridge — dormant/experimental chat TUI overlay
 *
 * This module is not wired to a /chat command in the active Pi extension.
 * Keep it out of default terminal flows unless the chat command contract is explicitly decided.
 * Overlay behavior when explicitly invoked: bottom anchored input and
 * top-clipped scrolling for long message history.
 */

import { Input, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChatStatusView } from "./chat-status-view";
import { getHub, type ChatMessage } from "../meeting/pi-hub";

const OVERLAY_HEIGHT_RATIO = 0.8;

// 当前用户手动打开的聊天 meetingId，用于判断是否自动弹出
let _activeManualMeeting: string | null = null;
let _currentOverlayMeeting: string | null = null;

function cleanContent(text: string): string {
  return text
    .replace(/<\/?(?:results|result|answer|item|tool_use|thinking|status)[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runPrivateChat(
  meetingId: string, agentName: string, ctx: ExtensionContext,
): Promise<void> {
  _activeManualMeeting = meetingId;
  await showChatOverlay(meetingId, agentName, "chat", ctx, true);
}

export async function runGroupChat(
  meetingId: string, meetingName: string, ctx: ExtensionContext,
): Promise<void> {
  _activeManualMeeting = meetingId;
  await showChatOverlay(meetingId, meetingName, "group", ctx, true);
}

async function showChatOverlay(
  meetingId: string, displayName: string, mode: "chat" | "group", ctx: ExtensionContext, manual: boolean,
): Promise<void> {
  const hub = getHub();

  const meeting = hub.getMeeting(meetingId);
  if (!meeting || meeting.status === "ended") {
    ctx.ui.notify("会话不存在或已结束", "error");
    return;
  }

  let disposed = false;

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const messages: ChatMessage[] = meeting.messages;
      const input = new Input();
      const borderColor = (s: string) => theme.fg("accent", s);

      const header = mode === "group"
        ? `群聊: ${displayName}`
        : `私聊: ${displayName}`;

      let scrollOffset = 0; // 从底部往上滚的行数，0 = 显示最新内容

      // 复用组件
      const topBorder = new DynamicBorder(borderColor);
      const titleText = new Text(theme.fg("accent", theme.bold(header)), 1, 0);
      const sepBorder = new DynamicBorder(borderColor);
      const footerSpacer = new Spacer(1);
      const helpText = new Text("", 1, 0);
      const botBorder = new DynamicBorder(borderColor);

      input.onSubmit = (value: string) => {
        if (value.trim()) {
          hub.broadcast(meetingId, value.trim());
          input.setValue("");
          scrollOffset = 0;
          tui.requestRender();
        }
      };

      input.onEscape = () => safeClose();

      function safeClose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        if (manual) _activeManualMeeting = null;
        _currentOverlayMeeting = null;
        done(undefined);
      }

      const unsubscribe = hub.onMessage(meetingId, () => {
        scrollOffset = 0;
        tui.requestRender();
      });

      return {
        get focused() { return input.focused; },
        set focused(v: boolean) { input.focused = v; },
        render(w: number) {
          const termRows = (tui.terminal as { rows?: number }).rows ?? 24;
          const maxRows = Math.max(4, Math.floor(termRows * OVERLAY_HEIGHT_RATIO));

          // Header
          const headerLines = [
            ...topBorder.render(w),
            ...titleText.render(w),
            ...sepBorder.render(w),
          ];

          // Footer（必须始终保留）
          const footerLines = [
            ...footerSpacer.render(w),
            ...input.render(w),
            ...helpText.render(w),
            ...botBorder.render(w),
          ];

          const fixedLines = headerLines.length + footerLines.length;
          const budget = maxRows - fixedLines; // 留给消息的最大行数

          // 渲染全部消息
          let msgLines: string[] = [];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const fromStyled = msg.from === "You"
              ? theme.fg("accent", "You")
              : theme.fg("userMessageText", msg.from);
            const cleaned = cleanContent(msg.content);
            if (!cleaned) continue;
            const textComp = new Text(`${fromStyled}: ${cleaned}`, 1, 0);
            msgLines.unshift(...textComp.render(w));
          }

          // 消息区域行数预算 = maxRows - header - footer
          const msgBudget = maxRows - headerLines.length - footerLines.length;

          // 只裁剪消息区域，header 和 footer 始终固定
          const msgExcess = Math.max(0, msgLines.length - msgBudget);
          const msgStart = msgExcess - Math.min(scrollOffset, msgExcess);
          const visibleMsgs = msgLines.slice(msgStart, msgStart + msgBudget);

          // 状态指示
          const scrollInfo = msgLines.length > msgBudget
            ? `[${scrollOffset}/${msgExcess}] ↑↓ 滚动 · `
            : ``;
          const status = createChatStatusView({
            name: meeting.name,
            state: meeting.chatStatus?.state ?? "idle",
            scope: meeting.chatStatus?.scope ?? "standalone",
            startedAt: meeting.chatStatus?.startedAt ?? meeting.startedAt,
            fallbackRecommended: meeting.chatStatus?.fallbackRecommended,
          });
          helpText.setText(theme.fg("dim",
            `${scrollInfo}${status.bottomLine} · Enter 发送 · Esc 退出`,
          ));

          const result = [...headerLines, ...visibleMsgs, ...footerLines];
          while (result.length < maxRows) result.push("");
          return result;
        },
        invalidate() {
          topBorder.invalidate();
          titleText.invalidate();
          sepBorder.invalidate();
          footerSpacer.invalidate();
          input.invalidate();
          helpText.invalidate();
          botBorder.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.up)) {
            scrollOffset++;
            tui.requestRender();
          } else if (matchesKey(data, Key.down)) {
            scrollOffset = Math.max(0, scrollOffset - 1);
            tui.requestRender();
          } else {
            input.handleInput(data);
            tui.requestRender();
          }
        },
        dispose() { safeClose(); },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "80%",
        anchor: "bottom-center",
        margin: 0,
      },
    },
  );
}

/**
 * 自动打开 Chat overlay 显示子代理消息。
 * 只在用户没有手动使用 Chat 时才自动弹出。
 */
export function autoOpenChat(
  meetingId: string,
  displayName: string,
  ctx: ExtensionContext,
): void {
  if (_activeManualMeeting && _activeManualMeeting !== meetingId) return;
  if (_currentOverlayMeeting === meetingId) return;
  _currentOverlayMeeting = meetingId;
  showChatOverlay(meetingId, displayName, "chat", ctx, false).catch(() => {});
}
