import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { StartupEntry } from '../shared/startup';
import type { Macro, MacroAction, MacroFolder, MacroState } from '../shared/macro';
import type { FocusAudioConfig, FocusAudioState } from '../shared/focusAudio';
import type { AppSettings } from '../shared/settings';
import type { PlayitAgentClaimStart, PlayitInstallResult, PlayitState, PlayitTunnelInput, PlayitTunnelUpdateInput } from '../shared/playit';
import type { RenameApplyResult, RenamePreview, RenameRule, RenameTransaction, RenameUndoResult, RenamerItem, RenamerLoadOptions, RenamerLoadPathsInput, RenamerPreviewInput } from '../shared/renamer';
import type { UpdateState } from '../shared/updater';

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
    openReleasePage: (): Promise<void> => ipcRenderer.invoke('updates:openReleasePage'),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, state: UpdateState): void => cb(state);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    },
  },
  playit: {
    getState: (): Promise<PlayitState> => ipcRenderer.invoke('playit:getState'),
    installWithWinget: (): Promise<PlayitInstallResult> => ipcRenderer.invoke('playit:installWithWinget'),
    installFromDownload: (): Promise<PlayitInstallResult> => ipcRenderer.invoke('playit:installFromDownload'),
    startAgentClaim: (): Promise<PlayitAgentClaimStart> => ipcRenderer.invoke('playit:startAgentClaim'),
    completeAgentClaim: (claimCode: string): Promise<PlayitInstallResult> => ipcRenderer.invoke('playit:completeAgentClaim', claimCode),
    createTunnel: (input: PlayitTunnelInput): Promise<PlayitState> => ipcRenderer.invoke('playit:createTunnel', input),
    updateTunnel: (input: PlayitTunnelUpdateInput): Promise<PlayitState> => ipcRenderer.invoke('playit:updateTunnel', input),
    deleteTunnel: (id: string): Promise<PlayitState> => ipcRenderer.invoke('playit:deleteTunnel', id),
    startAgent: (): Promise<PlayitState> => ipcRenderer.invoke('playit:startAgent'),
    openDownloadPage: (): Promise<void> => ipcRenderer.invoke('playit:openDownloadPage'),
    openAccountPage: (): Promise<void> => ipcRenderer.invoke('playit:openAccountPage'),
    openTunnelSetupPage: (): Promise<void> => ipcRenderer.invoke('playit:openTunnelSetupPage'),
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
  tray: {
    showMain: (): Promise<void> => ipcRenderer.invoke('tray:show-main'),
    quit: (): Promise<void> => ipcRenderer.invoke('tray:quit'),
  },
};

contextBridge.exposeInMainWorld('winUtils', api);
