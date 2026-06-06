import type {
  SubagentRunEvent,
  SubagentUsageSnapshot,
} from './subagent-run-state';

export interface SessionEventContext {
  runId: string;
  agentName: string;
  now: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      const record = asRecord(part);
      if (!record) return undefined;
      if (record.type === 'text') return asString(record.text);
      return undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .trim();
  return text || undefined;
}

function latestAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message?.role !== 'assistant') continue;
    const text = extractText(message.content);
    if (text) return text;
  }
  return undefined;
}

function readCost(value: unknown): number | undefined {
  const direct = asFiniteNumber(value);
  if (direct !== undefined) return direct;
  const record = asRecord(value);
  return asFiniteNumber(record?.total);
}

export function extractUsageSnapshot(
  value: unknown,
): SubagentUsageSnapshot | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const snapshot: SubagentUsageSnapshot = {};
  const input = asFiniteNumber(
    usage.input ?? usage.inputTokens ?? usage.promptTokens,
  );
  const output = asFiniteNumber(
    usage.output ?? usage.outputTokens ?? usage.completionTokens,
  );
  const cacheRead = asFiniteNumber(
    usage.cacheRead ?? usage.cache_read ?? usage.cachedInputTokens,
  );
  const cacheWrite = asFiniteNumber(usage.cacheWrite ?? usage.cache_write);
  const cost = readCost(usage.cost);
  const contextTokens = asFiniteNumber(
    usage.contextTokens ?? usage.context_tokens,
  );
  const turns = asFiniteNumber(usage.turns);

  if (input !== undefined) snapshot.input = input;
  if (output !== undefined) snapshot.output = output;
  if (cacheRead !== undefined) snapshot.cacheRead = cacheRead;
  if (cacheWrite !== undefined) snapshot.cacheWrite = cacheWrite;
  if (cost !== undefined) snapshot.cost = cost;
  if (contextTokens !== undefined) snapshot.contextTokens = contextTokens;
  if (turns !== undefined) snapshot.turns = turns;

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function compactJsonSummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const path = asString(record.path ?? record.file_path ?? record.filePath);
  if (path) return path;
  const command = asString(record.command);
  if (command) return 'command';
  return undefined;
}

function extractToolName(event: Record<string, unknown>): string | undefined {
  return asString(event.toolName ?? event.name ?? event.tool);
}

function extractToolSummary(event: Record<string, unknown>): string {
  return (
    compactJsonSummary(event.args ?? event.arguments ?? event.input) ??
    'activity'
  );
}

function eventMessage(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asRecord(event.message);
}

export function toSubagentRunEvents(
  context: SessionEventContext,
  event: unknown,
): SubagentRunEvent[] {
  const record = asRecord(event);
  if (!record) return [];
  const type = asString(record.type);
  if (!type) return [];
  const timestamp = context.now();

  if (type === 'turn_start') {
    return [
      { type: 'status', runId: context.runId, timestamp, status: 'streaming' },
    ];
  }

  if (type === 'agent_end') {
    const events: SubagentRunEvent[] = [
      { type: 'status', runId: context.runId, timestamp, status: 'idle' },
    ];
    const text = latestAssistantText(record.messages);
    if (text)
      events.push({
        type: 'assistant_text',
        runId: context.runId,
        timestamp,
        text,
      });
    return events;
  }

  if (type === 'message_end') {
    const message = eventMessage(record);
    if (message?.role !== 'assistant') return [];
    const events: SubagentRunEvent[] = [];
    const text = extractText(message.content);
    if (text)
      events.push({
        type: 'assistant_text',
        runId: context.runId,
        timestamp,
        text,
      });
    const usage = extractUsageSnapshot(message.usage);
    if (usage)
      events.push({ type: 'usage', runId: context.runId, timestamp, usage });
    return events;
  }

  if (type === 'tool_call' || type === 'tool_start' || type === 'tool_use') {
    const toolName = extractToolName(record);
    if (!toolName) return [];
    return [
      {
        type: 'tool_call',
        runId: context.runId,
        timestamp,
        toolName,
        summary: extractToolSummary(record),
      },
    ];
  }

  if (type === 'tool_result' || type === 'tool_end') {
    const toolName = extractToolName(record);
    if (!toolName) return [];
    const isError =
      record.isError === true ||
      record.error === true ||
      Boolean(asString(record.error));
    return [
      {
        type: 'tool_result',
        runId: context.runId,
        timestamp,
        toolName,
        summary: extractToolSummary(record),
        isError,
      },
    ];
  }

  return [];
}
