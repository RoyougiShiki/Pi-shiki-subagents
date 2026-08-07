# Configuration / Schema / CLI / Adapter Domain Review

Status: planning output only. Do not implement from this document without a separate patch task.

Scope: configuration loading, JSONC behavior, source precedence, schema surface, CLI legacy/OpenCode compatibility, adapter/runtime config duplication, package/API exposure, and test-only config helpers.

Baseline inputs:

- `docs/pi-shiki-subagents/plans/whole-module-complexity-audit/README.md`
- `docs/pi-shiki-subagents/plans/whole-module-complexity-audit/scan.mjs`
- Focused source spot checks in `src/config/**`, `src/cli/**`, `src/adapters/**`, `src/index.ts`, `package.json`, and `README.md`

Reporting rule: findings are grouped by capability name first. File paths are evidence only.

## P0 Findings

### P0.1 Pi Extension Declaration Consistency

Recommendation: simplify.

Decision: keep the single maintained Pi extension entry and remove stale two-entry examples from docs/plans.

Evidence:

- `package.json` declares one Pi extension: `./src/pi/core/pi.ts`.
- `README.md` still shows both `./src/pi/core/pi.ts` and `./src/pi/core/pi-modes.ts`.
- The baseline audit already flags the same package/README mismatch and stale platform-adapter cleanup wording.

Cost: small.

Benefit: medium. Prevents duplicate-extension confusion and avoids reviving legacy/OpenCode-adapter assumptions.

Risk: low. This is documentation/package-contract alignment, not runtime behavior.

Validation:

- Grep docs for `pi.extensions`, `pi-modes.ts`, `src/opencode`, and old OpenCode adapter wording.
- Confirm `package.json` remains the source of truth for Pi extension loading.
- Run `bun run typecheck` only if docs edits are bundled with implementation edits elsewhere.

Executable tasks:

1. Update `README.md` to show only `./src/pi/core/pi.ts` in the Pi extension example.
2. Mark `docs/pi-shiki-subagents/plans/platform-adapter-cleanup/proposal.md` as historical/stale where it describes already-removed OpenCode adapter behavior.
3. Add a short note that `src/index.ts` is retained only as a legacy npm main compatibility placeholder.

### P0.2 Subagent Default Agent Definition Resolution

Recommendation: simplify/fix.

Decision: use one shared default-agent path helper for runtime and subagent loading.

Evidence:

- `src/adapters/agent-runtime-config.ts` exposes `getDefaultAgentsPath()` and loads `src/adapters/agents-default.json`.
- The baseline audit reports that the subagent pool builds a separate `../adapters/agents-default.json` path from `src/pi/subagent/subagent-pool.ts`, which can resolve incorrectly depending on runtime `__dirname`.
- `agents-default.json` owns `_tool_groups`; missing it changes subagent tool resolution behavior.

Cost: small.

Benefit: high. Avoids silent loss of default role/tool groups and keeps adapter/runtime defaults centralized.

Risk: low to medium. Effective subagent tools may change if the current broken path was masking defaults.

Validation:

- Unit test default tool groups load from `src/adapters/agents-default.json` through the subagent path.
- Existing `src/adapters/agent-runtime-config.test.ts`.
- Existing subagent pool tests.
- `bun run typecheck`.

Executable tasks:

1. Replace subagent-local default-agent path construction with the shared helper or an equivalent tested wrapper.
2. Add a regression test asserting `_tool_groups.管理` expands through `@子代理` after subagent default load.
3. Add a smoke test or fixture for one default role that relies on `roles`, not explicit `tools`.

### P0.3 Subagent Tool Group Expansion Parity

Recommendation: simplify/fix.

Decision: centralize tool expression expansion semantics across mode and subagent capabilities.

Evidence:

- `agents-default.json` uses nested tool groups such as `_tool_groups.管理 = ["@子代理"]`.
- The baseline audit reports that mode loading expands expressions such as `*`, `@group`, wildcards, and role groups, while the subagent pool path may return raw group entries.
- The user requirement explicitly calls out capability review and subagent pool reuse; permission drift is a capability-level blocker.

Cost: medium.

Benefit: high. Aligns CLI/runtime-configured agents, Pi modes, and pooled subagents around one permission model.

Risk: medium. Fixing expansion can broaden or narrow actual tool allowlists for default roles.

Validation:

- Matrix tests for `dispatcher`, `designer`, `fixer`, `search`, and `coordinator` default tools.
- Tests for nested `@group`, wildcard patterns, exclusions, unknown groups, and duplicate removal.
- Subagent pool spawn smoke for at least one role.
- `bun run typecheck`.

Executable tasks:

1. Identify the authoritative mode-side expansion function and extract or expose a neutral helper only if needed.
2. Apply the same expansion in subagent role/tool resolution.
3. Preserve current deny/unknown behavior with tests before changing implementation.

## P1 Findings

### P1.1 Config Source Precedence Matrix

Recommendation: simplify.

Decision: keep all currently supported config sources, but document and test one explicit precedence order.

Capability order to preserve unless a separate product decision changes it:

1. Built-in defaults.
2. Pi-native config fallback at `~/.pi/agent/pi-shiki-subagents.json` for Pi runtime/subagent model resolution.
3. OpenCode user config from `OPENCODE_CONFIG_DIR` or XDG/default OpenCode config directory.
4. Project config at `.opencode/pi-shiki-subagents.json[c]`.
5. `OH_MY_OPENCODE_SLIM_PRESET` preset selection override.
6. Root agent overrides beat preset agent fields at the same config layer.

Evidence:

- `src/config/loader.ts` loads OpenCode user config and project config, deep-merges known nested sections, and applies `OH_MY_OPENCODE_SLIM_PRESET`.
- `src/config/loader.test.ts` covers JSONC support, project-over-user precedence, preset fallback, and env preset override.
- `src/adapters/agent-runtime-config.ts` merges Pi-native config as fallback with shared config.
- `src/adapters/agent-runtime-config.test.ts` covers Pi-native fallback and shared config override.
- `src/adapters/pi.test.ts` covers Pi-native + OpenCode user + project precedence through the Pi adapter path.

Cost: small to medium.

Benefit: high. Reduces future regressions when schema, installer, runtime agent loading, or preset switching changes.

Risk: medium. Precedence is user-visible; changing it can alter selected models/tools.

Validation:

- Add or consolidate a matrix test that names every source and expected winning value.
- Include one nested `options` merge case and one top-level array replacement case.
- `bun test src/config/loader.test.ts src/adapters/agent-runtime-config.test.ts src/adapters/pi.test.ts`.
- `bun run typecheck`.

Executable tasks:

1. Write a precedence table in configuration docs or this plan before code changes.
2. Add the missing matrix cases instead of duplicating broad setup across test files.
3. Treat any precedence behavior change as a separate product decision.

### P1.2 JSONC Parser Duplication

Recommendation: simplify.

Decision: keep JSONC support, but converge parser helpers or explicitly freeze them as equivalent.

Evidence:

- `src/config/loader.ts` has a local `stripJsonComments` helper for plugin config.
- `src/cli/config-io.ts` has a separate exported `stripJsonComments` helper for OpenCode config mutation.
- `src/adapters/pi.test.ts` imports `stripJsonCommentsSafely` from `src/pi/core/pi`, indicating a third Pi-side JSONC path.
- Tests cover URLs in strings, comments, trailing commas, and `.jsonc` preference, but the parser contract is spread across modules.

Cost: medium if helper extraction crosses package boundaries; small if only tests freeze equivalence.

Benefit: medium. Prevents subtle config/read/write differences between installer, shared loader, and Pi runtime.

Risk: medium. Comment stripping is easy to break for strings, URLs, escaped quotes, and trailing commas.

Validation:

- Shared parser fixture with URLs, escaped quotes, block comments, line comments, and trailing commas.
- Existing JSONC tests in `src/config/loader.test.ts` and Pi adapter tests.
- CLI config I/O tests for `.json` fallback to `.jsonc`.

Executable tasks:

1. Inventory all JSONC stripping helpers and their call sites.
2. Prefer one exported helper from a neutral config utility if import boundaries stay clean.
3. If extraction is too invasive, add equivalence tests and defer extraction.

### P1.3 OpenCode Installer Compatibility Boundary

Recommendation: keep/simplify.

Decision: keep the CLI installer as a compatibility bridge, but do not expand it into a second runtime configuration system.

Evidence:

- `src/cli/index.ts` only supports install/default install plus help flags.
- `src/cli/install.ts` adds the package to OpenCode config, disables default agents, enables LSP, writes the lite config, and installs skills.
- `src/cli/config-io.ts` detects package plugin entries by package name, npm version specifier, file URL, or local package root.
- `src/index.ts` is a warning-only legacy OpenCode adapter placeholder.
- `package.json` still ships `src/cli`, `src/config`, `src/adapters`, and `dist`, so CLI behavior remains part of the package contract.

Cost: low.

Benefit: medium. Keeps installation path stable while avoiding legacy adapter revival.

Risk: medium. OpenCode config format or plugin entry conventions may evolve; installer mutation is user-facing.

Validation:

- CLI config I/O tests for `.json`, `.jsonc`, empty config, plugin replacement, local dev entry, and package-manager entry.
- `bun test` for CLI tests if present; otherwise add targeted tests adjacent to `src/cli/config-io.ts` when touched.
- Manual dry run: `bun run src/cli/index.ts install --dry-run --no-tui --skills=no`.

Executable tasks:

1. Document that CLI install is an OpenCode compatibility installer, not the maintained runtime.
2. Keep `src/index.ts` warning-only unless a product decision restores OpenCode runtime support.
3. Avoid adding more provider-specific installer branches unless required by current OpenCode config format.

### P1.4 Adapter Runtime Config Duplication

Recommendation: simplify.

Decision: keep `src/adapters/agent-runtime-config.ts` as the runtime agent definition boundary, but reduce duplicated path/parsing/precedence logic around it.

Evidence:

- `src/adapters/agent-runtime-config.ts` reads Pi-native config from `~/.pi/agent/pi-shiki-subagents.json`, reads shared config through `loadPluginConfig`, merges defaults, normalizes model entries, and exposes delegation rules.
- `src/cli/paths.ts` separately defines OpenCode search locations and lite config paths.
- `src/config/loader.ts` has its own `getConfigSearchDirs()` with equivalent OpenCode search semantics.
- `src/adapters/pi.test.ts` already asserts shared OpenCode search paths and Pi adapter config behavior.

Cost: medium.

Benefit: medium to high. Fewer duplicated config paths and fewer chances that CLI, shared loader, and adapter runtime drift.

Risk: medium. Path changes can affect real user configs and test isolation.

Validation:

- Tests that `OPENCODE_CONFIG_DIR` beats XDG/default path for all config readers that claim OpenCode compatibility.
- Tests for duplicate path removal.
- Runtime agent definition tests.
- `bun run typecheck`.

Executable tasks:

1. Choose one owner for OpenCode config search dirs.
2. Make CLI and shared loader either share it or document why they intentionally diverge.
3. Keep Pi-native `~/.pi/agent` path separate because it is a Pi runtime fallback source, not an OpenCode config source.

## P2 Findings

### P2.1 Schema Surface Breadth

Recommendation: defer/simplify when touched.

Decision: keep the current schema breadth, but do not add new top-level config keys without owner and runtime evidence.

Evidence:

- `src/config/schema.ts` includes agent overrides, presets, disabled agents/MCPs, workflows, fallback, harness, council, interview/session/todo continuation, and vision model config.
- The schema is strict for nested agent/harness objects but broad at the product level.
- `package.json` generates `pi-shiki-subagents.schema.json` during build.

Cost: medium to prune because each field may be user-facing.

Benefit: low to medium unless a field is proven dormant.

Risk: high if removing or renaming public config keys without migration.

Validation:

- `bun run generate-schema` after schema edits.
- Config loader tests for every changed field.
- Documentation grep for changed key names.

Executable tasks:

1. Classify schema keys by active runtime owner before deletion.
2. Mark legacy or experimental keys in docs before removing them.
3. Avoid schema-only cleanup unless bundled with the owning runtime change.

### P2.2 Test-Only Config Helpers

Recommendation: classify before deleting.

Decision: keep until public/API exposure and runtime references are classified.

Candidates:

- MCP list helpers: `getAgentMcpList`, `getAvailableMcpNames`, `parseList`, `DEFAULT_AGENT_MCPS`.
- Runtime preset state helpers: `setActiveRuntimePreset`, `getActiveRuntimePreset`, `setActiveRuntimePresetWithPrevious`, `getPreviousRuntimePreset`, `rollbackRuntimePreset`.

Evidence:

- The baseline scan flags `src/config/agent-mcps.ts` and `src/config/runtime-preset.ts` as possible test-only or dormant modules requiring classification.
- `src/config/agent-mcps.ts` imports from the public config barrel and exports helpers that could be deep-imported because `package.json` ships `src/config`.
- `src/config/runtime-preset.ts` stores module-level runtime state and may exist for plugin reload behavior.

Cost: low for classification; low to medium for deletion if truly unused.

Benefit: low to medium. Removes stale API surface only if no runtime/public exposure exists.

Risk: medium. Deep imports are possible because source directories are packaged.

Validation:

- Reference scan across `src`, `docs`, `README.md`, package metadata, and generated declaration output.
- If deletion proceeds: `bun run typecheck`, `bun test`, `bun run build`.
- If kept: add doc comment or test naming the runtime owner.

Executable tasks:

1. Classify each helper as runtime-owned, public/deep-import risk, or deletable.
2. For runtime-owned helpers, add an owner note and targeted test if missing.
3. For deletable helpers, remove only after declaration/package exposure is checked.

### P2.3 Package/API Exposure

Recommendation: keep/defer.

Decision: keep current package contents until a dedicated public API/export audit decides whether source deep imports are supported.

Evidence:

- `package.json` has no explicit `exports` map.
- Historical note: this originally listed `src/core` and `src/skills` as packaged source paths.
- Current state: `files` includes `dist`, `src/pi`, `src/adapters`, `src/config`, `src/cli`, schema, and README; `src/core` and `src/skills` are no longer package contents.
- `main` and `types` point to `dist/index.*`, while source directories are still packaged.
- `src/index.ts` re-exports selected config types and keeps a legacy default export placeholder.

Cost: medium.

Benefit: medium. Clarifies whether package consumers may deep-import source helpers.

Risk: medium to high. Adding an `exports` map or removing shipped source paths can break consumers.

Validation:

- Release artifact verification: `bun run verify:release`.
- Build and declaration output inspection.
- README/package docs check for import examples.

Executable tasks:

1. Decide whether source deep imports are public API, compatibility-only, or accidental.
2. If accidental, plan a semver-aware package `exports` and `files` cleanup separately.
3. Do not delete dormant source files solely from internal reference scans while source dirs remain packaged.

### P2.4 Adapter Duplication Beyond Config

Recommendation: defer.

Decision: do not split or delete adapter code now; only simplify duplication when touching its owning capability.

Evidence:

- `src/adapters/agent-runtime-config.ts` is actively tested and acts as a shared definition layer.
- `src/adapters/agents-default.json` is the default capability registry for modes/subagents/tool groups.
- `src/adapters/pi.test.ts` is large and covers Pi adapter sync, config helpers, council, meeting, and presets, but large tests are not production complexity by themselves.

Cost: medium.

Benefit: low to medium until a specific adapter behavior changes.

Risk: medium. Premature splitting can disturb test fixtures and central config assumptions.

Validation:

- Keep existing adapter tests as baseline.
- When a behavior is touched, extract only the relevant test block into a narrower file.
- `bun run typecheck`.

Executable tasks:

1. Leave adapter tests unsplit unless related behavior is modified.
2. If modifying runtime config, add focused tests in `src/adapters/agent-runtime-config.test.ts` first.
3. Keep `agents-default.json` as the capability registry until tool expansion is centralized.

## Suggested Execution Order

1. P0.2 default-agent path resolution.
2. P0.3 tool group expansion parity.
3. P0.1 docs/package extension consistency.
4. P1.1 config precedence matrix documentation/tests.
5. P1.2 JSONC parser duplication decision.
6. P1.4 config path ownership cleanup.
7. P1.3 installer compatibility documentation/tests.
8. P2.2 test-only helper classification.
9. P2.3 package/API exposure audit.
10. P2.1/P2.4 defer until owning capabilities are touched.

## Validation Baseline

Before implementation patches derived from this plan:

```sh
node docs/pi-shiki-subagents/plans/whole-module-complexity-audit/scan.mjs .
bun run typecheck
bun test
git diff --check
```

For narrower follow-up patches, start with the targeted test named in each finding, then typecheck.
