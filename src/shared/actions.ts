export type AutomationActionCategory =
  | 'application'
  | 'clipboard'
  | 'macro'
  | 'window'
  | 'audio'
  | 'file'
  | 'system';

export type AutomationActionParameterType = 'string' | 'number' | 'boolean' | 'select';

export interface AutomationActionParameterOption {
  value: string;
  label: string;
}

export interface AutomationActionParameterDefinition {
  id: string;
  label: string;
  description?: string;
  type: AutomationActionParameterType;
  required?: boolean;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  multiline?: boolean;
  min?: number;
  max?: number;
  options?: AutomationActionParameterOption[];
}

export interface AutomationActionDefinition {
  id: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  description: string;
  category: AutomationActionCategory;
  keywords: string[];
  parameters?: AutomationActionParameterDefinition[];
  dangerous?: boolean;
}

export interface AutomationActionRequest {
  actionId: string;
  parameters?: Record<string, unknown>;
}

export interface AutomationActionResult {
  ok: boolean;
  actionId: string;
  executedAt: string;
  error?: string;
}

export interface AutomationActivity {
  paused: boolean;
  pending: number;
  running: Array<{ id: string; actionId: string; label: string; startedAt: string }>;
  recent: AutomationActionHistory[];
}

export interface AutomationActionHistory extends AutomationActionResult {
  id: string;
  label: string;
  finishedAt: string;
  durationMs: number;
}
