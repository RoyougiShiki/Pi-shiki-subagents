# Lightweight Runtime Anti-Hallucination and Workflow Stage Gate Design

## Status

Design accepted. This document describes the next runtime design direction for `oh-my-opencode-slim`.

This is a new lightweight design. It intentionally does **not** restore the old WorkflowManager system.

## Motivation

The coordinator is not a user-intent executor. It is a neutral, skeptical runtime gatekeeper. It must not blindly trust:

- user claims,
- model claims,
- subagent results,
- unsupported conclusions,
- requests to skip review or process.

The runtime should support these principles:

1. Clarify when there are blocking unknowns.
2. Use adversarial oracle review for high-risk or policy-weakening changes.
3. Do not treat claims as facts without evidence.
4. Do not let coordinator skip workflow stages and jump directly to implementation.
5. Keep controls lightweight, modular, and config-driven.

## Confirmed Current State

### Existing runtime controls

The codebase already has these pieces:

- tool scope allowlist via `src/pi/policy/tool-scope-manager.ts`,
- task clarification checks via `src/pi/policy/clarification-policy.ts`,
- evidence recording via `src/pi/policy/evidence-tracker.ts`,
- verification warnings via `src/pi/policy/verification-evidence-policy.ts`,
- subagent task contract checks via `src/pi/policy/subagent-contract-policy.ts`,
- delegation matrix checks via `src/adapters/delegation-rules.ts`,
- workflow type/config definitions via `src/config/workflow-types.ts` and `src/config/schema.ts`.

### Confirmed gaps

The current runtime lacks:

- active `currentWorkflow` / `currentStage` session state,
- workflow-stage-based subagent spawn gating,
- oracle review state ledger,
- blocking unknown state ledger,
- workflow-aware evidence/runtime status summary.

There is also a delegation identity gap: top-level `omo_subagent` calls can have no caller identity, and caller-less delegation currently falls through as allowed.

## Non-Goals

Do **not** implement these in the first version:

- restore old `WorkflowManager`, workflow commands, or workflow chat binding,
- implement a complex workflow engine,
- implement automatic multi-stage orchestration,
- implement automatic pipeline/stage progression,
- add implicit stage transitions after subagent completion,
- require all agent output to contain JSON manifests,
- scan natural-language output for phrases such as “done” or “tested”,
- add per-tool user approval gates,
- hard-code workflow names or agent names,
- add historical alias compatibility such as `thinker -> analyst` inside runtime gates.

## Design Principles

### 1. Config-driven, not name-driven

Runtime gates must not hard-code specific workflow or agent names.

The workflow stage gate should only consume structured configuration:

- selected workflow,
- current stage,
- current stage agent,
- current stage `allowedSubagents`,
- current stage review agent,
- requested target agent.

The generic rule is:

```text
requested target is allowed only if it is in the current stage's configured allowed target set.
```

### 2. No prompt or markdown dependency

Runtime gates must not depend on prompt wording or markdown content. Prompts explain behavior; runtime state and config enforce behavior.

### 3. Do not become a format police

Free-form discussion should remain free-form. The runtime should gate **state advancement** and **tool/subagent execution**, not ordinary prose.

### 4. Separate responsibilities

- Tool scope controls which tools a mode/subagent can use.
- Delegation matrix controls which caller may theoretically delegate to which target.
- Workflow stage gate controls which target can be spawned in the current workflow stage.
- Unknown state controls whether the system can advance while critical questions remain.
- Oracle state controls whether high-risk or challenged decisions can proceed.
- Evidence status controls what the runtime can truthfully report as verified.

## Proposed Modules

### 1. Tool Scope

Already exists. Keep it as the single source of truth for available tools.

Responsible for:

```text
Can this mode/subagent use this tool?
```

Not responsible for:

```text
Can this mode use `omo_subagent` to spawn a specific target right now?
```

### 2. Delegation Identity and Matrix

Purpose:

```text
Ensure delegation checks always know who the caller is.
```

Caller identity should come from runtime context, such as:

- current subagent environment when inside a subagent,
- current active mode/tool-scope source for top-level calls.

Caller-less delegation must not silently allow all targets.

The delegation matrix remains responsible only for theoretical caller-to-target permission. It does not know workflow stage order.

### 3. Workflow Stage Gate

Purpose:

```text
Prevent coordinator or other orchestrating contexts from skipping workflow stages.
```

Inputs:

- workflow config,
- current workflow name,
- current stage index or id,
- requested target agent,
- known agent registry.

Allowed target set:

```text
current stage agent
+ current stage allowedSubagents
+ current stage review agent, if configured
```

Decision:

```text
if requested target is in allowed target set: allow
else: block
```

This is a runtime flow-integrity gate, not a user approval gate. User approval must not override stage order.

A valid workflow stage gate decision is only the first layer. Pipeline execution also keeps a second layer:

```text
system stage gate must allow the target first;
then the user approves the current stage primary agent spawn.
```

Starting the current stage primary agent is workflow authority, not ordinary delegation authority. The runtime may issue a short-lived, one-shot internal grant after stage-gate success and user approval so the tool execution layer can distinguish this path from ordinary delegation. The grant must be consumed only after spawn parameters and target registration are valid.

Review agents and explicitly configured auxiliary subagents may be allowed without user approval. They are used for evidence collection and adversarial review, not for advancing the main pipeline stage. Stage auxiliary permissions narrow the caller's configured delegation permissions; they must not expand a caller beyond its base delegation authority.

### 4. Workflow Session State

First version should keep only minimal state:

```text
current workflow name
current stage index or id
optional stage status: active / completed / blocked
```

Initial state:

- read the selected workflow from runtime configuration,
- set current stage to the first configured stage.

Do not implement full automatic orchestration in the first version.

Do not implement automatic stage progression. Pipeline progression, when added later, must be explicit and user-approved after runtime checks. A subagent completing work must not automatically move the workflow to the next stage.

### 5. Configuration Validation

Workflow config should be validated against known agents.

Invalid examples:

- workflow default points to a missing workflow,
- stage agent does not exist,
- review agent does not exist,
- allowed subagent does not exist.

Invalid config should produce a clear runtime error. Runtime gates should not add historical aliases or guess replacements.

### 6. Unknown / Clarification State

Future lightweight ledger for blocking unknowns.

Possible sources:

- user requirement ambiguity,
- subagent `openQuestions`,
- oracle evidence gaps,
- task contract failures,
- unrecovered tool failure.

Effect:

```text
blocking unknowns prevent advancement to later workflow stages or final completion.
```

Do not use natural-language inference in the first version.

### 7. Oracle Review State

Future lightweight ledger for oracle review conclusions.

Suggested conclusions:

- approve,
- approve-with-conditions,
- changes-requested,
- reject,
- inconclusive.

Effect:

```text
unresolved changes-requested / reject / inconclusive prevents continuing the same high-risk direction.
```

Do not automatically call oracle in the first version unless explicitly designed later.

### 8. Evidence / Runtime Status

Use evidence to report actual runtime status, not to police prose.

Track and summarize:

- code changes recorded,
- test/build/typecheck evidence,
- failed tool calls without recovery,
- pending subagents,
- oracle state,
- blocking unknowns.

The final user-visible status should be derived from runtime evidence, not from model confidence.

## Gate Order

Recommended order before `omo_subagent` spawn:

1. Parameter completeness.
2. Subagent task contract.
3. Non-pipeline rescue modes may bypass workflow stage constraints after the task contract check.
4. Caller identity normalization.
5. Workflow stage gate for pipeline modes.
6. Pipeline user approval only for the current stage primary agent, if pipeline approval is enabled.
7. One-shot workflow-primary delegation grant is issued only after user approval.
8. Tool execution validates target registration before consuming any grant.
9. Ordinary delegation matrix applies when no workflow-primary grant exists.

Important: workflow stage block should not ask the user for approval. It is a runtime process constraint. User approval is a second layer after the system gate passes; it must not be used to bypass an invalid workflow stage.

## Configuration Handling

The current runtime configuration file is the source of truth. Project defaults are seed data, not the sole runtime source.

If local configuration is stale or references removed agents, the runtime should report configuration invalidity instead of silently guessing.

Do not implement legacy name compatibility in workflow gates.

If migration is desired later, implement it in a dedicated config migration layer, not in policy gate logic.

## Testing Strategy

### Policy tests should use synthetic names

Core workflow-stage-policy tests should not depend on real default agents. Use small synthetic config examples:

- current stage agent is allowed,
- current stage review agent is allowed,
- current stage allowed subagent is allowed,
- future stage agent is blocked,
- unknown target is blocked,
- invalid workflow config is reported.

### Integration tests can verify defaults

Separate tests may verify that project default workflow config validates against the current bundled agent registry.

### Delegation tests

Add tests for:

- missing caller does not bypass protected delegation paths,
- valid caller + allowed target passes,
- valid caller + disallowed target blocks.

## Incremental Implementation Plan

### Phase 1: Caller identity fix

- Ensure top-level subagent spawn has a normalized caller identity.
- Do not allow caller-less delegation to bypass checks.
- Keep changes minimal and covered by tests.

### Phase 2: Workflow stage policy

- Add a pure policy module for stage target validation.
- Keep it config-only and name-agnostic.
- Add synthetic policy tests.

### Phase 3: Runtime hook

- Wire workflow stage policy into `omo_subagent` spawn gating.
- Use current runtime configuration and minimal workflow session state.
- Do not restore WorkflowManager.

### Phase 4: Validation and status

- Add workflow config validation against known agents.
- Add minimal runtime status reporting for invalid config and stage blocks.
- Keep workflow configuration and known agents as a session snapshot in V1; runtime edits to configuration require a new session to take effect.

### Implemented in V1

Implemented scope:

- caller identity normalization for top-level `omo_subagent` calls,
- missing caller no longer silently bypasses delegation checks,
- config-driven `workflow-stage-policy` pure module,
- runtime `omo_subagent` spawn gate for the active workflow stage,
- stage gate executes before user approval,
- user approval only applies to the current stage primary agent,
- current stage primary spawn is bridged to the tool execution layer through a short-lived one-shot grant issued only after user approval,
- review agents and configured auxiliary subagents do not require per-call approval,
- configured auxiliary subagents narrow the caller's base delegation permissions rather than expanding them,
- non-pipeline rescue modes bypass workflow stage constraints after task-contract validation to avoid lockout,
- legacy per-agent `blocked` and mode-transition `next` gates were removed from runtime config support,
- local stale `thinker` workflow/preset references were removed from the current user config.

Validation performed:

```text
bun test
bun run typecheck
bun run build
bun run verify:release
```

### Known V1 limitations

1. `stageIndex` remains `0` throughout the session. V1 does not implement pipeline/stage progression.
2. Only the first configured workflow stage is active. Later stage agents are correctly blocked, but there is no runtime API yet to move to the next stage.
3. Missing or empty workflow configuration emits a warning/user notification and then fails open to the existing delegation/task-contract behavior. A future stricter policy may fail closed for pipeline modes while still allowing rescue modes.
4. Workflow config and known agent names are captured as session snapshots. Runtime config edits require a session restart.
5. There is no automatic transition on `pool_completed`; subagent completion must not imply workflow advancement.
6. The first version has no stage result ledger, oracle review ledger, or blocking unknown ledger yet.

### Phase 5: Unknown / oracle / evidence ledgers

- Add only after the workflow stage gate is stable.
- Keep ledgers explicit and lightweight.

## Expected Behavior

Given any configured workflow, if the current stage allows targets `{A, R, S}`:

```text
spawn A => allow
spawn R => allow
spawn S => allow
spawn any other target => block
```

This remains true regardless of whether A, R, or S are named analyst, oracle, worker, dispatcher, or any custom agent.

## Summary

The next runtime design should restore the missing process boundary:

```text
current workflow stage determines which subagent may be spawned.
```

It should do this with:

- existing tool scope retained,
- fixed caller identity,
- a new config-driven workflow stage gate,
- minimal session state,
- clear config validation,
- no hard-coded agent or workflow names,
- no restoration of the old WorkflowManager,
- no natural-language string gates,
- no legacy alias compatibility in runtime policy.
