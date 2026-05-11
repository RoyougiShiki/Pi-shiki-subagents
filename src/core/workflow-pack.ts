/**
 * WorkflowPack — a container for workflow templates, gate instructions,
 * and reference documentation that can optionally enhance OMO's built-in
 * defaults.
 *
 * Packs live in src/packs/<name>/ and are loaded by ID when the user
 * includes the name in the "workflowPacks" config array.
 *
 * Merge semantics: later packs override earlier ones.  Missing fields
 * fall through to the default pack.
 */

// ── Single-gate overrides ──────────────────────────────────────────

export interface GatePack {
  instruction: string;
  blockMessage: string;
}

// ── Orchestrator-prompt injection points ───────────────────────────

export interface OrchestratorPack {
  /** Lines appended to the <Workflow> section of the orchestrator prompt. */
  workflowAdditions?: string;
  /** Lines appended to the <Communication> section. */
  communicationAdditions?: string;
  /** Lines appended to the <Constraints> section. */
  constraintAdditions?: string;
}

// ── Full pack definition ───────────────────────────────────────────

export interface WorkflowPack {
  id: string;
  title: string;
  description: string;
  gates?: {
    clarify?: GatePack;
    intent?: GatePack;
    approval?: GatePack;
    orchestration?: GatePack;
  };
  orchestrator?: OrchestratorPack;
}

// ── Built-in default pack (no external pack loaded) ────────────────

export const DEFAULT_WORKFLOW_PACK: WorkflowPack = {
  id: 'builtin',
  title: 'Built-in Default',
  description: 'OMO built-in workflow templates (no external pack)',
};

// ── Pack registry ──────────────────────────────────────────────────

const PACK_REGISTRY = new Map<string, () => WorkflowPack>();

/**
 * Register a pack constructor at startup.
 * Packs are lazy — the constructor runs only when the pack is first
 * requested.
 */
export function registerPack(id: string, factory: () => WorkflowPack): void {
  PACK_REGISTRY.set(id, factory);
}

/**
 * Load a single pack by ID.  Returns null for unknown IDs.
 */
export function loadPack(id: string): WorkflowPack | null {
  const factory = PACK_REGISTRY.get(id);
  if (!factory) return null;
  return factory();
}

/**
 * Load an ordered list of packs and merge them.
 *
 * Merge rules:
 *   1. Start with DEFAULT_WORKFLOW_PACK.
 *   2. For each resolved non-null pack, shallow-merge every section:
 *      gates, orchestrator, workflows.
 *   3. The last pack wins on conflicts.
 */
/**
 * Build a merged WorkflowPack from the config's workflowPacks array.
 * Convenience wrapper that skips the knownPacks parameter.
 */
export function buildMergedPack(ids: string[] | undefined): WorkflowPack {
  return loadAndMergePacks(ids ?? []);
}

export function loadAndMergePacks(
  ids: string[],
  knownPacks?: Map<string, WorkflowPack>,
): WorkflowPack {
  let merged: WorkflowPack = { ...DEFAULT_WORKFLOW_PACK };

  for (const id of ids) {
    const pack = knownPacks?.get(id) ?? loadPack(id);
    if (!pack) continue;

    // Start with a fresh copy of the pack (shallow fields).
    const base: WorkflowPack = { ...merged };

    // Merge gates
    if (pack.gates) {
      base.gates ??= {};
      for (const key of Object.keys(pack.gates) as Array<
        keyof NonNullable<WorkflowPack['gates']>
      >) {
        const override = pack.gates[key];
        if (override) {
          base.gates[key] = override;
        }
      }
    }

    // Merge orchestrator
    if (pack.orchestrator) {
      base.orchestrator ??= {};
      Object.assign(base.orchestrator, pack.orchestrator);
    }

    merged = base;
  }

  return merged;
}

// ── Auto-register known packs ─────────────────────────────────────

// Lazy-import known packs here to avoid circular deps at module level.
// The functions below are called only when the corresponding pack ID
// is requested.

registerPack('superpowers', () => {
  // Dynamic require to keep superpowers dependency optional at compile time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createSuperpowersPack } = require('../packs/superpowers');
  try {
    return createSuperpowersPack();
  } catch {
    return DEFAULT_WORKFLOW_PACK;
  }
});
