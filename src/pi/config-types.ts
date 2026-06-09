import type { HarnessConfig } from '../config/schema';
import type { WorkflowsConfig } from '../config/workflow-types';

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

export interface OmniMoConfig {
  preset?: string;
  presets?: Record<
    string,
    Record<
      string,
      | { model?: string; variant?: string; thinking?: string }
      | Record<string, unknown>
    >
  >;
  agents?: Record<
    string,
    {
      model?: string;
      variant?: string;
      thinking?: string;
      workflow?: string;
      presetPrimary?: boolean;
    }
  >;
  disabled_agents?: string[];
  council?: PiCouncilConfig;
  workflows?: WorkflowsConfig;
  harness?: HarnessConfig;
}
