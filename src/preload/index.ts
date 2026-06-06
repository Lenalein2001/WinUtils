import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { StartupEntry } from '../shared/startup';
import type { Macro, MacroAction, MacroFolder, MacroState } from '../shared/macro';
import type { FocusAudioConfig, FocusAudioState } from '../shared/focusAudio';
import type { AlwaysActiveMode, AlwaysActiveRuleUpdate, AlwaysActiveState } from '../shared/alwaysActive';
import type { AppSettings } from '../shared/settings';
import type { RenameApplyResult, RenamePreview, RenameRule, RenameTransaction, RenameUndoResult, RenamerItem, RenamerLoadOptions, RenamerLoadPathsInput, RenamerPreviewInput } from '../shared/renamer';
import type { AppUpdateInfo, UpdateState } from '../shared/updater';
import type { ClipboardClearMode, ClipboardQuery, ClipboardState } from '../shared/clipboard';
import type { FileSyncAnalyzeResult, FileSyncApplyResult, FileSyncJobInput, FileSyncState } from '../shared/fileSync';

const api = {
  startupApps: {
    list: (): Promise<StartupEntry[]> => ipcRenderer.invoke('startup-apps:list'),
    disable: (id: string): Promise<StartupEntry[]> => ipcRenderer.invoke('startup-apps:disable', id),
    enable: (id: string): Promise<StartupEntry[]> => ipcRenderer.invoke('startup-apps:enable', id),
    delete: (id: string): Promise<StartupEntry[]> => ipcRenderer.invoke('startup-apps:delete', id),
    add: (input: { name: string; executablePath: string; arguments?: string; scope: 'current-user' | 'all-users' }): Promise<StartupEntry[]> =>
      ipcRenderer.invoke('startup-apps:add', input),
    update: (input: { id: string; executablePath: string; arguments?: string }): Promise<StartupEntry[]> =>
      ipcRenderer.invoke('startup-apps:update', input),
    pickExecutable: (): Promise<string | null> =>
      ipcRenderer.invoke('startup-apps:pickExecutable'),
    restartAsAdmin: (): Promise<void> => ipcRenderer.invoke('startup-apps:restartAsAdmin'),
  },
  focusAudio: {
    getState: (): Promise<FocusAudioState> => ipcRenderer.invoke('focusAudio:getState'),
    setEnabled: (enabled: boolean): Promise<FocusAudioConfig> => ipcRenderer.invoke('focusAudio:setEnabled', enabled),
    setMode: (mode: 'whitelist' | 'blacklist'): Promise<FocusAudioConfig> => ipcRenderer.invoke('focusAudio:setMode', mode),
    setWhitelist: (list: string[]): Promise<FocusAudioConfig> => ipcRenderer.invoke('focusAudio:setWhitelist', list),
    setBlacklist: (list: string[]): Promise<FocusAudioConfig> => ipcRenderer.invoke('focusAudio:setBlacklist', list),
    getActiveApps: (): Promise<string[]> => ipcRenderer.invoke('focusAudio:getActiveApps'),
  },
  alwaysActive: {
    getState: (): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:getState'),
    refreshWindows: (): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:refreshWindows'),
    setEnabled: (enabled: boolean): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:setEnabled', enabled),
    addRuleFromWindow: (windowId: string, mode?: AlwaysActiveMode): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:addRuleFromWindow', windowId, mode),
    updateRule: (patch: AlwaysActiveRuleUpdate): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:updateRule', patch),
    deleteRule: (id: string): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:deleteRule', id),
    pause: (seconds: number): Promise<AlwaysActiveState> => ipcRenderer.invoke('alwaysActive:pause', seconds),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('alwaysActive:changed', listener);
      return () => ipcRenderer.removeListener('alwaysActive:changed', listener);
    },
  },
  macros: {
    getState: (): Promise<MacroState> => ipcRenderer.invoke('macros:getState'),
    newId: (): Promise<string> => ipcRenderer.invoke('macros:newId'),
    upsertMacro: (macro: Macro, profileName?: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:upsertMacro', macro, profileName),
    deleteMacro: (macroId: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:deleteMacro', macroId),
    runMacro: (macroId: string): Promise<void> =>
      ipcRenderer.invoke('macros:runMacro', macroId),
    reorderActions: (macroId: string, actions: MacroAction[]): Promise<MacroState> =>
      ipcRenderer.invoke('macros:reorderActions', macroId, actions),
    moveMacroToFolder: (macroId: string, folderId: string | null): Promise<MacroState> =>
      ipcRenderer.invoke('macros:moveMacroToFolder', macroId, folderId),
    upsertFolder: (folder: MacroFolder): Promise<MacroState> =>
      ipcRenderer.invoke('macros:upsertFolder', folder),
    deleteFolder: (folderId: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:deleteFolder', folderId),
    switchProfile: (name: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:switchProfile', name),
    addProfile: (name: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:addProfile', name),
    deleteProfile: (name: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:deleteProfile', name),
    updateRecordHotkey: (hotkey: string): Promise<MacroState> =>
      ipcRenderer.invoke('macros:updateRecordHotkey', hotkey),
    updateProcessBindings: (profileName: string, bindings: string[]): Promise<MacroState> =>
      ipcRenderer.invoke('macros:updateProcessBindings', profileName, bindings),
    getActiveApps: (): Promise<string[]> =>
      ipcRenderer.invoke('macros:getActiveApps'),
    /** Subscribe to auto-profile-switch events from the main process. Returns an unsubscribe function. */
    onProfileChanged: (cb: (state: MacroState) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, state: MacroState): void => cb(state);
      ipcRenderer.on('macros:profileChanged', listener);
      return () => ipcRenderer.removeListener('macros:profileChanged', listener);
    },
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:update', patch),
  },
  updates: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke('updates:getState'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
    download: (): Promise<UpdateState> => ipcRenderer.invoke('updates:download'),
    install: (): Promise<UpdateState> => ipcRenderer.invoke('updates:install'),
    getLatestRelease: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('updates:getLatestRelease'),
    getReleaseHistory: (): Promise<AppUpdateInfo[]> => ipcRenderer.invoke('updates:getReleaseHistory'),
    openReleasePage: (): Promise<void> => ipcRenderer.invoke('updates:openReleasePage'),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, state: UpdateState): void => cb(state);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    },
  },
  renamer: {
    pickFiles: (): Promise<RenamerItem[]> => ipcRenderer.invoke('renamer:pickFiles'),
    pickFolder: (options: RenamerLoadOptions): Promise<RenamerItem[]> => ipcRenderer.invoke('renamer:pickFolder', options),
    loadPaths: (input: RenamerLoadPathsInput): Promise<RenamerItem[]> => ipcRenderer.invoke('renamer:loadPaths', input),
    preview: (input: RenamerPreviewInput): Promise<RenamePreview> => ipcRenderer.invoke('renamer:preview', input),
    apply: (input: RenamerPreviewInput): Promise<RenameApplyResult> => ipcRenderer.invoke('renamer:apply', input),
    undo: (transactionId?: string): Promise<RenameUndoResult> => ipcRenderer.invoke('renamer:undo', transactionId),
    listTransactions: (): Promise<RenameTransaction[]> => ipcRenderer.invoke('renamer:listTransactions'),
    defaultRules: (): Promise<RenameRule[]> => ipcRenderer.invoke('renamer:defaultRules'),
    getDroppedPath: (file: Parameters<typeof webUtils.getPathForFile>[0]): string => webUtils.getPathForFile(file),
  },
  fileSync: {
    getState: (): Promise<FileSyncState> => ipcRenderer.invoke('fileSync:getState'),
    createJob: (input?: FileSyncJobInput): Promise<FileSyncState> => ipcRenderer.invoke('fileSync:createJob', input),
    updateJob: (id: string, input: FileSyncJobInput): Promise<FileSyncState> => ipcRenderer.invoke('fileSync:updateJob', id, input),
    deleteJob: (id: string): Promise<FileSyncState> => ipcRenderer.invoke('fileSync:deleteJob', id),
    analyze: (jobId: string): Promise<FileSyncAnalyzeResult> => ipcRenderer.invoke('fileSync:analyze', jobId),
    apply: (jobId: string): Promise<FileSyncApplyResult> => ipcRenderer.invoke('fileSync:apply', jobId),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('fileSync:pickFolder'),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('fileSync:changed', listener);
      return () => ipcRenderer.removeListener('fileSync:changed', listener);
    },
  },
  clipboard: {
    getState: (query?: ClipboardQuery): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:getState', query),
    captureNow: (): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:captureNow'),
    setMonitoring: (enabled: boolean): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:setMonitoring', enabled),
    setCaptureImages: (enabled: boolean): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:setCaptureImages', enabled),
    setImageOcr: (enabled: boolean): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:setImageOcr', enabled),
    setPinned: (id: string, pinned: boolean): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:setPinned', id, pinned),
    copy: (id: string): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:copy', id),
    delete: (id: string): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:delete', id),
    clear: (mode: ClipboardClearMode): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:clear', mode),
    rerunOcr: (id: string): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:rerunOcr', id),
    openQuickAccess: (): Promise<ClipboardState> => ipcRenderer.invoke('clipboard:openQuickAccess'),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('clipboard:changed', listener);
      return () => ipcRenderer.removeListener('clipboard:changed', listener);
    },
    onOpenRequested: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('clipboard:open', listener);
      return () => ipcRenderer.removeListener('clipboard:open', listener);
    },
  },
  tray: {
    showMain: (): Promise<void> => ipcRenderer.invoke('tray:show-main'),
    quit: (): Promise<void> => ipcRenderer.invoke('tray:quit'),
  },
};

contextBridge.exposeInMainWorld('winUtils', api);
