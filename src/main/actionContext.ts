import { AsyncLocalStorage } from 'node:async_hooks';
export interface ActionContext { signal: AbortSignal; depth: number }
export const actionContext = new AsyncLocalStorage<ActionContext>();
export function automationSignal(): AbortSignal | undefined { return actionContext.getStore()?.signal; }
