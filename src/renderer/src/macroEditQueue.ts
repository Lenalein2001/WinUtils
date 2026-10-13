import type { Macro, MacroState } from '../../shared/macro';

export interface PendingMacroEdit { profile: string; macro: Macro; version: number; timer?: ReturnType<typeof setTimeout> }

/** Coalesce edits per macro while preserving write order and unsaved drafts. */
export class MacroEditQueue {
  private readonly edits = new Map<string, PendingMacroEdit>();
  private readonly flushing = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private version = 0;
  private readonly blockedKeys = new Set<string>();
  private readonly blockedProfiles = new Set<string>();
  private lastError: unknown = null;
  private frozen = false;
  private observer: { committed: (state: MacroState, pending: PendingMacroEdit[]) => void; failed: (error: unknown) => void; changed: (count: number) => void } | null = null;
  constructor(
    private readonly persist: (macro: Macro, profile: string) => Promise<MacroState>,
    private readonly debounceMs = 600,
  ) {}
  get pending(): PendingMacroEdit[] { return [...this.edits.values()]; }
  observe(committed: (state: MacroState, pending: PendingMacroEdit[]) => void, failed: (error: unknown) => void, changed: (count: number) => void): () => void {
    const observer = { committed, failed, changed }; this.observer = observer;
    changed(this.edits.size); if (this.lastError) failed(this.lastError);
    return () => { if (this.observer === observer) this.observer = null; };
  }
  private key(profile: string, id: string): string { return JSON.stringify([profile, id]); }
  setFrozen(frozen: boolean): void { this.frozen = frozen; }
  noteFailure(error: unknown): void { this.lastError = error; this.observer?.failed(error); }
  canEdit(profile: string, id: string): boolean { return !this.frozen && !this.blockedProfiles.has(profile) && !this.blockedKeys.has(this.key(profile, id)); }
  schedule(profile: string, macro: Macro): void {
    if (!this.canEdit(profile, macro.id)) return;
    const key = this.key(profile, macro.id);
    clearTimeout(this.edits.get(key)?.timer);
    const edit: PendingMacroEdit = { profile, macro, version: ++this.version };
    this.edits.set(key, edit);
    edit.timer = setTimeout(() => { void this.flush(profile, macro.id).catch(() => undefined); }, this.debounceMs);
    this.observer?.changed(this.edits.size);
  }
  async flush(profile: string, id: string): Promise<void> {
    const key = this.key(profile, id);
    const existing = this.flushing.get(key);
    if (existing) {
      await existing;
      if (this.edits.has(key)) await this.flush(profile, id);
      return;
    }
    const edit = this.edits.get(key);
    if (!edit) return;
    clearTimeout(edit.timer);
    const task = this.tail.then(async () => {
      const latest = this.edits.get(key);
      if (!latest) return;
      clearTimeout(latest.timer);
      try {
        const state = await this.persist(latest.macro, latest.profile);
        if (this.edits.get(key)?.version === latest.version) this.edits.delete(key);
        if (!this.edits.size) this.lastError = null;
        this.observer?.committed(state, this.pending);
      } catch (error) { this.lastError = error; this.observer?.failed(error); throw error; }
      finally { this.observer?.changed(this.edits.size); }
    });
    this.flushing.set(key, task);
    this.tail = task.catch(() => undefined);
    try { await task; }
    finally { if (this.flushing.get(key) === task) this.flushing.delete(key); }
    if (this.edits.has(key)) await this.flush(profile, id);
  }
  async flushAll(): Promise<void> {
    for (const edit of [...this.edits.values()]) await this.flush(edit.profile, edit.macro.id);
  }
  async discardAll(): Promise<void> {
    await Promise.all(this.pending.map(edit => this.cancel(edit.profile, edit.macro.id)));
    await this.tail;
    this.lastError = null; this.observer?.changed(this.edits.size);
  }
  async cancel(profile: string, id: string): Promise<void> {
    const key = this.key(profile, id);
    clearTimeout(this.edits.get(key)?.timer);
    this.edits.delete(key); this.observer?.changed(this.edits.size);
    if (!this.edits.size) this.lastError = null;
    await this.flushing.get(key)?.catch(() => undefined);
  }
  async cancelProfile(profile: string): Promise<void> {
    await Promise.all([...this.edits.values()].filter(edit => edit.profile === profile).map(edit => this.cancel(profile, edit.macro.id)));
  }
  async removeMacro<T>(profile: string, id: string, remove: () => Promise<T>): Promise<T> {
    const key = this.key(profile, id); this.blockedKeys.add(key);
    const drafts = this.pending.filter(edit => edit.profile === profile && edit.macro.id === id);
    try { await this.cancel(profile, id); return await remove(); }
    catch (error) { this.restore(drafts, error); throw error; }
    finally { this.blockedKeys.delete(key); }
  }
  async removeProfile<T>(profile: string, remove: () => Promise<T>): Promise<T> {
    this.blockedProfiles.add(profile);
    const drafts = this.pending.filter(edit => edit.profile === profile);
    try { await this.cancelProfile(profile); return await remove(); }
    catch (error) { this.restore(drafts, error); throw error; }
    finally { this.blockedProfiles.delete(profile); }
  }
  private restore(drafts: PendingMacroEdit[], error: unknown): void {
    for (const edit of drafts) this.edits.set(this.key(edit.profile, edit.macro.id), { ...edit, timer: undefined });
    if (drafts.length) {
      this.lastError = error;
      this.observer?.failed(error); this.observer?.changed(this.edits.size);
    }
  }
}

export function overlayMacroEdits(state: MacroState, pending: PendingMacroEdit[]): MacroState {
  if (!pending.length) return state;
  const patch = (profile: MacroState['activeProfile']): MacroState['activeProfile'] => {
    const updates = new Map(pending.filter(edit => edit.profile === profile.name).map(edit => [edit.macro.id, edit.macro]));
    if (!updates.size) return profile;
    return { ...profile, macros: profile.macros.map(macro => updates.get(macro.id) ?? macro),
      folders: profile.folders.map(folder => ({ ...folder, macros: folder.macros.map(macro => updates.get(macro.id) ?? macro) })) };
  };
  const activeProfile = patch(state.activeProfile);
  return { ...state, activeProfile, allMacros: [...activeProfile.macros, ...activeProfile.folders.flatMap(folder => folder.macros)],
    config: { ...state.config, profiles: state.config.profiles.map(patch) } };
}
