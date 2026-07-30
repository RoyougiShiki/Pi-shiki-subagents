import { MODEL_PLACEHOLDER } from '../../config/constants';

/**
 * Shared helpers for model-id parsing used by /preset and council tools.
 * Preset packs no longer switch the main session model.
 */

export function parsePiModelId(
  modelId: string,
): { provider: string; model: string } | undefined {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

export function isModelPlaceholder(modelId: string | undefined): boolean {
  return modelId?.trim() === MODEL_PLACEHOLDER;
}
