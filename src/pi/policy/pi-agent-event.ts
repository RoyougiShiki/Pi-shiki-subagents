export const PI_AGENT_EVENT_SCHEMA = "pi.agent.event.v1";

export interface PiAgentEventDetails<TFields extends Record<string, unknown> = Record<string, unknown>> {
  schema: typeof PI_AGENT_EVENT_SCHEMA;
  kind: string;
  title: string;
  summary: string;
  fields: TFields;
  rawText?: string;
}

export function createPiAgentEventDetails<TFields extends Record<string, unknown>>(args: {
  kind: string;
  title: string;
  summary: string;
  fields: TFields;
  rawText?: string;
}): PiAgentEventDetails<TFields> {
  return {
    schema: PI_AGENT_EVENT_SCHEMA,
    kind: args.kind,
    title: args.title,
    summary: args.summary,
    fields: args.fields,
    rawText: args.rawText,
  };
}
