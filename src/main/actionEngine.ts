import { actionContext } from './actionContext';
import { TaskPool } from './taskPool';
import { randomUUID } from 'node:crypto';
import type {
  AutomationActionDefinition,
  AutomationActionRequest,
  AutomationActionResult,
} from '../shared/actions';

export type AutomationActionHandler = (parameters: Record<string, unknown>) => Promise<void> | void;

export interface AutomationActionRegistration {
  definition: AutomationActionDefinition;
  handler: AutomationActionHandler;
}

export class ActionEngine {
  private readonly pool = new TaskPool(4);
  private readonly running = new Map<string, { actionId: string; controller: AbortController; startedAt: string }>();
  private paused = false;
  private generation = 0;
  private pending = 0;

  getActivity() {
    return { paused: this.paused, pending: Math.max(0, this.pending - this.running.size), running: [...this.running].map(([id, run]) => ({ id, actionId: run.actionId, startedAt: run.startedAt })) };
  }
  cancelAll(): void {
    this.paused = true; this.generation++;
    for (const run of this.running.values()) run.controller.abort();
  }
  resume(): void { this.paused = false; }
  private registrations = new Map<string, AutomationActionRegistration>();
  private ownerActionIds = new Map<string, Set<string>>();
  private readonly catalogListeners = new Set<() => void>();

  replaceOwnerActions(ownerId: string, actions: AutomationActionRegistration[]): void {
    const next = new Map(this.registrations);
    for (const actionId of this.ownerActionIds.get(ownerId) ?? []) {
      next.delete(actionId);
    }

    const nextOwnerIds = new Set<string>();
    for (const action of actions) {
      if (action.definition.ownerId !== ownerId) {
        throw new Error(`Action "${action.definition.id}" owner does not match "${ownerId}".`);
      }
      if (next.has(action.definition.id)) {
        throw new Error(`Action "${action.definition.id}" is already registered.`);
      }
      next.set(action.definition.id, action);
      nextOwnerIds.add(action.definition.id);
    }

    this.registrations = next;
    this.ownerActionIds.set(ownerId, nextOwnerIds);
    for (const listener of this.catalogListeners) listener();
  }

  onCatalogChanged(listener: () => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  getCatalog(): AutomationActionDefinition[] {
    return [...this.registrations.values()]
      .map(registration => registration.definition)
      .sort((left, right) => left.ownerLabel.localeCompare(right.ownerLabel) || left.label.localeCompare(right.label));
  }

  async execute(request: AutomationActionRequest): Promise<AutomationActionResult> {
    if (!request || typeof request.actionId !== 'string') throw new Error('Invalid action request.');
    const executedAt = new Date().toISOString();
    const registration = this.registrations.get(request.actionId);
    if (!registration) {
      return {
        ok: false,
        actionId: request.actionId,
        executedAt,
        error: `Action "${request.actionId}" is not registered.`,
      };
    }

    try {
      if (this.paused) throw new Error('Automation is paused. Resume it explicitly before running actions.');
      const parameters = validateParameters(registration.definition, request.parameters ?? {});
      const parent = actionContext.getStore();
      if (parent) {
        parent.signal.throwIfAborted();
        if (parent.depth >= 8) throw new Error('Nested automation exceeds the depth limit.');
        await actionContext.run({ ...parent, depth: parent.depth + 1 }, () => registration.handler(parameters));
      } else {
        if (this.pending >= 64) throw new Error('Automation queue is full.');
        const generation = this.generation;
        this.pending++;
        try {
          await this.pool.run(async () => {
            if (this.paused || generation !== this.generation) throw new Error('Automation was stopped before execution.');
            const id = randomUUID(), controller = new AbortController();
            const deadline = setTimeout(() => controller.abort(new Error('Action execution timed out.')), 65_000);
            this.running.set(id, { actionId: request.actionId, controller, startedAt: executedAt });
            try {
              await actionContext.run({ signal: controller.signal, depth: 0 }, () => registration.handler(parameters));
              controller.signal.throwIfAborted();
            } finally { clearTimeout(deadline); this.running.delete(id); }
          });
        } finally { this.pending--; }
      }
      return { ok: true, actionId: request.actionId, executedAt };
    } catch (error) {
      return {
        ok: false,
        actionId: request.actionId,
        executedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function validateParameters(
  definition: AutomationActionDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const parameter of definition.parameters ?? []) {
    const rawValue = input[parameter.id] ?? parameter.defaultValue;
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      if (parameter.required) throw new Error(`${parameter.label} is required.`);
      continue;
    }

    if (parameter.type === 'boolean') {
      if (typeof rawValue !== 'boolean') throw new Error(`${parameter.label} must be true or false.`);
      output[parameter.id] = rawValue;
      continue;
    }

    if (parameter.type === 'number') {
      const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (!Number.isFinite(value)) throw new Error(`${parameter.label} must be a number.`);
      if (parameter.min !== undefined && value < parameter.min) throw new Error(`${parameter.label} must be at least ${parameter.min}.`);
      if (parameter.max !== undefined && value > parameter.max) throw new Error(`${parameter.label} must be at most ${parameter.max}.`);
      output[parameter.id] = value;
      continue;
    }

    if (typeof rawValue !== 'string') throw new Error(`${parameter.label} must be text.`);
    if (parameter.type === 'select' && !parameter.options?.some(option => option.value === rawValue)) {
      throw new Error(`${parameter.label} has an unsupported value.`);
    }
    output[parameter.id] = rawValue;
  }
  return output;
}
