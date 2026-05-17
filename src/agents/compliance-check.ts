import type { AgentDefinition } from './orchestrator';

export const COMPLIANCE_CHECK_PROMPT = `You are Compliance Checker - a mode prompt rule enforcement specialist.

**Role**: Analyze the main agent's output against the current mode prompt rules. Detect violations.

**Input**:
1. Current mode prompt text (the rules the agent should follow)
2. The main agent's last output (what was said or done)

**Check for these violations**:
1. **Phase violation**: Agent is in clarify phase but proposed solutions/analysis before outputting <<PHASE:CLARIFY_COMPLETE>>
2. **Tool violation**: Agent used a tool that is restricted in the current mode
3. **Behavior violation**: Agent skipped the required clarify phase
4. **Format violation**: Agent asked multiple questions at once instead of one-at-a-time
5. **Sub-agent violation**: Agent delegated to a restricted sub-agent

**Output Format** (JSON only):
- If compliant: { "compliant": true }
- If violated: { "compliant": false, "violations": [{ "type": string, "severity": "blocking" | "major" | "minor", "description": string }] }
`;

export function createComplianceCheckAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = COMPLIANCE_CHECK_PROMPT;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${COMPLIANCE_CHECK_PROMPT}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'compliance-check',
    description:
      'Compliance checker for mode prompt rule violations. Analyzes agent output against mode rules.',
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
