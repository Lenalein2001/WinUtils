/// <reference types="vite/client" />

import type { StartupEntry } from '../../shared/startup';
import type { Macro, MacroAction, MacroFolder, MacroState } from '../../shared/macro';
import type { FocusAudioConfig, FocusAudioState } from '../../shared/focusAudio';
import type { AlwaysActiveMode, AlwaysActiveRuleUpdate, AlwaysActiveState } from '../../shared/alwaysActive';
import type { AppSettings } from '../../shared/settings';
import type { RenameApplyResult, RenamePreview, RenameRule, RenameTransaction, RenameUndoResult, RenamerItem, RenamerLoadOptions, RenamerLoadPathsInput, RenamerPreviewInput } from '../../shared/renamer';
import type { AppUpdateInfo, UpdateState } from '../../shared/updater';
import type { ClipboardClearMode, ClipboardQuery, ClipboardSettings, ClipboardState } from '../../shared/clipboard';
import type { FileSyncAnalyzeResult, FileSyncApplyResult, FileSyncJobInput, FileSyncState } from '../../shared/fileSync';

declare global {
  interface Window {
    winUtils: {
      startupApps: {
        list: () => Promise<StartupEntry[]>;
        disable: (id: string) => Promise<StartupEntry[]>;
        enable: (id: string) => Promise<StartupEntry[]>;
        delete: (id: string) => Promise<StartupEntry[]>;
        add: (input: { name: string; executablePath: string; arguments?: string; scope: 'current-user' | 'all-users' }) => Promise<StartupEntry[]>;
        update: (input: { id: string; executablePath: string; arguments?: string }) => Promise<StartupEntry[]>;
        pickExecutable: () => Promise<string | null>;
        restartAsAdmin: () => Promise<void>;
      };
      focusAudio: {
        getState: () => Promise<FocusAudioState>;
        setEnabled: (enabled: boolean) => Promise<FocusAudioConfig>;
        setMode: (mode: 'whitelist' | 'blacklist') => Promise<FocusAudioConfig>;
        setWhitelist: (list: string[]) => Promise<FocusAudioConfig>;
        setBlacklist: (list: string[]) => Promise<FocusAudioConfig>;
        getActiveApps: () => Promise<string[]>;
      };
      alwaysActive: {
        getState: () => Promise<AlwaysActiveState>;
        refreshWindows: () => Promise<AlwaysActiveState>;
        setEnabled: (enabled: boolean) => Promise<AlwaysActiveState>;
        addRuleFromWindow: (windowId: string, mode?: AlwaysActiveMode) => Promise<AlwaysActiveState>;
        updateRule: (patch: AlwaysActiveRuleUpdate) => Promise<AlwaysActiveState>;
        deleteRule: (id: string) => Promise<AlwaysActiveState>;
        pause: (seconds: number) => Promise<AlwaysActiveState>;
        onChanged: (cb: () => void) => () => void;
      };
      macros: {
        getState: () => Promise<MacroState>;
        newId: () => Promise<string>;
        upsertMacro: (macro: Macro, profileName?: string) => Promise<MacroState>;
        deleteMacro: (macroId: string) => Promise<MacroState>;
        runMacro: (macroId: string) => Promise<void>;
        reorderActions: (macroId: string, actions: MacroAction[]) => Promise<MacroState>;
        moveMacroToFolder: (macroId: string, folderId: string | null) => Promise<MacroState>;
        upsertFolder: (folder: MacroFolder) => Promise<MacroState>;
        deleteFolder: (folderId: string) => Promise<MacroState>;
        switchProfile: (name: string) => Promise<MacroState>;
        addProfile: (name: string) => Promise<MacroState>;
        deleteProfile: (name: string) => Promise<MacroState>;
        updateRecordHotkey: (hotkey: string) => Promise<MacroState>;
        updateProcessBindings: (profileName: string, bindings: string[]) => Promise<MacroState>;
        getActiveApps: () => Promise<string[]>;
        onProfileChanged: (cb: (state: MacroState) => void) => () => void;
      };
      settings: {
        get: () => Promise<AppSettings>;
        update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      };
      updates: {
        getState: () => Promise<UpdateState>;
        check: () => Promise<UpdateState>;
        download: () => Promise<UpdateState>;
        install: () => Promise<UpdateState>;
        getLatestRelease: () => Promise<AppUpdateInfo>;
        getReleaseHistory: () => Promise<AppUpdateInfo[]>;
        openReleasePage: () => Promise<void>;
        onState: (cb: (state: UpdateState) => void) => () => void;
      };
      renamer: {
        pickFiles: () => Promise<RenamerItem[]>;
        pickFolder: (options: RenamerLoadOptions) => Promise<RenamerItem[]>;
        loadPaths: (input: RenamerLoadPathsInput) => Promise<RenamerItem[]>;
        preview: (input: RenamerPreviewInput) => Promise<RenamePreview>;
        apply: (input: RenamerPreviewInput) => Promise<RenameApplyResult>;
        undo: (transactionId?: string) => Promise<RenameUndoResult>;
        listTransactions: () => Promise<RenameTransaction[]>;
        defaultRules: () => Promise<RenameRule[]>;
        getDroppedPath: (file: File) => string;
      };
      fileSync: {
        getState: () => Promise<FileSyncState>;
        createJob: (input?: FileSyncJobInput) => Promise<FileSyncState>;
        updateJob: (id: string, input: FileSyncJobInput) => Promise<FileSyncState>;
        deleteJob: (id: string) => Promise<FileSyncState>;
        analyze: (jobId: string) => Promise<FileSyncAnalyzeResult>;
        apply: (jobId: string) => Promise<FileSyncApplyResult>;
        pickFolder: () => Promise<string | null>;
        onChanged: (cb: () => void) => () => void;
      };
      clipboard: {
        getState: (query?: ClipboardQuery) => Promise<ClipboardState>;
        captureNow: () => Promise<ClipboardState>;
        setMonitoring: (enabled: boolean) => Promise<ClipboardState>;
        setCaptureImages: (enabled: boolean) => Promise<ClipboardState>;
        setImageOcr: (enabled: boolean) => Promise<ClipboardState>;
        setRetention: (settings: Pick<ClipboardSettings, 'retentionDays' | 'maxEntries'>) => Promise<ClipboardState>;
        setPinned: (id: string, pinned: boolean) => Promise<ClipboardState>;
        copy: (id: string) => Promise<ClipboardState>;
        delete: (id: string) => Promise<ClipboardState>;
        clear: (mode: ClipboardClearMode) => Promise<ClipboardState>;
        rerunOcr: (id: string) => Promise<ClipboardState>;
        openQuickAccess: () => Promise<ClipboardState>;
        onChanged: (cb: () => void) => () => void;
        onOpenRequested: (cb: () => void) => () => void;
      };
      tray: {
        showMain: () => Promise<void>;
        quit: () => Promise<void>;
      };
    };
  }
}

export {};
