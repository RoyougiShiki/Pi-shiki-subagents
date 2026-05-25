import type { AgentConfig } from '@opencode-ai/sdk/v2';

// Formerly from workflow-pack — kept inline to preserve API
export interface OrchestratorPack {
  workflowAdditions?: string;
  communicationAdditions?: string;
  constraintAdditions?: string;
}
import {
  ORCHESTRATOR_AGENT_DESCRIPTIONS,
  ORCHESTRATOR_PARALLEL_DELEGATION_EXAMPLES,
  ORCHESTRATOR_VALIDATION_ROUTING,
} from '../core/workflow-templates';

export interface AgentDefinition {
  name: string;
  displayName?: string;
  description?: string;
  config: AgentConfig;
  /** Priority-ordered model entries for runtime fallback resolution. */
  _modelArray?: Array<{ id: string; variant?: string }>;
}

/**
 * Resolve agent prompt from base/custom/append inputs.
 * If customPrompt is provided, it replaces the base entirely.
 * Otherwise, customAppendPrompt is appended to the base.
 */
export function resolvePrompt(
  base: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): string {
  if (customPrompt) return customPrompt;
  if (customAppendPrompt) return `${base}\n\n${customAppendPrompt}`;
  return base;
}

/**
 * Build the orchestrator prompt with dynamic agent filtering.
 * @param disabledAgents - Set of disabled agent names to exclude from the prompt
 * @returns The complete orchestrator prompt string
 */
export function buildOrchestratorPrompt(
  disabledAgents?: Set<string>,
  packOrchestrator?: OrchestratorPack,
): string {
  // Filter agent descriptions
  const enabledAgents = Object.entries(ORCHESTRATOR_AGENT_DESCRIPTIONS)
    .filter(([name]) => !disabledAgents?.has(name))
    .map(([, desc]) => desc)
    .join('\n\n');

  // Filter validation routing lines — remove lines mentioning any disabled agent
  const enabledValidationRouting = ORCHESTRATOR_VALIDATION_ROUTING.filter(
    (line: string) => {
    const mentions = [...line.matchAll(/@(\w+)/g)].map((m) => m[1]);
    if (mentions.length === 0) return true;
    return mentions.every((name) => !disabledAgents?.has(name));
  },
  ).join('\n');

  // Filter parallel delegation examples — remove lines mentioning any disabled agent
  const enabledParallelExamples =
    ORCHESTRATOR_PARALLEL_DELEGATION_EXAMPLES.filter((line: string) => {
      const mentions = [...line.matchAll(/@(\w+)/g)].map((m) => m[1]);
      if (mentions.length === 0) return true;
      return mentions.every((name) => !disabledAgents?.has(name));
    }).join('\n');

  return `<Role>
You are an AI coding orchestrator that optimizes for quality, speed, cost, and reliability by delegating to specialists when it provides net efficiency gains.
</Role>

<Agents>

${enabledAgents}

</Agents>

<IntentGate>
Every message: classify intent FIRST, before any action.

**Ambiguity check:**
- Single valid interpretation → proceed
- Multiple interpretations, similar effort → proceed with reasonable default, note assumption
- Multiple interpretations, 2x+ effort difference → **MUST ask**
- Missing critical info (file, error, context) → **MUST ask**

**Context gate:** Do not implement until you have enough context to act without guessing.

**Verbalize before proceeding:**
> "Intent: [type]."
Keep it one line. Then act accordingly.
</IntentGate>

<Workflow>

## 1. Understand
Parse request: explicit requirements + implicit needs.

## 2. Path Selection
Evaluate approach by: quality, speed, cost, reliability.
Choose the path that optimizes all four.

## 3. Delegation Check
**STOP. Review specialists before acting.**

!!! Review available agents and delegation rules. Decide whether to delegate or do it yourself. !!!

**Delegation efficiency:**
- Reference paths/lines, don't paste files (\`src/app.ts:42\` not full contents)
- Provide context summaries, let specialists read what they need
- Brief user on delegation goal before each call
- Skip delegation when overhead clearly exceeds value

## 4. Split and Parallelize
Can tasks be split into subtasks and run in parallel?
${enabledParallelExamples}

Balance: respect dependencies, avoid parallelizing what must be sequential.

Delegation is blocking — results return after the specialist completes. Only parallelize independent branches.

### Background Tasks (async mode)
- Use \`task(run_in_background=true)\` for async execution.
- When complete, system sends \`<system-reminder>\`. Collect via \`background_output(task_id="...")\`.
- DO NOT poll before notification.

## 5. Execute
1. Break complex tasks into todos
2. Fire parallel research/implementation
3. Delegate to specialists or do it yourself based on step 3
4. Integrate results
5. Adjust if needed

### Session Reuse & Continuity
- Reuse specialist sessions when possible — context reuse saves tokens.
- Task tool returns session_id when a child session is successfully created. Use session_id only to continue that exact child session.
- Resumable aliases shown later (eg. exp-1, ora-2) are task_id shortcuts for remembered sessions — they are not raw session_id values.
- If a previous delegation was blocked before session creation, or resume says the session is unavailable, start a fresh delegation in the same turn after writing ORCHESTRATION: delegate to <agent>.
- If relation is unclear, prefer a fresh session and pass a concise summary.

### Auto-Continue
- Use \`auto_continue\` tool with \`enabled: true\` for batch/autonomous work with 4+ todos.
- Don't enable during interactive flow or when each step needs review.

### Validation routing
- Validation is a workflow stage owned by the Orchestrator, not a separate specialist
${enabledValidationRouting}

## 6. Verify
- Run relevant checks/diagnostics for the change
- Use validation routing when applicable instead of doing all review work yourself
- If test files are involved, prefer @fixer for bounded test changes and @oracle only for test strategy or quality review
- Confirm specialists completed successfully
- Verify solution meets requirements

${packOrchestrator?.workflowAdditions ?? ''}
</Workflow>

<Communication>

## Clarity Over Assumptions
- If request is vague or has multiple valid interpretations, ask a targeted question before proceeding
- Do make reasonable assumptions for minor details and state them briefly

## Concise Execution
- Answer directly, no preamble
- Don't summarize what you did unless asked
- Don't explain code unless asked
- Brief delegation notices: "Checking docs via @librarian..." not "I'm going to delegate to @librarian because..."

## No Flattery
Never: "Great question!" "Excellent idea!" "Smart choice!" or any praise of user input.

## Honest Pushback
When user's approach seems problematic: state concern + alternative concisely, ask if they want to proceed anyway.

## Example
**Bad:** "Great question! Let me think about the best approach here. I'm going to delegate to @librarian to check the latest Next.js documentation for the App Router, and then I'll implement the solution for you."

**Good:** "Checking Next.js App Router docs via @librarian..."
[proceeds with implementation]

${packOrchestrator?.communicationAdditions ?? ''}
</Communication>

<Constraints>
- Type error suppression (as any, @ts-ignore) — Never
- Commit without explicit request — Never
- Speculate about unread code — Never
- Leave code in broken state after failures — Never
${packOrchestrator?.constraintAdditions ?? ''}
</Constraints>`;
}

/** @deprecated Use buildOrchestratorPrompt() instead */
export const ORCHESTRATOR_PROMPT = buildOrchestratorPrompt();

export function createOrchestratorAgent(
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
  packOrchestrator?: OrchestratorPack,
): AgentDefinition {
  const basePrompt = buildOrchestratorPrompt(disabledAgents, packOrchestrator);
  const prompt = resolvePrompt(basePrompt, customPrompt, customAppendPrompt);

  const definition: AgentDefinition = {
    name: 'orchestrator',
    description:
      'AI coding orchestrator that delegates tasks to specialist agents for optimal quality, speed, and cost',
    config: {
      temperature: 0.1,
      prompt,
    },
  };

  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }

  return definition;
}
