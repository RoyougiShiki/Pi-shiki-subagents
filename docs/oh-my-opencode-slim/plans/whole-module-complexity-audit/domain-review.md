# Whole-Module Complexity Audit — Domain Review

Status: read-only domain review for the confirmed whole-module complexity audit plan.

Scope of this review:

- docs and package metadata alignment;
- public entrypoint and deep-import exposure before deletion recommendations;
- stale plan content that can mislead future cleanup;
- final-report structure by capability name, not code-first module lists.

Baseline evidence:

- `docs/oh-my-opencode-slim/plans/whole-module-complexity-audit/README.md`
- `docs/oh-my-opencode-slim/plans/whole-module-complexity-audit/scan.mjs`
- spot checks of `README.md`, `package.json`, `src/index.ts`, `tsconfig.json`, selected `dist/**/*.d.ts`, and `docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md`.

No implementation is included in this review.

## P0 Findings

### P0.1 Pi extension declaration alignment

Decision: **simplify**.

Capability: package-declared Pi runtime loading.

Finding:

- `package.json` declares one Pi extension: `./src/pi/core/pi.ts`.
- `README.md` still documents two Pi extensions: `./src/pi/core/pi.ts` and `./src/pi/core/pi-modes.ts`.
- The stale two-extension example can cause duplicate/manual loading confusion and undermines package metadata as the source of truth.

Cost: small.

Benefit: medium. Keeps install guidance aligned with actual runtime metadata and reduces user error.

Risk: low. Documentation-only if `package.json` remains authoritative.

Validation:

- Grep docs for `pi.extensions`, `./src/pi/core/pi-modes.ts`, and duplicated extension examples.
- Confirm README states that package metadata is authoritative.
- Smoke-load the extension using the package-declared `pi.extensions` entry.

### P0.2 Legacy platform cleanup plan freshness

Decision: **simplify**.

Capability: cleanup-plan guidance for the legacy OpenCode adapter boundary.

Finding:

- `docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md` still says the design is not implemented.
- It says `src/index.ts` exports the old OpenCode adapter, but current `src/index.ts` is a warning-only compatibility placeholder.
- It still documents two Pi extensions, while current `package.json` has only `./src/pi/core/pi.ts`.
- It lists old deletion candidates and risk framing that are now partially historical.

Cost: small.

Benefit: medium to high. Prevents future work from reintroducing stale OpenCode assumptions.

Risk: low. Main risk is losing historical rationale; keep it by marking the plan historical/stale instead of silently deleting it.

Validation:

- Add a status banner such as `Historical/stale: do not execute as-is` or update the plan to current package state.
- Grep for stale references to `src/opencode`, old adapter entrypoint wording, and the two-extension Pi example.
- Confirm the current README points to the historical plan only as rationale, not as executable cleanup instructions.

### P0.3 Public/deep-import exposure gate before deletion

Decision: **defer deletion; simplify policy first**.

Capability: package public surface and deletion safety.

Finding:

- `package.json` has no `exports` field that restricts package subpaths.
- `package.json.files` ships `src/pi`, `src/adapters`, `src/core`, `src/config`, `src/cli`, and `src/skills`, plus `dist`.
- `tsconfig.json` emits declarations for all included source files under `dist`, excluding tests.
- Selected generated declarations exist for deep-importable modules such as `dist/pi/subagent/pi-chat-bridge.d.ts`, `dist/config/agent-mcps.d.ts`, and `dist/config/runtime-preset.d.ts`.
- Therefore, files that have no internal production importer may still be externally reachable by source or declaration deep imports.

Cost: small to medium.

Benefit: high. Prevents accidental breaking changes when deleting dormant modules.

Risk: medium. Introducing an `exports` policy or deleting shipped files is package-facing and may break undocumented consumers.

Validation:

- Before deleting any dormant shipped file, check package metadata, README/docs, examples, generated declarations, and published package contents.
- Decide whether the package intentionally supports deep imports.
- If deep imports are not supported, document that policy and consider an explicit `exports` map in a separate package-surface change.
- If deep imports are supported, classify each deletion as a breaking API change.
- Run release artifact verification after any package-surface change.

## P1 Findings

### P1.1 Dormant chat overlay capability

Decision: **delete or explicitly defer after exposure check**.

Capability: terminal chat overlay / private-group chat UI.

Finding:

- The chat bridge exports `runPrivateChat`, `runGroupChat`, and `autoOpenChat`.
- It imports Pi TUI, Pi coding-agent UI types, chat status view, and meeting hub state.
- The baseline scan reports no production importer, but generated declarations expose the functions under `dist/pi/subagent/pi-chat-bridge.d.ts` and package files ship `src/pi`.
- This capability is misaligned with the audit non-goals: terminal UI should remain compact and rich detail/chat surfaces are deferred.

Cost: low to medium.

Benefit: medium. Removing or quarantining it reduces dormant UI complexity and prevents accidental terminal-detail expansion.

Risk: medium. It may be an undocumented deep import or manual integration point because the package ships source and declarations.

Validation:

- Run a final internal reference scan for `pi-chat-bridge`, `runPrivateChat`, `runGroupChat`, and `autoOpenChat`.
- Check docs, README, examples, package metadata, `dist/**/*.d.ts`, and published artifact layout.
- If unexposed by policy, delete source plus generated declaration through normal build output and remove stale docs.
- If exposure is possible or intentionally supported, keep it but mark the capability dormant/experimental and keep it out of active terminal flows.
- Run `bun run typecheck`, targeted subagent/meeting tests, and release artifact verification.

### P1.2 Package source shipping policy

Decision: **simplify, but do not combine with deletion work**.

Capability: npm artifact shape and source-vs-build contract.

Finding:

- Current package contents intentionally include both source trees and `dist`.
- This supports Pi loading TypeScript source via `pi.extensions`, but also widens the deep-import surface.
- The README says the npm package is expected to include broad source trees, which makes deletion candidates more package-visible than ordinary private implementation files.

Cost: medium.

Benefit: high. A clear package-surface policy makes future cleanup safer and reduces repeated deletion uncertainty.

Risk: medium. Tightening package files or adding `exports` may break consumers; loosening policy preserves complexity.

Validation:

- Decide one of two policies:
  1. source-shipping is part of the public contract; deletions require semver/API review; or
  2. only documented entrypoints are public; add docs and package metadata to enforce/communicate that.
- Keep this policy change separate from code deletion patches.
- Verify `npm pack`/release artifact contents and Pi extension loading after policy changes.

### P1.3 Public compatibility entrypoint

Decision: **keep for now; simplify wording**.

Capability: npm `main` import compatibility.

Finding:

- `package.json.main` points at `dist/index.js` and `types` points at `dist/index.d.ts`.
- Current `src/index.ts` exports config types and a default warning-only placeholder, not the old OpenCode adapter.
- The placeholder is useful compatibility glue while Pi extensions are the maintained runtime.
- Stale docs that still describe `src/index.ts` as exporting old OpenCode code should be corrected.

Cost: small.

Benefit: medium. Preserves importability while clarifying that runtime loading happens through Pi extensions.

Risk: low to medium. Removing the main entrypoint would be more breaking than keeping the warning placeholder.

Validation:

- Keep `src/index.ts` importable unless a separate package-major/API decision removes it.
- Ensure docs call it a compatibility placeholder, not an active adapter.
- Verify `dist/index.d.ts` exposes only intended top-level types and placeholder default.

### P1.4 Final report structure

Decision: **simplify report format**.

Capability: audit communication and execution handoff.

Finding:

- The baseline README explicitly requires final user-facing reports to be grouped by capability/function name, with paths only in evidence/appendix sections.
- Some existing findings are path-first because the scan is code-oriented.
- A capability-first report will better support keep/delete/simplify/defer decisions and prevent maintainers from deleting by file name before classifying user-visible capability.

Cost: small.

Benefit: medium. Improves execution safety and review clarity.

Risk: low.

Validation:

- Use headings such as `Pi extension declaration`, `Legacy platform cleanup guidance`, `Package source shipping`, `Dormant chat overlay`, `Subagent tool boundary`, and `Meeting/council registration boundary`.
- Put source paths in evidence bullets only.
- For every deletion recommendation, include an exposure gate and validation checklist.

## P2 Findings

### P2.1 Shared config/runtime helper classification

Decision: **defer deletion; classify first**.

Capability: shared config/runtime helper surface.

Finding:

- `agent-mcps` and `runtime-preset` are lightweight modules but produce declarations under `dist/config`.
- `src/config/index.ts` does not re-export them, so they are not top-level public API through `dist/index.d.ts`.
- Because package files ship `src/config` and declarations exist under `dist/config`, they may still be deep-importable.

Cost: low.

Benefit: low to medium. Cleanup may reduce stale config surface, but these modules are not the dominant complexity source.

Risk: medium if deleted without confirming deep-import or internal runtime use.

Validation:

- Classify references as production, test, docs, generated declarations, or external/public exposure.
- If kept, document whether they are internal helpers.
- If removed, verify typecheck, config tests, generated declarations, and release artifact contents.

### P2.2 Historical README/package wording

Decision: **simplify when docs are touched**.

Capability: project positioning and metadata description.

Finding:

- `package.json.description` and keywords still include OpenCode-oriented terms.
- README correctly says the maintained runtime is Pi, while also preserving legacy cleanup rationale.
- This is not a blocker, but wording should avoid implying that a removed OpenCode adapter is still the maintained runtime.

Cost: small.

Benefit: low to medium. Reduces user confusion.

Risk: low. Metadata changes can affect package discoverability, so do not overcorrect without release intent.

Validation:

- Keep the package name/history clear.
- State that Pi is the maintained runtime and OpenCode adapter code is legacy/removed.
- Avoid describing the project as Pi-only if shared layers are intentionally retained.

## Recommended execution order

1. P0.1: align README Pi extension example with `package.json`.
2. P0.2: mark/update the platform-adapter cleanup proposal as historical/stale.
3. P0.3/P1.2: decide and document package public/deep-import policy before any deletion.
4. P1.1: classify dormant chat overlay exposure; then delete or explicitly defer/mark dormant.
5. P1.3: keep the compatibility `main` placeholder unless a separate API/package-major decision removes it.
6. P2.1: classify shared config/runtime helpers only after package-surface policy is clear.
7. P1.4: format the final audit report by capability name, using paths only as evidence.

## Minimum validation bundle for follow-up changes

For documentation-only fixes:

```sh
grep -R "pi.extensions\|pi-modes.ts\|src/opencode\|旧 OpenCode" README.md docs package.json
git diff --check
```

For package-surface or deletion changes:

```sh
bun run typecheck
bun test
bun run build
bun run verify:release
git diff --check
```

Add targeted reference scans for any deleted capability names before deletion.
