import type { WorkflowPack } from '../../core/workflow-pack';

const WORKFLOW_ADDITIONS = `
## Workflow Methodology (superpowers)

When planning implementation, follow these principles:

1. **Test-Driven Development** - Write tests first, always.
2. **Systematic over ad-hoc** - Process over guessing.
3. **Complexity reduction** - Simplicity as primary goal.
4. **Evidence over claims** - Verify before declaring success.

### Planning
- Use \`docs/plans/{project-name}/plan.md\` for implementation plans
- Each task should be 2-5 minutes, independently completable
- Include complete code examples and verification commands

### Execution
- After each task: subagent implements → spec review (hard gate) → quality review
- State flow: pending → implemented → spec_reviewed → completed
- On spec failure: abort current round immediately, fix, re-review

### Available Skills
The following methodology skills are installed and can be loaded via the \`skill\` tool:
- \`brainstorming\` — design refinement workflow, TDD/BDD reference docs included
- \`resume-plan\` — task recovery and continue
- \`specproductdesign\` — requirement document generation with BDD scenarios
`;

const COMMUNICATION_ADDITIONS = `
## Communication
- When offering suggestions, present 2-3 alternatives with tradeoffs
- Use checkboxes/choices instead of open-ended questions when possible
`;

export function createSuperpowersPack(): WorkflowPack {
  return {
    id: 'superpowers',
    title: 'Superpowers Workflow Pack',
    description:
      'Optional workflow skills: brainstorming, spec product design, resume-plan.',
    orchestrator: {
      workflowAdditions: WORKFLOW_ADDITIONS,
      communicationAdditions: COMMUNICATION_ADDITIONS,
    },
  };
}
