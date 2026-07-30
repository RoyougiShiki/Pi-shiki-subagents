import type { HarnessConfig } from '../config/schema';

export interface PiCouncilParticipantConfig {
  name?: string;
  agent?: string;
  model?: string;
  variant?: string;
  prompt?: string;
}

export interface PiCouncilConfig {
  presets?: Record<string, Record<string, PiCouncilParticipantConfig>>;
  default_preset?: string;
  timeout?: number;
  councillor_execution_mode?: 'parallel' | 'serial';
  meeting_backend?: 'session' | 'collaborating';
}

/** Preset pack: optional subagent default + per-role model id strings. */
export type PresetModelPackConfig = Record<string, string>;

export interface OmniMoConfig {
  preset?: string;
  presets?: Record<string, PresetModelPackConfig | undefined>;
  agents?: Record<
    string,
    {
      model?: string;
      variant?: string;
      thinking?: string;
      presetPrimary?: boolean;
    }
  >;
  disabled_agents?: string[];
  council?: PiCouncilConfig;
  harness?: HarnessConfig;
}
