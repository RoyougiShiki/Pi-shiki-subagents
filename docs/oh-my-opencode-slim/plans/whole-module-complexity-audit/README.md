# Whole-Module Lightweight Complexity Audit

## Status

Draft for oracle review. This audit intentionally covers the whole extension, not only the harness/subagent area. It is a lightweight complexity review: recommendations prefer deletion, simplification, and boundary clarification over new abstractions or feature expansion.

Reporting rule: final user-facing audit reports should be grouped by capability/function name; code paths belong in evidence/appendix sections only.

Out of scope for this audit:

- Tauri desktop design.
- Full subagent detail panels.
- Transcript/dashboard/persistence expansion.
- Large rewrites or dependency additions.

## Audit Scope

Included areas:

- `src/adapters/**`
- `src/cli/**`
- `src/config/**`
- `src/core/**`
- `src/pi/**` including core, meeting, subagent, harness, policy, preset, agents, and prompt modules
- `src/policy/**`
- tests under the same module trees
- relevant docs/plans, `README.md`, and package metadata

Excluded areas:

- `node_modules`, `.git`, `dist`, `coverage`, and `.codebase-memory`.
- Deep behavioral validation of every CLI command; CLI was reviewed for coupling and stale OpenCode compatibility risk only.
- External package dependency removal; dependency pruning is deferred until a dedicated import/build audit.

Coverage notes:

- `src/adapters/**`: no P0 was found; notable concern is shared path/config helper reuse and possible duplication with CLI/config paths.
- `src/cli/**`: no P0 was found; main concern is legacy/OpenCode compatibility framing, not immediate deletion.
- `src/config/**`: no P0 was found; concerns are compatibility schema breadth and possibly test-only helpers that need classification before deletion.
- `src/pi/policy/**` and `src/policy/**`: no P0 was found in the lightweight scan; revisit policy only if workflow/tool-gate behavior changes.
- `src/pi/subagent/**`: P0 findings were found for tool resolution consistency and default agent path handling.
- `src/pi/core/**` and `src/pi/meeting/**`: no immediate P0 blocker was proven, but confirmed static coupling and possible import cycles make them P1 simplification targets.
- `src/pi/harness/**`: warning optimization is already stabilized; remaining concern is preserving a tool-agnostic evidence contract.
- Pure subagent state/view/detail modules: no hard SDK/UI boundary violations were found in the static scan.
## Architecture Constraints

- Runtime/pool modules must not import or call terminal TUI adapters.
- Pure state/view/details modules must not import Pi SDK, Pi TUI, `ctx.ui`, `setWidget`, `renderCall`, or `renderResult`.
- Harness logic should depend on generic evidence contracts, not specific third-party tool names.
- Terminal TUI stays compact; rich detail views are deferred.
- Prefer bounded state and explicit ownership for globals/persistence.

## Evidence Collected

Local static scan summary:

- TypeScript files under `src/`: 153, from `scan.mjs`.
- Approximate TypeScript LOC under `src/`: 29k.
- Largest files:
  - `src/pi/core/pi.ts`: 1965 lines, highest fan-out.
  - `src/pi/subagent/subagent-pool.ts`: 891 lines.
  - `src/pi/core/pi-modes.ts`: 743 lines.
  - `src/pi/meeting/pi-meeting.ts`: 716 lines.
  - `src/pi/harness/register-harness-hooks.ts`: ~421 lines.
  - `src/pi/harness/evidence-adapter.ts`: ~324 lines.
- High fan-out:
  - `src/pi/core/pi.ts`: 26 local outgoing imports.
  - `src/pi/harness/register-harness-hooks.ts`: 10 local outgoing imports.
  - `src/pi/subagent/subagent-tool.ts`: 8 local outgoing imports.
- Potential import cycles:
  - `src/pi/core/pi.ts` ↔ `src/pi/meeting/pi-meeting.ts`.
  - `src/pi/core/pi.ts` ↔ `src/pi/meeting/pi-council.ts`.
  - `src/pi/meeting/pi-meeting.ts` ↔ `src/pi/meeting/pi-meeting-pool.ts`.
- Boundary scan did not find hard violations in the selected pure subagent state/view/details modules checked by `scan.mjs`.
- Some files currently have no production importers or only test/doc references and need classification before deletion.

Reproducibility/provenance:

- Authoritative provenance for the local static scan is the checked-in script plus command: `docs/oh-my-opencode-slim/plans/whole-module-complexity-audit/scan.mjs`.
- Run it from the repository root with:

```sh
node docs/oh-my-opencode-slim/plans/whole-module-complexity-audit/scan.mjs .
```

- For source metrics/import graph/boundary checks, the script walks `src/**`. Exact excluded directories: node_modules, .git, dist, coverage, .codebase-memory.
- Reference scan walks repository-root `*.ts`, `*.tsx`, `*.js`, `*.json`, and `*.md` files.
- It reports LOC/largest files, fan-in/fan-out, static import cycles, boundary findings, selected raw reference matches, and docs/package findings.
- Reference/dead-code scan output is raw matching file paths only. It does not classify matches as production/test/docs/API exposure; any deletion candidate still requires a focused classification step before action.
- It is intentionally lightweight and should be treated as audit evidence, not a compiler-grade dependency graph.

Subagent review status:

- `whole-module-architecture-review` and `whole-module-architecture-review-2` produced no usable report content; designer subagent evidence is unavailable/unsupported and is not used for final decisions.
- `whole-module-complexity-analyst` produced useful leads, but its transcript/report is not checked in as reproducible evidence. Final audit findings should rely on the checked-in scan script plus locally verifiable source/package/doc spot checks.

## P0 Findings

### P0.1 Fix subagent tool resolution consistency

Recommendation: simplify/fix.

Rationale:

- The mode path in `src/pi/core/pi-modes.ts` expands tool expressions such as `*`, `@group`, wildcards, and role groups.
- The subagent pool path in `src/pi/subagent/subagent-pool.ts` reads role groups but appears to return raw group entries without the same resolver semantics.
- If default role groups contain nested group references such as `@子代理`, subagent sessions may receive invalid or incomplete tool allowlists.

Cost: medium.

Benefit: high. Makes mode and subagent tool boundaries consistent and reduces hidden permission drift.

Risk: medium. This changes effective subagent tool scopes; must be tested against default agents and common roles.

Validation:

- Define and share one resolver semantics for mode and subagent tool allowlists, or explicitly document and test the current one-level behavior if compatibility requires it.
- Add/verify tests for role/tool expansion for `dispatcher`, `designer`, `fixer`, and `search`, including `roles: ["管理"]` and `tools: ["@管理"]`.
- Verify nested `@group` and wildcard handling as recursive expansion, bounded-depth expansion, or compatible current one-level expansion.
- `bun run typecheck`.
- Spawn smoke for at least one subagent role.

### P0.2 Fix or share subagent default agents path resolution

Recommendation: simplify/fix.

Rationale:

- `src/pi/subagent/subagent-pool.ts` builds its default agents path with `path.join(__dirname, '..', 'adapters', 'agents-default.json')`.
- Other modules use shared/default path helpers such as `getDefaultAgentsPath()` from `src/adapters/agent-runtime-config.ts`, which points at `src/adapters/agents-default.json`.
- Depending on runtime `__dirname`, the subagent path can resolve to the wrong location, e.g. `src/pi/adapters/...`, and silently miss default `_tool_groups`.

Cost: small.

Benefit: high. Avoids stale/missing default agent and tool-group data in subagent runtime.

Risk: low. Prefer using the existing shared path helper rather than introducing a new path convention.

Validation:

- Unit test that subagent default tool groups load from `src/adapters/agents-default.json`.
- Existing subagent pool tests.
- `bun run typecheck`.

## P1 Findings

### P1.1 Split `src/pi/core/pi.ts` by registration boundary

Recommendation: simplify.

Rationale:

- `src/pi/core/pi.ts` is the largest production file and highest fan-out module.
- It imports Pi SDK/TUI, policy, meeting, subagent, harness, config, prompts, agents, and preset code.
- It participates in confirmed static/type coupling or cycle-like import graph relationships with meeting modules; no runtime/value initialization cycle has been proven in this audit.
- It is now an integration hub rather than a single-responsibility module.

Low-risk simplification path:

1. Extract tool registration groups only where there is already a clear module owner.
2. Keep runtime behavior unchanged.
3. Avoid new registries/frameworks.
4. Prefer files such as `registerMeetingTools`, `registerCoreTools`, or moving meeting-specific registration closer to `src/pi/meeting` if that breaks cycles.

Cost: medium.

Benefit: high. Reduces change risk for future harness/subagent/meeting work and makes boundary violations easier to spot.

Risk: medium. `pi.ts` is central; extraction can accidentally change registration order or tool metadata.

Validation:

- Existing adapter/core tests.
- `bun run typecheck`.
- Smoke test for extension load and key tool registration.

### P1.2 Reduce Pi core ↔ meeting static coupling

Recommendation: simplify.

Rationale:

- Static import scanning found dependency cycles or cycle-like static coupling among `src/pi/core/pi.ts`, `src/pi/meeting/pi-meeting.ts`, `src/pi/meeting/pi-council.ts`, and `src/pi/meeting/pi-meeting-pool.ts`.
- This audit has not separately proven a runtime/value initialization cycle. Treat this as confirmed static/type coupling and a maintainability risk, not as confirmed reload/runtime fragility.
- The coupling still makes future extraction harder because meeting modules import core config/types while core imports meeting implementations.

Low-risk simplification path:

1. First classify whether each edge is type-only or value import.
2. Move shared meeting/core types into a small neutral module only if that removes real coupling.
3. Ensure meeting modules do not need to import the core registration hub.
4. Keep public behavior unchanged.

Cost: medium.

Benefit: medium to high. Improves module boundaries and makes future extraction safer.

Risk: medium. Type movement is usually safe, but import churn can be broad.

Validation:

- Import graph check before/after.
- Meeting/council tests if present.
- `bun run typecheck`.
- Manual smoke for `omo_council` / meeting backend if available.

### P1.3 Classify dormant private/group chat bridge exposure

Recommendation: classify/quarantine first; delete only after public/deep-import/declaration/package/docs exposure policy is decided.

Candidate:

- `src/pi/subagent/pi-chat-bridge.ts`

Rationale:

- Search found no top-level export and no active production importer for the private/group chat bridge capability, but the reference scan only reports raw matches and does not classify public/deep-import exposure, runtime text references, command/help references, or active meeting-backend contracts.
- Deep-import exposure is reachable because the package ships `src/pi`, has no `exports` map restricting subpaths, and generated `dist/pi/subagent/pi-chat-bridge.d.ts` declares `runPrivateChat`, `runGroupChat`, and `autoOpenChat`.
- The bridge imports Pi TUI and meeting hub code, which makes it a relatively expensive dormant feature surface while terminal TUI should stay compact and rich subagent detail is deferred.

Exposure policy gate:

- Do not delete solely because there are no internal production imports.
- Decide whether deep imports and generated declarations are supported API, accidental exposure, or quarantine-only compatibility surface.
- Check package metadata, README/docs, examples, generated declarations/build output, source-subpath behavior, runtime command/help/text references, and active meeting-backend contracts before deletion.
- Decide the `/chat` contract first. If `/chat` is not a supported command, rewrite returned user-facing text/comments so they do not imply an available command.
- If `/chat` or the bridge exposure is intentional or must remain compatible, keep it but mark it experimental/dormant, document the retained entry point, and keep it outside active terminal TUI flows.
- If exposure is accidental and the policy allows removal, delete only with declaration/package/docs/runtime-text cleanup.

Cost: low to medium.

Benefit: medium. Clarifies dormant UI surface ownership and prevents accidental terminal detail expansion.

Risk: medium. It may be an undocumented/manual entry point or deep-import/declaration surface; policy must be decided before deletion.

Validation:

- Internal reference scan.
- Public/deep-import exposure check across package metadata, docs, examples, generated declarations/build output, source-subpath behavior, runtime command/help/text references, and active meeting backend contracts.
- `bun run typecheck`.
- If deleted, declaration/package/docs cleanup and build.

### P1.4 Keep harness evidence adapter tool-agnostic

Recommendation: keep and simplify only via contract boundaries.

Rationale:

- Recent warning fixes moved toward generic evidence fields and explicit summaries.
- This direction should be preserved: harness should not add per-third-party-tool branches.

Stable contract:

- Direct command evidence may infer success from actual command success.
- Wrapper/non-direct runners should provide explicit summaries such as `tests: exit=0`, `typecheck: exit=1`, or `lint: exit=0`.
- Infra noise downgrades should apply only to explicit wait/sleep-only operations or explicit infra metadata.

Cost: low.

Benefit: high. Prevents maintenance growth as tools are added.

Risk: low. Main risk is losing convenience from weak heuristics; this is acceptable for reliability.

Validation:

- Evidence adapter tests.
- Harness audit tests.


### P1.5 Align JSONC/config parser behavior

Recommendation: add equivalence tests first, then share or freeze parser behavior.

Rationale:

- Locally verifiable implementation evidence shows parser divergence, not only raw grep output: the shared loader `src/config/loader.ts:90`, `:92`, and `:97` strips comments and trailing commas; the CLI parser `src/cli/config-io.ts:129`, `:131`, and `:137` does the same; the Pi-native path `src/pi/core/pi.ts:225` strips comments and `src/pi/core/pi.ts:304` passes that result to `JSON.parse`, with no visible trailing-comma removal in that path.
- `docs/configuration.md:14` promises JSONC comments and trailing commas, so users may see different behavior depending on config entry path.
- Config source precedence is spread across Pi native config, shared user/project config, runtime agent config, and CLI installer paths.

Low-risk simplification path:

1. Add parser equivalence tests for comments and trailing commas before changing implementation.
2. Centralize a tiny JSONC parser helper if behavior should be identical across Pi-native, shared loader, and CLI paths.
3. If compatibility requires differences, explicitly document unsupported differences rather than leaving them accidental.

Cost: small to medium.

Benefit: medium to high if users rely on `.jsonc` or shared/native config precedence.

Risk: medium because config compatibility is user-facing.

Validation:

- Equivalence tests for Pi `.jsonc`/`.json`, shared user/project config, CLI config parsing, comments, trailing commas, and env/preset interactions.
- `bun run generate-schema` if schema/docs are touched.


### P1.6 Defer meeting/council backend consolidation

Recommendation: defer; do not expand.

Rationale:

- Meeting/council modules have duplicate or experimental-looking backend paths and participate in confirmed static/type coupling or cycle-like import graph relationships with core.
- This area should be simplified only after the core/meeting cycle direction is clear.
- Transcript/debug options should remain off by default and not drive terminal UI expansion.

Cost: medium.

Benefit: medium.

Risk: medium to high due to user-visible council behavior.

Validation:

- Council/meeting targeted tests or smoke.
- `bun run typecheck`.

### P1.7 Correct package/README Pi extension mismatch

Recommendation: simplify docs/config.

Rationale:

- `README.md` shows `pi.extensions` with both `./src/pi/core/pi.ts` and `./src/pi/core/pi-modes.ts`.
- `package.json` currently lists only `./src/pi/core/pi.ts` under `pi.extensions`.
- The active runtime appears to register modes internally from `pi.ts`; docs should match the package to avoid duplicate extension loading or user confusion.

Cost: small.

Benefit: medium. Reduces install/reload confusion.

Risk: low.

Validation:

- Grep docs for `pi.extensions`.
- Confirm extension loads with package config.

### P1.8 Mark or update stale platform-adapter cleanup plan

Recommendation: simplify docs.

Rationale:

- `docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md` still states that `src/index.ts` exports old OpenCode adapter code and that `pi.extensions` includes `pi-modes.ts`.
- Current `src/index.ts` is already a lightweight warning-only placeholder, and package Pi extensions list only `pi.ts`.
- Keeping stale cleanup instructions increases the risk of reintroducing removed legacy OpenCode assumptions.

Cost: small.

Benefit: medium.

Risk: low.

Validation:

- Update or mark the plan historical/stale.
- Grep for stale `src/opencode`, old adapter entrypoint, and two-extension package examples.
## P2 Findings

### P2.1 Review test-only config/runtime modules

Recommendation: classify before deleting.

Candidates:

- `src/config/agent-mcps.ts`
- `src/config/runtime-preset.ts`

Rationale:

- Static scan returns raw matching file paths for these modules; each candidate requires focused classification before any deletion or API change.
- They may be remnants of earlier config/preset work or intended public helpers.

Cost: low.

Benefit: low to medium. Potentially removes stale config surface.

Risk: medium. Some helpers may be public API or indirectly used after build/config generation.

Validation:

- Confirm package exports and build output expectations.
- `bun run typecheck`.
- Config tests.

### P2.2 Split oversized tests only when touched

Recommendation: defer.

Candidates:

- `src/config/loader.test.ts`
- `src/adapters/pi.test.ts`
- `src/adapters/subagent-pool.test.ts`
- `src/pi/harness/evidence-adapter.test.ts`

Rationale:

- Large tests are not production complexity by themselves.
- Splitting for its own sake risks churn.

Cost: medium.

Benefit: low to medium.

Risk: low.

Decision:

- Do not split now.
- When behavior areas are touched, move related tests into narrower files.

Validation:

- Targeted tests for touched area.

### P2.3 Keep pure subagent state/view modules as-is

Recommendation: keep.

Rationale:

- Static boundary scan did not find Pi SDK/TUI imports in pure subagent state/view/detail/widget-line modules.
- The current architecture supports future Tauri consumption through semantic state without committing to a Tauri implementation now.

Cost: none.

Benefit: high. Preserves clean architecture boundary.

Risk: low. More modules exist, but they have clear roles and tests.

Validation:

- Boundary scan.
- Subagent state/view/widget tests.

### P2.4 Keep pool notice bridge but watch global state

Recommendation: keep with constraints.

Rationale:

- `src/pi/subagent/subagent-pool-notice-bridge.ts` uses `globalThis`/`Symbol.for` intentionally for reload-safe listener lifecycle.
- This is justified but should stay isolated.

Cost: none now.

Benefit: medium. Fixes reload/stale listener behavior.

Risk: medium if global patterns spread.

Constraint:

- Do not add more global bridge state without a specific reload-lifecycle bug and tests.

Validation:

- Pool notice bridge tests.

## Explicit Non-Goals

Do not do these as part of this audit:

- Add a dashboard.
- Add transcript storage.
- Add a Tauri API.
- Expand terminal subagent details.
- Replace current agent discovery/delegation/pool lifecycle.
- Add third-party-tool-specific harness branches.

## Suggested Execution Order

1. Finish audit review and oracle approval.
2. P0.2 fix: subagent default agents path should use the shared default agents path or equivalent tested path.
3. P0.1 fix/design: define and share one resolver semantics for subagent and mode tool expression expansion, with role/group tests before broader cleanup.
4. P1.3 decision: complete the runtime/package exposure gate for the dormant private/group chat bridge, including `/chat` contract, command/help/text references, and active meeting backend checks.
5. P1.5 parser equivalence: add tests first, then centralize a tiny JSONC parser helper or document unsupported differences; place this near docs/config cleanup and before large core/meeting extraction.
6. P1 docs/config cleanup: correct README/package extension mismatch and mark/update stale platform-adapter cleanup plan.
7. P1.2 design: break core/meeting cycles with a tiny neutral type module only after P1.3 and P1.5 reduce runtime/config uncertainty.
8. P1.1 design: extract only obvious registration groups from `src/pi/core/pi.ts` after cycle direction is clear.
9. P2.1 classify config/runtime test-only modules.
10. Defer P2.2 unless those tests are touched for functional changes.

## Validation Baseline

Before any follow-up simplification patch:

```sh
bun run typecheck
bun test
git diff --check
```

For narrower patches, start with targeted tests for the touched area, then typecheck and diff check.
