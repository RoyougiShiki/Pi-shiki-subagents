export interface PipelineDelegationGrant {
  caller?: string;
  target: string;
  depth: number;
  childAllowedSubagents?: readonly string[];
  expiresAt: number;
}

export interface PipelineDelegationGrantInput {
  caller?: string;
  target: string;
  depth?: number;
  childAllowedSubagents?: readonly string[];
  ttlMs?: number;
}

const grants: PipelineDelegationGrant[] = [];

function normalize(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pruneExpired(now = Date.now()): void {
  for (let index = grants.length - 1; index >= 0; index--) {
    if (grants[index].expiresAt <= now) grants.splice(index, 1);
  }
}

export function issuePipelineDelegationGrant(input: PipelineDelegationGrantInput): PipelineDelegationGrant {
  const now = Date.now();
  pruneExpired(now);
  const grant: PipelineDelegationGrant = {
    caller: normalize(input.caller),
    target: input.target.trim(),
    depth: input.depth ?? 0,
    childAllowedSubagents: input.childAllowedSubagents ? [...input.childAllowedSubagents] : undefined,
    expiresAt: now + (input.ttlMs ?? 30_000),
  };
  grants.push(grant);
  return grant;
}

export function consumePipelineDelegationGrant(input: {
  caller?: string;
  target: string;
  depth?: number;
}): PipelineDelegationGrant | undefined {
  const now = Date.now();
  pruneExpired(now);
  const caller = normalize(input.caller);
  const target = input.target.trim();
  const depth = input.depth ?? 0;
  const index = grants.findIndex((grant) =>
    grant.caller === caller && grant.target === target && grant.depth === depth,
  );
  if (index < 0) return undefined;
  const [grant] = grants.splice(index, 1);
  return grant;
}

export function resetPipelineDelegationGrantsForTests(): void {
  grants.splice(0, grants.length);
}
