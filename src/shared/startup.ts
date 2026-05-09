export type StartupEntrySource = 'registry' | 'startup-folder';
export type StartupEntryScope = 'current-user' | 'all-users';
export type StartupEntryState = 'enabled' | 'disabled';

export interface StartupEntry {
  id: string;
  name: string;
  command: string;
  executablePath: string;
  arguments: string;
  source: StartupEntrySource;
  scope: StartupEntryScope;
  location: string;
  state: StartupEntryState;
  canToggle: boolean;
  notes?: string;
  disabledAt?: string;
}

export interface DisabledRegistryRecord {
  kind: 'registry';
  id: string;
  name: string;
  command: string;
  executablePath: string;
  arguments: string;
  scope: StartupEntryScope;
  location: string;
  registryHive: 'HKCU' | 'HKLM';
  registryPath: string;
  valueName: string;
  regType: string;
  disabledAt: string;
}

export interface DisabledStartupFolderRecord {
  kind: 'startup-folder';
  id: string;
  name: string;
  command: string;
  executablePath: string;
  arguments: string;
  scope: StartupEntryScope;
  location: string;
  originalPath: string;
  cachedPath: string;
  disabledAt: string;
}

export type DisabledStartupRecord =
  | DisabledRegistryRecord
  | DisabledStartupFolderRecord;

export interface StartupCacheFile {
  version: 1;
  disabledEntries: DisabledStartupRecord[];
}
