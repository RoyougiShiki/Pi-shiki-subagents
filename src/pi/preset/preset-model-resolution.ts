import {
  BUILT_IN_ROLE_SUBAGENT_NAMES,
  PRIMARY_AGENT_NAME,
} from '../../config/constants';

export type PresetModelPack = Record<string, string | undefined>;

export type PresetModelConfig = {
  preset?: string;
  presets?: Record<string, PresetModelPack | undefined>;
};

export type AvailableModelRef = {
  provider: string;
  id: string;
};

export function parseModelRef(
  modelId: string | undefined,
): { provider: string; model: string } | undefined {
  if (!modelId) return undefined;
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

export function formatModelRef(model: {
  provider?: string;
  id?: string;
} | null | undefined): string | undefined {
  if (!model?.provider || !model?.id) return undefined;
  return `${model.provider}/${model.id}`;
}

export function getActivePresetName(
  config: PresetModelConfig | null | undefined,
  fallback = 'default',
): string {
  const name = config?.preset?.trim();
  return name || fallback;
}

export function getPresetPack(
  config: PresetModelConfig | null | undefined,
  presetName?: string,
): PresetModelPack {
  const name = presetName ?? getActivePresetName(config);
  const pack = config?.presets?.[name];
  return pack && typeof pack === 'object' ? pack : {};
}

export function listPresetNames(
  config: PresetModelConfig | null | undefined,
): string[] {
  return Object.keys(config?.presets ?? {});
}

export function getPresetSlotModel(
  pack: PresetModelPack,
  slot: string,
): string | undefined {
  const value = pack[slot];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the model id a role subagent should use.
 *
 * Order:
 * 1. explicit call model
 * 2. role override on active preset
 * 3. subagent default on active preset
 * 4. current main model
 */
export function resolveRoleSubagentModelId(input: {
  role: string;
  explicitModel?: string;
  pack?: PresetModelPack;
  mainModelId?: string;
}): {
  modelId?: string;
  source:
    | 'explicit'
    | 'role'
    | 'subagent'
    | 'main'
    | 'none';
} {
  const explicit = input.explicitModel?.trim();
  if (explicit) return { modelId: explicit, source: 'explicit' };

  const pack = input.pack ?? {};
  if (input.role && input.role !== PRIMARY_AGENT_NAME) {
    const roleModel = getPresetSlotModel(pack, input.role);
    if (roleModel) return { modelId: roleModel, source: 'role' };
  }

  const subagent = getPresetSlotModel(pack, 'subagent');
  if (subagent) return { modelId: subagent, source: 'subagent' };

  const mainModelId = input.mainModelId?.trim();
  if (mainModelId) return { modelId: mainModelId, source: 'main' };

  return { modelId: undefined, source: 'none' };
}

export function isModelAvailable(
  modelId: string | undefined,
  available: readonly AvailableModelRef[],
): boolean {
  const parsed = parseModelRef(modelId);
  if (!parsed) return false;
  return available.some(
    (model) => model.provider === parsed.provider && model.id === parsed.model,
  );
}

export function findStalePresetSlots(
  pack: PresetModelPack,
  available: readonly AvailableModelRef[],
): Array<{ slot: string; modelId: string }> {
  const stale: Array<{ slot: string; modelId: string }> = [];
  for (const [slot, modelId] of Object.entries(pack)) {
    if (typeof modelId !== 'string' || !modelId.trim()) continue;
    if (!isModelAvailable(modelId, available)) {
      stale.push({ slot, modelId: modelId.trim() });
    }
  }
  return stale;
}

export function summarizePresetPack(pack: PresetModelPack): string {
  const subagent = getPresetSlotModel(pack, 'subagent');
  const roleBits = BUILT_IN_ROLE_SUBAGENT_NAMES.map((role) => {
    const model = getPresetSlotModel(pack, role);
    return model ? `${role}=${model}` : undefined;
  }).filter((bit): bit is string => Boolean(bit));

  if (!subagent && roleBits.length === 0) return '跟随主模型';
  const parts: string[] = [];
  if (subagent) parts.push(`subagent=${subagent}`);
  parts.push(...roleBits);
  return parts.join(', ');
}

export function setPresetSlot(
  pack: PresetModelPack,
  slot: string,
  modelId: string | undefined,
): PresetModelPack {
  const next: PresetModelPack = { ...pack };
  if (!modelId || !modelId.trim()) {
    delete next[slot];
  } else {
    next[slot] = modelId.trim();
  }
  return next;
}
