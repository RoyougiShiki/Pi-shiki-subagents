# OMO SLIM — Roadmap

## ✅ Completed — Core Refactor (Phase 1)

### Architecture
- [x] Extract gate/declaration-prompt texts into single source (`src/core/workflow-templates.ts`)
- [x] Split OpenCode plugin entry into adapter layer (`src/adapters/opencode.ts` + minimal `src/index.ts`)
- [x] Define `WorkflowPack` interface with registry + merge logic (`src/core/workflow-pack.ts`)
- [x] `workflowPacks` config array (`workflowPacks: string[]`) in schema

### Superpowers Pack
- [x] Migrate brainstorming SKILL.md (stripped declaration protocol — handled by ApprovalGate)
- [x] Migrate resume-plan SKILL.md
- [x] Migrate specproductdesign SKILL.md
- [x] Auto-register pack skills via `config.skills.paths` at startup

### Gates (unchanged)
- [x] 4 original gates: Intent, Readiness, Orchestration, Approval
- [x] All gate instruction texts unchanged
- [x] ApprovalGate remains the code-level hard gate (pack skills don't duplicate)

## 🔜 Remaining Work

### Pi Agent Adapter
- [ ] Create `src/adapters/pi.ts` — map Pi events to OMO core events
- [ ] Replace task/subagent dependency: use `pi-subagents` package instead of OpenCode child sessions
- [ ] Map OrchestrationGate from `tool.execute.before` (OpenCode) to `tool_call` (Pi)
- [ ] Map Intent/Readiness/Approval gates to Pi lifecycle hooks

### Superpowers Pack Enhancements
- [ ] Add BDD scenario template (GIVEN/WHEN/THEN) as a reference document
- [ ] Define skill permission rules that respect `workflowPacks` enable/disable toggle

### Infrastructure
- [ ] Full integration test suite for pack on/off switching
- [ ] Version bump and release after Pi adapter stabilization
