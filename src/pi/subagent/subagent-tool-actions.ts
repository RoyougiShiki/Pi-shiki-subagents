export const SUBAGENT_POOL_ACTIONS = [
  'spawn',
  'send',
  'list',
  'kill',
  'resume',
  'listSaved',
  'result',
] as const;

export type SubagentPoolAction = (typeof SUBAGENT_POOL_ACTIONS)[number];

export const SUBAGENT_POOL_ACTION = {
  spawn: 'spawn',
  send: 'send',
  list: 'list',
  kill: 'kill',
  resume: 'resume',
  listSaved: 'listSaved',
  result: 'result',
} as const satisfies Record<SubagentPoolAction, SubagentPoolAction>;

export const SUBAGENT_EXECUTION_POOL_ACTIONS = [
  SUBAGENT_POOL_ACTION.spawn,
  SUBAGENT_POOL_ACTION.send,
  SUBAGENT_POOL_ACTION.resume,
] as const satisfies readonly SubagentPoolAction[];

export type SubagentExecutionPoolAction =
  (typeof SUBAGENT_EXECUTION_POOL_ACTIONS)[number];

const executionPoolActions = new Set<string>(SUBAGENT_EXECUTION_POOL_ACTIONS);

export function isSubagentExecutionPoolAction(
  value: unknown,
): value is SubagentExecutionPoolAction {
  return typeof value === 'string' && executionPoolActions.has(value);
}
