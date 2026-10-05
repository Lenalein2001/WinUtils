import type { AutomationActionRequest } from './actions';

export type AutomationTriggerType =
  | 'application-started'
  | 'application-closed'
  | 'window-focused'
  | 'clipboard-changed'
  | 'file-created'
  | 'file-modified'
  | 'file-deleted'
  | 'monitor-connected'
  | 'network-connected'
  | 'windows-unlocked'
  | 'schedule'
  | 'winutils-started';

export type AutomationTriggerConcurrency = 'skip' | 'queue-one';

export interface AutomationTrigger {
  id: string;
  name: string;
  enabled: boolean;
  type: AutomationTriggerType;
  matchValue: string;
  intervalSeconds: number;
  cooldownSeconds: number;
  concurrency: AutomationTriggerConcurrency;
  action: AutomationActionRequest;
  lastRunAt: string | null;
  lastError: string | null;
  runCount: number;
  running: boolean;
  queued: boolean;
}

export type AutomationTriggerInput = Omit<
  AutomationTrigger,
  'id' | 'lastRunAt' | 'lastError' | 'runCount' | 'running' | 'queued'
> & { id?: string };

export interface AutomationTriggerState {
  triggers: AutomationTrigger[];
  workerRunning: boolean;
  lastSnapshotAt: string | null;
}
