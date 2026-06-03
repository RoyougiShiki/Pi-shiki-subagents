export interface PresetSwitchConfig {
  presets?: Record<string, Record<string, { model?: string; thinking?: string } | unknown> | undefined>;
}

export function getPresetModelForOrchestrator(
  config: PresetSwitchConfig | null,
  presetName: string,
): string | undefined {
  const preset = config?.presets?.[presetName];
  const override = preset?.orchestrator as { model?: string } | undefined;
  return override?.model;
}

function getPresetThinkingForOrchestrator(
  config: PresetSwitchConfig | null,
  presetName: string,
): string | undefined {
  const preset = config?.presets?.[presetName];
  const override = preset?.orchestrator as { thinking?: string } | undefined;
  return override?.thinking;
}

export function parsePiModelId(modelId: string): { provider: string; model: string } | undefined {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

export function resolvePresetSwitchPlan(
  config: PresetSwitchConfig | null,
  presetName: string,
): { model?: string; thinking?: string; error?: string } {
  if (!config?.presets?.[presetName]) {
    const available = Object.keys(config?.presets ?? {}).join(", ") || "(none)";
    return { error: `Preset "${presetName}" not found. Available presets: ${available}` };
  }
  return {
    model: getPresetModelForOrchestrator(config, presetName),
    thinking: getPresetThinkingForOrchestrator(config, presetName),
  };
}

export function getPresetNames(config: PresetSwitchConfig | null): string[] {
  return Object.keys(config?.presets ?? {});
}

export function getPresetCompletions(
  config: PresetSwitchConfig | null,
  prefix: string,
): Array<{ value: string; label: string; description?: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const items = getPresetNames(config)
    .filter((name) => !normalizedPrefix || name.toLowerCase().includes(normalizedPrefix))
    .map((name) => {
      const model = getPresetModelForOrchestrator(config, name);
      const thinking = getPresetThinkingForOrchestrator(config, name);
      const details = [model, thinking ? `thinking:${thinking}` : undefined].filter(Boolean);
      return {
        value: name,
        label: name,
        ...(details.length > 0 ? { description: details.join(" | ") } : {}),
      };
    });
  return items.length > 0 ? items : null;
}
