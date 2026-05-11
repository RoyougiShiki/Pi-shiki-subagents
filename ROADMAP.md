# OMO SLIM — Roadmap

## ✅ Completed

### Architecture
- [x] Extract gate/declaration-prompt texts into single source (`src/core/workflow-templates.ts`)
- [x] Split OpenCode plugin entry into adapter layer (`src/adapters/opencode.ts` + minimal `src/index.ts`)
- [x] Define `WorkflowPack` interface with registry + merge logic (`src/core/workflow-pack.ts`)
- [x] `workflowPacks` config array (`workflowPacks: string[]`) in schema

### Superpowers Migration — Complete
- [x] brainstorming SKILL.md (conflicts resolved, references mapped to OMO subagents)
- [x] resume-plan SKILL.md
- [x] specproductdesign SKILL.md (all templates restored)
- [x] All 9 reference docs migrated (byte-identical to originals)
- [x] BDD scenario guide (bdd.md)
- [x] code-review.md updated to use @oracle
- [x] Auto-register pack skills via `config.skills.paths` at startup

### Subtask TUI Fix
- [x] Inject SubtaskPart into parent session for subagent navigation links

## 🔜 Remaining Work

### Pi Agent Adapter
- [ ] Create `src/adapters/pi.ts` — map Pi events to OMO core events
- [ ] Map OrchestrationGate from `tool.execute.before` (OpenCode) to `tool_call` (Pi)
- [ ] Map Intent/Readiness/Approval gates to Pi lifecycle hooks
- [ ] Use `pi-subagents` / `pi-mcp-adapter` community packages for missing capabilities

### Infrastructure
- [ ] Full integration test suite for pack on/off switching
- [ ] Version bump and release
