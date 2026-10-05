import { SerialTaskQueue, writeJsonAtomically } from './atomicFile';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  formatHotkey,
  normalizeHotkey,
  type HotkeyActionBindingInput,
  type HotkeyBinding,
  type HotkeyConflict,
  type HotkeyState,
  type HotkeyUpdateInput,
  type HotkeyUpdateResult,
} from '../shared/hotkeys';
import type { ActionEngine } from './actionEngine';
import { getHotkeyDiagnostics, replaceHotkeys, startHook, stopHook } from './macroHook';

interface HotkeyOverride {
  hotkey: string;
  enabled: boolean;
}

interface HotkeyStoreFile {
  version: 1 | 2;
  overrides: Record<string, HotkeyOverride>;
  actionBindings?: StoredActionHotkey[];
}

interface StoredActionHotkey {
  id: string;
  actionId: string;
  hotkey: string;
  enabled: boolean;
}

export interface RuntimeHotkeyRegistration {
  id: string;
  actionId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  description: string;
  hotkey: string;
  enabled: boolean;
  available: boolean;
  editable: boolean;
  source: 'feature' | 'macro' | 'action';
  suppressWhenAppFocused: boolean;
  onDown: () => void;
  onUp?: () => void;
  onUpdate?: (input: Pick<HotkeyUpdateInput, 'hotkey' | 'enabled'>) => Promise<void>;
}

export interface FeatureHotkeyRegistration {
  id: string;
  actionId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  description: string;
  defaultHotkey: string;
  defaultEnabled?: boolean;
  suppressWhenAppFocused?: boolean;
}

export class HotkeyManager {
  private readonly saveQueue = new SerialTaskQueue();
  private readonly ownerBindings = new Map<string, RuntimeHotkeyRegistration[]>();
  private readonly featureDefaults = new Map<string, FeatureHotkeyRegistration>();
  private overrides = new Map<string, HotkeyOverride>();
  private actionBindings: StoredActionHotkey[] = [];
  private unsubscribeCatalog: (() => void) | null = null;
  private initialized = false;
  private updateChain: Promise<void> = Promise.resolve();
  private updateBatchDepth = 0;
  private syncPending = false;

  constructor(
    private readonly actions: ActionEngine,
    private readonly onStateChanged?: () => void,
  ) {}

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'hotkeys.json');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.load();
    this.unsubscribeCatalog = this.actions.onCatalogChanged(() => this.syncActionBindings());
    await startHook();
    this.syncActionBindings();
    this.syncRegistrations();
  }

  replaceOwnerBindings(ownerId: string, bindings: RuntimeHotkeyRegistration[]): void {
    if (bindings.some(binding => binding.ownerId !== ownerId)) {
      throw new Error(`Hotkey binding owner does not match "${ownerId}".`);
    }
    this.ownerBindings.set(ownerId, bindings);
    this.syncRegistrations();
  }

  registerFeatureBinding(binding: FeatureHotkeyRegistration): void {
    this.featureDefaults.set(binding.id, binding);
    this.syncFeatureBindings();
  }

  getState(): HotkeyState {
    const registrations = this.getRegistrations();
    const conflicts = this.buildConflicts(registrations);
    const conflictedIds = new Set(conflicts.flatMap(conflict => conflict.bindingIds));
    const diagnostics = new Map(
      getHotkeyDiagnostics().hotkeys.map(item => [normalizeHotkey(item.hotkey), item] as const),
    );

    const bindings: HotkeyBinding[] = registrations.map(registration => {
      const normalizedHotkey = normalizeHotkey(registration.hotkey);
      const diagnostic = diagnostics.get(normalizedHotkey);
      const status = !registration.enabled || !normalizedHotkey
        ? 'disabled'
        : !registration.available
          ? 'disabled'
        : conflictedIds.has(registration.id)
          ? 'internal-conflict'
          : !diagnostic || diagnostic.backend === 'none'
            ? 'os-registration-failed'
            : 'active';

      return {
        id: registration.id,
        actionId: registration.actionId,
        ownerId: registration.ownerId,
        ownerLabel: registration.ownerLabel,
        label: registration.label,
        description: registration.description,
        hotkey: formatHotkey(registration.hotkey),
        normalizedHotkey,
        enabled: registration.enabled,
        available: registration.available,
        editable: registration.editable,
        source: registration.source,
        backend: diagnostic?.backend ?? 'none',
        status,
        registrationError: status === 'os-registration-failed'
          ? `${formatHotkey(registration.hotkey)} is already reserved by Windows or another application.`
          : undefined,
      };
    });

    return {
      bindings: bindings.sort((left, right) => left.ownerLabel.localeCompare(right.ownerLabel) || left.label.localeCompare(right.label)),
      conflicts,
      actions: this.actions.getCatalog(),
    };
  }

  getBinding(bindingId: string): HotkeyBinding | null {
    return this.getState().bindings.find(binding => binding.id === bindingId) ?? null;
  }

  updateBinding(input: HotkeyUpdateInput): Promise<HotkeyUpdateResult> {
    const update = this.updateChain.then(async () => {
      const result = await this.performUpdate(input);
      return { ...result, state: this.getState() };
    });
    this.updateChain = update.then(() => undefined, () => undefined);
    return update;
  }

  createActionBinding(input: HotkeyActionBindingInput): Promise<HotkeyUpdateResult> {
    const update = this.updateChain.then(() => this.performCreateActionBinding(input));
    this.updateChain = update.then(() => undefined, () => undefined);
    return update;
  }

  private async performCreateActionBinding(input: HotkeyActionBindingInput): Promise<HotkeyUpdateResult> {
    const definition = this.actions.getCatalog().find(action => action.id === input.actionId);
    if (!definition) return this.failedUpdate('Choose a registered action.');
    if ((definition.parameters ?? []).some(parameter => parameter.required && parameter.defaultValue === undefined)) {
      return this.failedUpdate('This action requires parameters. Configure it in a macro, then bind that macro.');
    }
    const hotkey = formatHotkey(input.hotkey);
    const normalized = normalizeHotkey(hotkey);
    if (!normalized) return this.failedUpdate('Choose a hotkey.');
    const conflicts = this.getRegistrations().filter(binding => (
      binding.enabled && binding.available && normalizeHotkey(binding.hotkey) === normalized
    ));
    if (conflicts.length) {
      return {
        ok: false,
        state: this.getState(),
        conflicts: [],
        error: `${hotkey} is already assigned to ${conflicts.map(binding => binding.label).join(', ')}.`,
      };
    }

    const binding: StoredActionHotkey = {
      id: `action:${randomUUID()}`,
      actionId: definition.id,
      hotkey,
      enabled: true,
    };
    this.actionBindings.push(binding);
    try {
      await this.save();
    } catch (error) {
      this.actionBindings = this.actionBindings.filter(item => item !== binding);
      throw error;
    }
    this.syncActionBindings();
    return { ok: true, state: this.getState(), conflicts: [] };
  }

  deleteActionBinding(bindingId: string): Promise<HotkeyState> {
    const update = this.updateChain.then(() => this.performDeleteActionBinding(bindingId));
    this.updateChain = update.then(() => undefined, () => undefined);
    return update;
  }

  private async performDeleteActionBinding(bindingId: string): Promise<HotkeyState> {
    const previous = this.actionBindings;
    const next = previous.filter(binding => binding.id !== bindingId);
    if (next.length === previous.length) throw new Error('Action hotkey not found.');
    this.actionBindings = next;
    try {
      await this.save();
    } catch (error) {
      this.actionBindings = previous;
      throw error;
    }
    this.syncActionBindings();
    return this.getState();
  }

  private async performUpdate(input: HotkeyUpdateInput): Promise<HotkeyUpdateResult> {
    this.updateBatchDepth += 1;
    try {
      return await this.performUpdateInBatch(input);
    } finally {
      this.updateBatchDepth -= 1;
      if (this.updateBatchDepth === 0 && this.syncPending) {
        this.syncPending = false;
        this.syncRegistrations();
      }
    }
  }

  private async performUpdateInBatch(input: HotkeyUpdateInput): Promise<HotkeyUpdateResult> {
    const registration = this.getRegistrations().find(binding => binding.id === input.bindingId);
    if (!registration) {
      return this.failedUpdate(`Hotkey binding "${input.bindingId}" was not found.`);
    }
    if (!registration.editable) {
      return this.failedUpdate(`Hotkey binding "${registration.label}" cannot be edited here.`);
    }

    const hotkey = formatHotkey(input.hotkey);
    const normalizedHotkey = normalizeHotkey(hotkey);
    if (input.enabled && !normalizedHotkey) {
      return this.failedUpdate('Choose a hotkey before enabling this binding.');
    }

    const conflicts = this.getRegistrations().filter(other => (
      input.enabled
      &&
      other.id !== registration.id
      && other.enabled
      && other.available
      && normalizedHotkey
      && normalizeHotkey(other.hotkey) === normalizedHotkey
    ));

    if (conflicts.length > 0 && !input.replaceConflicts) {
      return {
        ok: false,
        state: this.getState(),
        conflicts: this.buildConflicts([registration, ...conflicts].map(binding => (
          binding.id === registration.id ? { ...binding, hotkey, enabled: input.enabled } : binding
        ))),
        error: `${hotkey} is already assigned.`,
      };
    }

    if (conflicts.some(conflict => !conflict.editable)) {
      return this.failedUpdate(`${hotkey} is assigned to a binding that cannot be replaced here.`);
    }

    if (input.replaceConflicts) {
      const changed: RuntimeHotkeyRegistration[] = [];
      try {
        for (const conflict of conflicts) {
          await this.applyUpdate(conflict, { hotkey: conflict.hotkey, enabled: false });
          changed.push(conflict);
        }
        await this.applyUpdate(registration, { hotkey, enabled: input.enabled });
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const changedBinding of changed.reverse()) {
          try {
            await this.applyUpdate(changedBinding, {
              hotkey: changedBinding.hotkey,
              enabled: changedBinding.enabled,
            });
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          }
        }
        if (rollbackErrors.length > 0) {
          throw new Error(`Hotkey update failed and could not be fully rolled back: ${rollbackErrors.join('; ')}`, {
            cause: error,
          });
        }
        throw error;
      }
    } else {
      await this.applyUpdate(registration, { hotkey, enabled: input.enabled });
    }

    this.syncRegistrations();
    return { ok: true, state: this.getState(), conflicts: [] };
  }

  destroy(): void {
    replaceHotkeys([]);
    stopHook();
    this.ownerBindings.clear();
    this.featureDefaults.clear();
    this.actionBindings = [];
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = null;
  }

  private getRegistrations(): RuntimeHotkeyRegistration[] {
    return [...this.ownerBindings.values()].flat();
  }

  private syncFeatureBindings(): void {
    const bindings = [...this.featureDefaults.values()].map(feature => {
      const override = this.overrides.get(feature.id);
      const hotkey = override?.hotkey ?? feature.defaultHotkey;
      const enabled = override?.enabled ?? feature.defaultEnabled ?? true;

      return {
        id: feature.id,
        actionId: feature.actionId,
        ownerId: feature.ownerId,
        ownerLabel: feature.ownerLabel,
        label: feature.label,
        description: feature.description,
        hotkey,
        enabled,
        available: true,
        editable: true,
        source: 'feature' as const,
        suppressWhenAppFocused: feature.suppressWhenAppFocused ?? false,
        onDown: () => {
          void this.actions.execute({ actionId: feature.actionId }).then(result => {
            if (!result.ok) console.error(`[ActionEngine] ${result.error}`);
          });
        },
      };
    });

    this.ownerBindings.set('features', bindings);
    this.syncRegistrations();
  }

  private syncActionBindings(): void {
    this.ownerBindings.set('action-hotkeys', this.actionBindings.map(binding => this.toActionRegistration(binding)));
    this.syncRegistrations();
  }

  private toActionRegistration(binding: StoredActionHotkey): RuntimeHotkeyRegistration {
    const definition = this.actions.getCatalog().find(action => action.id === binding.actionId);
    return {
      id: binding.id,
      actionId: binding.actionId,
      ownerId: definition?.ownerId ?? 'missing-action',
      ownerLabel: definition?.ownerLabel ?? 'Unavailable actions',
      label: definition?.label ?? binding.actionId,
      description: definition?.description ?? 'The registered action is no longer available.',
      hotkey: binding.hotkey,
      enabled: binding.enabled,
      available: Boolean(definition),
      editable: true,
      source: 'action',
      suppressWhenAppFocused: false,
      onDown: () => {
        void this.actions.execute({ actionId: binding.actionId }).then(result => {
          if (!result.ok) console.error(`[ActionEngine] ${result.error}`);
        });
      },
    };
  }

  private syncRegistrations(): void {
    if (!this.initialized) return;
    if (this.updateBatchDepth > 0) {
      this.syncPending = true;
      return;
    }
    const registrations = this.getRegistrations();
    const conflicts = this.buildConflicts(registrations);
    const conflictedIds = new Set(conflicts.flatMap(conflict => conflict.bindingIds));

    replaceHotkeys(registrations
      .filter(binding => binding.enabled && binding.available && normalizeHotkey(binding.hotkey) && !conflictedIds.has(binding.id))
      .map(binding => ({
        hotkey: binding.hotkey,
        callback: {
          down: binding.onDown,
          up: binding.onUp,
          suppressWhenAppFocused: binding.suppressWhenAppFocused,
        },
      })));

    this.onStateChanged?.();
  }

  private buildConflicts(registrations: RuntimeHotkeyRegistration[]): HotkeyConflict[] {
    const groups = new Map<string, RuntimeHotkeyRegistration[]>();
    for (const registration of registrations) {
      const normalized = normalizeHotkey(registration.hotkey);
      if (!registration.enabled || !registration.available || !normalized) continue;
      const group = groups.get(normalized) ?? [];
      group.push(registration);
      groups.set(normalized, group);
    }

    return [...groups.entries()]
      .filter(([, bindings]) => bindings.length > 1)
      .map(([normalizedHotkey, bindings]) => ({
        hotkey: formatHotkey(bindings[0].hotkey),
        normalizedHotkey,
        bindingIds: bindings.map(binding => binding.id),
        labels: bindings.map(binding => `${binding.ownerLabel}: ${binding.label}`),
      }));
  }

  private async applyUpdate(
    registration: RuntimeHotkeyRegistration,
    input: Pick<HotkeyUpdateInput, 'hotkey' | 'enabled'>,
  ): Promise<void> {
    if (registration.source === 'feature') {
      const previous = this.overrides.get(registration.id);
      this.overrides.set(registration.id, input);
      try {
        await this.save();
      } catch (error) {
        if (previous) this.overrides.set(registration.id, previous);
        else this.overrides.delete(registration.id);
        throw error;
      }
      this.syncFeatureBindings();
      return;
    }
    if (registration.source === 'action') {
      const binding = this.actionBindings.find(item => item.id === registration.id);
      if (!binding) throw new Error('Action hotkey not found.');
      const previous = { hotkey: binding.hotkey, enabled: binding.enabled };
      Object.assign(binding, input);
      try {
        await this.save();
      } catch (error) {
        Object.assign(binding, previous);
        throw error;
      }
      this.syncActionBindings();
      return;
    }
    if (!registration.onUpdate) {
      throw new Error(`Hotkey binding "${registration.label}" does not support updates.`);
    }
    await registration.onUpdate(input);
  }

  private failedUpdate(error: string): HotkeyUpdateResult {
    return { ok: false, state: this.getState(), conflicts: [], error };
  }

  private async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) return;

    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<HotkeyStoreFile>;
      if ((parsed.version !== 1 && parsed.version !== 2) || !parsed.overrides || typeof parsed.overrides !== 'object') {
        throw new Error('Unsupported hotkey settings format.');
      }
      this.overrides = new Map(Object.entries(parsed.overrides)
        .filter((entry): entry is [string, HotkeyOverride] => (
          typeof entry[1]?.hotkey === 'string' && typeof entry[1]?.enabled === 'boolean'
        )));
      this.actionBindings = Array.isArray(parsed.actionBindings)
        ? parsed.actionBindings.filter((binding): binding is StoredActionHotkey => (
          Boolean(binding)
          && typeof binding.id === 'string'
          && typeof binding.actionId === 'string'
          && typeof binding.hotkey === 'string'
          && typeof binding.enabled === 'boolean'
        ))
        : [];
    } catch (error) {
      throw new Error(`Hotkey settings could not be read; the original file was preserved. ${String(error)}`);
      this.overrides.clear();
      this.actionBindings = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const file: HotkeyStoreFile = {
      version: 2,
      overrides: Object.fromEntries(this.overrides),
      actionBindings: this.actionBindings,
    };
    const snapshot = structuredClone(file);
    await this.saveQueue.run(() => writeJsonAtomically(this.filePath, snapshot));
  }
}
