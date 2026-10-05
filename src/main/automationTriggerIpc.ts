import { handleTrustedIpc } from './ipcSecurity';

import type { AutomationTriggerInput } from '../shared/automationTriggers';
import type { AutomationTriggerManager } from './automationTriggerManager';

export function registerAutomationTriggerIpc(manager: AutomationTriggerManager): void {
  handleTrustedIpc('triggers:getState', () => manager.getState());
  handleTrustedIpc('triggers:upsert', (_event, input: AutomationTriggerInput) => manager.upsert(input));
  handleTrustedIpc('triggers:delete', (_event, id: string) => manager.delete(id));
  handleTrustedIpc('triggers:runNow', (_event, id: string) => manager.runNow(id));
}
