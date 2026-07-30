# Remove completion auditor; keep mechanical harness boundaries

Per-turn `[harness] 完成审计提醒` noise came from an opt-in completion auditor that warned on modification-without-verification evidence at every assistant `message_end`. It did not inject a real continuation, did not implement a Stop-style exit gate, and conflicted with the thin-runtime goal of minimizing soft “must/must-not” agent interference for strong coding models.

We surgically remove the completion-auditor path (runtime hook, config surface, and local enablement) while keeping mechanical harness pieces such as `toolResultBudget`, tool scope, dangerous Bash blocking, and pool depth limits. Goal alignment and acceptance stay optional via skills/commands (`grill-me`, `grill-with-docs`, `to-spec`) and explicit tools (`oracle`, `omo_council`), not a default per-turn gate.

## Considered Options

- **Default-off only.** Rejected as a long-term answer: dead weight and a footgun remain in tree.
- **Tighten triggers or restore true block/continue.** Rejected for now: still a completion police layer; Pi lacks an equivalent first-class Stop/continuation contract we want to rebuild.
- **Delete the entire harness package.** Rejected: would remove valuable mechanical budgeting (`toolResultBudget`) along with the noisy auditor.
