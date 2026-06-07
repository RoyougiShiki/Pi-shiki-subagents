import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseJsonc } from './jsonc';

const CONFIG_BASENAME = 'oh-my-opencode-slim';

export function getDefaultPiNativeConfigDir(): string {
  return path.join(process.env.HOME || os.homedir(), '.pi', 'agent');
}

export function getPiNativeConfigBasePath(
  configDir = getDefaultPiNativeConfigDir(),
): string {
  return path.join(configDir, CONFIG_BASENAME);
}

export function getPiNativeConfigCandidates(
  configDir = getDefaultPiNativeConfigDir(),
): string[] {
  const basePath = getPiNativeConfigBasePath(configDir);
  return [`${basePath}.jsonc`, `${basePath}.json`];
}

export function getPiNativeConfigPath(
  configDir = getDefaultPiNativeConfigDir(),
): string {
  const [jsoncPath, jsonPath] = getPiNativeConfigCandidates(configDir);
  return fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;
}

export function readPiNativeConfigObject(
  configDir = getDefaultPiNativeConfigDir(),
): Record<string, any> {
  for (const configPath of getPiNativeConfigCandidates(configDir)) {
    try {
      return parseJsonc<Record<string, any>>(fs.readFileSync(configPath, 'utf-8'));
    } catch {}
  }
  return {};
}
