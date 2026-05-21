import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DisabledRegistryRecord,
  DisabledStartupFolderRecord,
  DisabledStartupRecord,
  StartupEntry,
  StartupEntryScope,
} from '../shared/startup';
import { StartupCacheStore } from './cacheStore';

const execFile = promisify(execFileCallback);

interface RegistryLocation {
  hive: 'HKCU' | 'HKLM';
  path: string;
  scope: StartupEntryScope;
  label: string;
}

const REGISTRY_LOCATIONS: RegistryLocation[] = [
  {
    hive: 'HKCU',
    path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    scope: 'current-user',
    label: 'HKCU Run',
  },
  {
    hive: 'HKLM',
    path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    scope: 'all-users',
    label: 'HKLM Run',
  },
  {
    hive: 'HKLM',
    path: 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
    scope: 'all-users',
    label: 'HKLM Run (32-bit)',
  },
];

interface RegistryEntryInternal extends StartupEntry {
  registryHive: 'HKCU' | 'HKLM';
  registryPath: string;
  valueName: string;
  regType: string;
}

interface StartupFolderEntryInternal extends StartupEntry {
  originalPath: string;
}

export class AdminRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminRequiredError';
  }
}

export class StartupManager {
  constructor(private readonly cacheStore: StartupCacheStore) {}

  async addEntry(input: {
    name: string;
    executablePath: string;
    arguments?: string;
    scope: StartupEntryScope;
  }): Promise<StartupEntry[]> {
    const name = input.name.trim();
    const executablePath = input.executablePath.trim();
    const args = (input.arguments ?? '').trim();

    if (!name) {
      throw new Error('Startup name is required.');
    }

    if (!executablePath) {
      throw new Error('Executable path is required.');
    }

    const location = input.scope === 'current-user' ? REGISTRY_LOCATIONS[0] : REGISTRY_LOCATIONS[1];
    const registryKey = `${location.hive}\\${location.path}`;
    const command = this.composeCommand(executablePath, args);

    try {
      await execFile('reg', ['add', registryKey, '/v', name, '/t', 'REG_SZ', '/d', command, '/f']);
    } catch (error) {
      throw this.createRegistryOperationError('add', location.hive, error);
    }

    return this.listEntries();
  }

  async updateEntry(input: {
    id: string;
    executablePath: string;
    arguments?: string;
  }): Promise<StartupEntry[]> {
    const executablePath = input.executablePath.trim();
    const args = (input.arguments ?? '').trim();

    if (!executablePath) {
      throw new Error('Executable path is required.');
    }

    const registryEntries = await this.getRegistryEntries();
    const registryEntry = registryEntries.find((entry) => entry.id === input.id);

    if (registryEntry) {
      const command = this.composeCommand(executablePath, args);
      const registryKey = `${registryEntry.registryHive}\\${registryEntry.registryPath}`;

      try {
        await execFile('reg', ['add', registryKey, '/v', registryEntry.valueName, '/t', registryEntry.regType, '/d', command, '/f']);
      } catch (error) {
        throw this.createRegistryOperationError('update', registryEntry.registryHive, error);
      }

      return this.listEntries();
    }

    const cache = await this.cacheStore.read();
    const disabledRegistryRecord = cache.disabledEntries.find(
      (record): record is DisabledRegistryRecord => record.id === input.id && record.kind === 'registry',
    );

    if (disabledRegistryRecord) {
      disabledRegistryRecord.executablePath = executablePath;
      disabledRegistryRecord.arguments = args;
      disabledRegistryRecord.command = this.composeCommand(executablePath, args);
      await this.cacheStore.upsertDisabledEntry(disabledRegistryRecord);
      return this.listEntries();
    }

    throw new Error('Only registry startup entries can be edited right now.');
  }

  async listEntries(): Promise<StartupEntry[]> {
    const [registryEntries, folderEntries, cache] = await Promise.all([
      this.getRegistryEntries(),
      this.getStartupFolderEntries(),
      this.cacheStore.read(),
    ]);

    const enabledEntries = [...registryEntries, ...folderEntries];
    const enabledIds = new Set(enabledEntries.map((entry) => entry.id));
    const disabledEntries = cache.disabledEntries
      .filter((record) => !enabledIds.has(record.id))
      .map((record) => this.mapDisabledRecord(record));

    return [...enabledEntries, ...disabledEntries].sort((left, right) => {
      if (left.state !== right.state) {
        return left.state === 'enabled' ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
  }

  async disableEntry(id: string): Promise<StartupEntry[]> {
    const [registryEntries, folderEntries] = await Promise.all([
      this.getRegistryEntries(),
      this.getStartupFolderEntries(),
    ]);

    const registryEntry = registryEntries.find((entry) => entry.id === id);
    if (registryEntry) {
      await this.disableRegistryEntry(registryEntry);
      return this.listEntries();
    }

    const folderEntry = folderEntries.find((entry) => entry.id === id);
    if (folderEntry) {
      await this.disableStartupFolderEntry(folderEntry);
      return this.listEntries();
    }

    throw new Error('The selected startup entry could not be found.');
  }

  async enableEntry(id: string): Promise<StartupEntry[]> {
    const record = await this.cacheStore.removeDisabledEntry(id);

    if (!record) {
      throw new Error('No cached startup entry was found to restore.');
    }

    try {
      if (record.kind === 'registry') {
        await this.enableRegistryEntry(record);
      } else {
        await this.enableStartupFolderEntry(record);
      }
    } catch (error) {
      await this.cacheStore.upsertDisabledEntry(record);
      throw error;
    }

    return this.listEntries();
  }

  async deleteEntry(id: string): Promise<StartupEntry[]> {
    const [registryEntries, folderEntries] = await Promise.all([
      this.getRegistryEntries(),
      this.getStartupFolderEntries(),
    ]);

    const registryEntry = registryEntries.find((entry) => entry.id === id);
    if (registryEntry) {
      await this.disableRegistryEntry(registryEntry);
      return this.listEntries();
    }

    const folderEntry = folderEntries.find((entry) => entry.id === id);
    if (folderEntry) {
      await this.disableStartupFolderEntry(folderEntry);
      return this.listEntries();
    }

    const cachedRecord = await this.cacheStore.deleteDisabledEntry(id);
    if (!cachedRecord) {
      throw new Error('The selected startup entry could not be found.');
    }

    return this.listEntries();
  }

  private async getRegistryEntries(): Promise<RegistryEntryInternal[]> {
    const entries = await Promise.all(
      REGISTRY_LOCATIONS.map(async (location) => {
        const registryKey = `${location.hive}\\${location.path}`;

        try {
          const { stdout } = await execFile('reg', ['query', registryKey]);
          return this.parseRegistryEntries(stdout, location);
        } catch {
          return [];
        }
      }),
    );

    return entries.flat();
  }

  private parseRegistryEntries(stdout: string, location: RegistryLocation): RegistryEntryInternal[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^\s{2,}(.+?)\s+(REG_\w+)\s+(.*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => {
        const [, valueName, regType, rawCommand] = match;
        const command = rawCommand.trim();
        const split = this.splitCommand(command);
        const id = this.createId('registry', `${location.hive}|${location.path}|${valueName}`);

        return {
          id,
          name: valueName.trim(),
          command,
          executablePath: split.executablePath,
          arguments: split.arguments,
          source: 'registry' as const,
          scope: location.scope,
          location: location.label,
          state: 'enabled' as const,
          canToggle: true,
          registryHive: location.hive,
          registryPath: location.path,
          valueName: valueName.trim(),
          regType: regType.trim(),
        };
      });
  }

  private async getStartupFolderEntries(): Promise<StartupFolderEntryInternal[]> {
    const startupFolders = [
      {
        folderPath: path.join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
        scope: 'current-user' as const,
        label: 'User Startup Folder',
      },
      {
        folderPath: path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'),
        scope: 'all-users' as const,
        label: 'Common Startup Folder',
      },
    ];

    const results = await Promise.all(
      startupFolders.map(async ({ folderPath, scope, label }) => {
        try {
          const items = await readdir(folderPath, { withFileTypes: true });
          return items
            .filter((item) => item.isFile())
            .map((item) => {
              const originalPath = path.join(folderPath, item.name);
              return {
                id: this.createId('startup-folder', originalPath.toLowerCase()),
                name: path.parse(item.name).name,
                command: originalPath,
                executablePath: originalPath,
                arguments: '',
                source: 'startup-folder' as const,
                scope,
                location: label,
                state: 'enabled' as const,
                canToggle: true,
                originalPath,
              };
            });
        } catch {
          return [];
        }
      }),
    );

    return results.flat();
  }

  private async disableRegistryEntry(entry: RegistryEntryInternal): Promise<void> {
    const registryKey = `${entry.registryHive}\\${entry.registryPath}`;
    try {
      await execFile('reg', ['delete', registryKey, '/v', entry.valueName, '/f']);
    } catch (error) {
      throw this.createRegistryOperationError('disable', entry.registryHive, error);
    }

    await this.cacheStore.upsertDisabledEntry({
      kind: 'registry',
      id: entry.id,
      name: entry.name,
      command: entry.command,
      executablePath: entry.executablePath,
      arguments: entry.arguments,
      scope: entry.scope,
      location: entry.location,
      registryHive: entry.registryHive,
      registryPath: entry.registryPath,
      valueName: entry.valueName,
      regType: entry.regType,
      disabledAt: new Date().toISOString(),
    });
  }

  private async enableRegistryEntry(record: DisabledRegistryRecord): Promise<void> {
    const registryKey = `${record.registryHive}\\${record.registryPath}`;
    try {
      await execFile('reg', ['add', registryKey, '/v', record.valueName, '/t', record.regType, '/d', record.command, '/f']);
    } catch (error) {
      throw this.createRegistryOperationError('enable', record.registryHive, error);
    }
  }

  private async disableStartupFolderEntry(entry: StartupFolderEntryInternal): Promise<void> {
    const disabledItemsDir = await this.cacheStore.getDisabledItemsDir();
    await mkdir(disabledItemsDir, { recursive: true });

    const cacheFileName = `${entry.id}${path.extname(entry.originalPath)}`;
    const cachedPath = path.join(disabledItemsDir, cacheFileName);
    try {
      await rename(entry.originalPath, cachedPath);
    } catch (error) {
      throw this.createStartupFolderOperationError('disable', entry.scope, error);
    }

    await this.cacheStore.upsertDisabledEntry({
      kind: 'startup-folder',
      id: entry.id,
      name: entry.name,
      command: entry.command,
      executablePath: entry.executablePath,
      arguments: entry.arguments,
      scope: entry.scope,
      location: entry.location,
      originalPath: entry.originalPath,
      cachedPath,
      disabledAt: new Date().toISOString(),
    });
  }

  private async enableStartupFolderEntry(record: DisabledStartupFolderRecord): Promise<void> {
    await access(record.cachedPath, fsConstants.F_OK);
    try {
      await mkdir(path.dirname(record.originalPath), { recursive: true });
      await rename(record.cachedPath, record.originalPath);
    } catch (error) {
      throw this.createStartupFolderOperationError('enable', record.scope, error);
    }
  }

  private mapDisabledRecord(record: DisabledStartupRecord): StartupEntry {
    const split = this.splitCommand(record.command);
    return {
      id: record.id,
      name: record.name,
      command: record.command,
      executablePath: record.executablePath ?? split.executablePath,
      arguments: record.arguments ?? split.arguments,
      source: record.kind,
      scope: record.scope,
      location: record.location,
      state: 'disabled',
      canToggle: true,
      disabledAt: record.disabledAt,
      notes:
        record.kind === 'registry'
          ? 'Stored in cache and ready to restore.'
          : 'Moved into the WinUtils cache so it can be restored later.',
    };
  }

  private createId(kind: string, value: string): string {
    return createHash('sha1').update(`${kind}:${value}`).digest('hex');
  }

  private splitCommand(command: string): { executablePath: string; arguments: string } {
    const value = command.trim();
    if (!value) {
      return { executablePath: '', arguments: '' };
    }

    if (value.startsWith('"')) {
      const endQuote = value.indexOf('"', 1);
      if (endQuote > 1) {
        return {
          executablePath: value.slice(1, endQuote).trim(),
          arguments: value.slice(endQuote + 1).trim(),
        };
      }
    }

    const firstSpace = value.indexOf(' ');
    if (firstSpace === -1) {
      return { executablePath: value, arguments: '' };
    }

    return {
      executablePath: value.slice(0, firstSpace).trim(),
      arguments: value.slice(firstSpace + 1).trim(),
    };
  }

  private composeCommand(executablePath: string, args: string): string {
    const quotedPath = executablePath.includes(' ') && !executablePath.startsWith('"')
      ? `"${executablePath}"`
      : executablePath;

    return args ? `${quotedPath} ${args}` : quotedPath;
  }

  private createRegistryOperationError(
    operation: 'add' | 'update' | 'enable' | 'disable',
    hive: 'HKCU' | 'HKLM',
    error: unknown,
  ): Error {
    const rawMessage = this.extractErrorMessage(error);
    const looksLikeAccessDenied = this.isAccessDeniedMessage(rawMessage);

    if (hive === 'HKLM' || looksLikeAccessDenied) {
      return new AdminRequiredError(
        `Administrator permission is required to ${operation} this ${hive} startup entry.`,
      );
    }

    return new Error(`Unable to ${operation} this startup entry. ${rawMessage}`.trim());
  }

  private createStartupFolderOperationError(
    operation: 'enable' | 'disable',
    scope: StartupEntryScope,
    error: unknown,
  ): Error {
    const rawMessage = this.extractErrorMessage(error);

    if (scope === 'all-users' || this.isAccessDeniedMessage(rawMessage)) {
      return new AdminRequiredError(
        `Administrator permission is required to ${operation} this startup folder entry.`,
      );
    }

    return new Error(`Unable to ${operation} this startup folder entry. ${rawMessage}`.trim());
  }

  private isAccessDeniedMessage(message: string): boolean {
    return /access is denied|permission denied|operation requires elevation|requested operation requires elevation|\beacces\b|\beperm\b/i.test(message);
  }

  private extractErrorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return 'Unknown operation error.';
    }

    const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    if (stderr) {
      return stderr;
    }

    const message = 'message' in error && typeof error.message === 'string' ? error.message.trim() : '';
    if (message) {
      return message;
    }

    return 'Unknown operation error.';
  }
}
