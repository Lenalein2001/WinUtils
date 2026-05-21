/// <reference types="vite/client" />

import type { StartupEntry } from '../../shared/startup';
import type { Macro, MacroAction, MacroFolder, MacroState } from '../../shared/macro';
import type { FocusAudioConfig, FocusAudioState } from '../../shared/focusAudio';
import type { AppSettings } from '../../shared/settings';
import type { PlayitAgentClaimStart, PlayitInstallResult, PlayitState, PlayitTunnelInput, PlayitTunnelUpdateInput } from '../../shared/playit';
import type { UpdateState } from '../../shared/updater';

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
      };
      focusAudio: {
        getState: () => Promise<FocusAudioState>;
        setEnabled: (enabled: boolean) => Promise<FocusAudioConfig>;
        setMode: (mode: 'whitelist' | 'blacklist') => Promise<FocusAudioConfig>;
        setWhitelist: (list: string[]) => Promise<FocusAudioConfig>;
        setBlacklist: (list: string[]) => Promise<FocusAudioConfig>;
        getActiveApps: () => Promise<string[]>;
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
        openReleasePage: () => Promise<void>;
        onState: (cb: (state: UpdateState) => void) => () => void;
      };
      playit: {
        getState: () => Promise<PlayitState>;
        installWithWinget: () => Promise<PlayitInstallResult>;
        installFromDownload: () => Promise<PlayitInstallResult>;
        startAgentClaim: () => Promise<PlayitAgentClaimStart>;
        completeAgentClaim: (claimCode: string) => Promise<PlayitInstallResult>;
        createTunnel: (input: PlayitTunnelInput) => Promise<PlayitState>;
        updateTunnel: (input: PlayitTunnelUpdateInput) => Promise<PlayitState>;
        deleteTunnel: (id: string) => Promise<PlayitState>;
        startAgent: () => Promise<PlayitState>;
        openDownloadPage: () => Promise<void>;
        openAccountPage: () => Promise<void>;
        openTunnelSetupPage: () => Promise<void>;
      };
      tray: {
        showMain: () => Promise<void>;
        quit: () => Promise<void>;
      };
    };
  }
}

export {};
