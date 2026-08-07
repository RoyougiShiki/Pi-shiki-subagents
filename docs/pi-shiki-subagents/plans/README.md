# Plans and Research Notes

This directory contains planning, audit, and research snapshots for
`pi-shiki-subagents`. These files are not the current runtime specification.

Current user-facing configuration belongs in:

```text
docs/configuration.md
README.md
```

## Document Classes

| Path | Class | How to read it |
|------|-------|----------------|
| `archive/agent-boundary-redesign/` | Historical design proposal | Use as design background. Verify current code before acting on details. |
| `archive/claude-code-harness-study/` | Research notes | Reference material for harness behavior. Not a runtime contract. |
| `archive/lightweight-runtime-stage-gate-design/` | Historical design proposal | Use as workflow/stage-gate background. Verify current implementation before changing behavior. |
| `archive/platform-adapter-cleanup/` | Historical cleanup proposal | Already marked historical; use for package/build boundary context only. |
| `archive/subagent-tui-observability/` | Approved staged plan plus later migration notes | Use for subagent state/view/UI boundary guardrails. Runtime changes still need separate review. |
| `archive/whole-module-complexity-audit/` | Audit snapshot | Use as reproducible audit evidence and follow-up queue. Some findings may be superseded by later commits. |

## Maintenance Rules

- Prefer marking a plan as historical or superseded over deleting it.
- Do not treat research notes as authoritative implementation facts.
- When a follow-up implementation supersedes a finding, add a short note near the finding rather than rewriting the original evidence.
- Do not add default agent names, prompt text, or generated markdown content here as a second source of truth.
- Keep current runtime behavior documented in `docs/configuration.md` or code-level tests.

## Current Runtime Notes

As of the current implementation, pool subagent sessions are file-backed in a
separate subagent session directory and can be resumed from saved session files
when available. See `docs/configuration.md` for the current user-facing summary.
