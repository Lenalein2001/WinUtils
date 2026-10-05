import { writeJsonAtomicallySync } from './atomicFile';
import { SerialTaskQueue } from './atomicFile';
import { quoteWindowsArgument } from './windowsArguments';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, clipboard, Notification } from 'electron';
import type { ActionEngine } from './actionEngine';
import type {
  ExplorerContextActionId,
  ExplorerContextEntry,
  ExplorerContextMenuState,
  ExplorerContextMenuUpdate,
  ExplorerContextTarget,
} from '../shared/contextMenu';

const execFileAsync = promisify(execFile);
const FILE_ROOT = 'HKCU\\Software\\Classes\\*\\shell\\WinUtils';
const FOLDER_ROOT = 'HKCU\\Software\\Classes\\Directory\\shell\\WinUtils';

const ENTRY_DEFINITIONS: Array<Omit<ExplorerContextEntry, 'enabled'>> = [
  {
    actionId: 'copy-path',
    label: 'Copy path',
    description: 'Copy the selected file or folder path',
    targets: ['files', 'folders'],
  },
  {
    actionId: 'hash-sha256',
    label: 'Copy SHA-256',
    description: 'Calculate a SHA-256 file hash and copy it',
    targets: ['files'],
  },
  {
    actionId: 'open-terminal',
    label: 'Open terminal here',
    description: 'Open PowerShell in the selected folder',
    targets: ['folders'],
  },
];

export class ContextMenuManager {
  private readonly configPath = path.join(app.getPath('userData'), 'explorer-context-menu.json');
  private entries: ExplorerContextEntry[];
  private lastError: string | null = null;
  private readonly mutations = new SerialTaskQueue();

  constructor(private readonly actions: ActionEngine) {
    this.entries = this.readConfig();
    this.registerActions();
  }

  async getState(): Promise<ExplorerContextMenuState> {
    return {
      installed: await registryKeyExists(FILE_ROOT) || await registryKeyExists(FOLDER_ROOT),
      entries: structuredClone(this.entries),
      executablePath: contextMenuExecutablePath(),
      error: this.lastError,
    };
  }

  async update(input: ExplorerContextMenuUpdate): Promise<ExplorerContextMenuState> {
    if (!input || !Array.isArray(input.entries) || input.entries.length > ENTRY_DEFINITIONS.length
      || input.entries.some(entry => !entry || !isContextActionId(entry.actionId) || typeof entry.enabled !== 'boolean')
      || new Set(input.entries.map(entry => entry.actionId)).size !== input.entries.length) {
      throw new Error('Invalid Explorer context-menu settings.');
    }
    const requested = new Map(input.entries.map(entry => [entry.actionId, entry.enabled]));
    return this.mutations.run(async () => {
      const previous = this.entries;
      const next = ENTRY_DEFINITIONS.map(definition => ({
        ...definition,
        enabled: requested.get(definition.actionId) ?? false,
      }));
      try {
        await this.applyRegistry(next);
        this.persist(next);
        this.entries = next;
      } catch (error) {
        try { await this.applyRegistry(previous); }
        catch (rollback) { this.lastError = `Settings retained, but Explorer rollback failed: ${String(rollback)}`; throw new Error(`${String(error)}; ${this.lastError}`); }
        this.lastError = String(error);
        throw error;
      }
      return this.getState();
    });
  }

  async uninstall(): Promise<ExplorerContextMenuState> {
    return this.update({ entries: ENTRY_DEFINITIONS.map(entry => ({ actionId: entry.actionId, enabled: false })) });
  }

  async handleArguments(argv: string[]): Promise<boolean> {
    const actionValue = readArgument(argv, '--context-action=');
    const targetPath = readArgument(argv, '--context-path=');
    if (!actionValue && !targetPath) return false;
    if (!isContextActionId(actionValue)) throw new Error('Explorer requested an unsupported WinUtils context action.');
    if (!targetPath) throw new Error('Explorer did not provide a target path.');
    const entry = this.entries.find(item => item.actionId === actionValue);
    if (!entry?.enabled) throw new Error('This Explorer context action is disabled.');

    const result = await this.actions.execute({
      actionId: `explorer.${actionValue}`,
      parameters: { path: targetPath },
    });
    if (!result.ok) throw new Error(result.error ?? 'Explorer context action failed.');
    return true;
  }

  private async applyRegistry(entries: ExplorerContextEntry[]): Promise<void> {
    try {
      await removeRegistryTree(FILE_ROOT);
      await removeRegistryTree(FOLDER_ROOT);
      for (const target of ['files', 'folders'] as const) {
        const enabled = entries.filter(entry => entry.enabled && entry.targets.includes(target));
        if (!enabled.length) continue;
        const root = target === 'files' ? FILE_ROOT : FOLDER_ROOT;
        await addRegistryValue(root, 'MUIVerb', 'WinUtils');
        await addRegistryValue(root, 'Icon', contextMenuExecutablePath());
        await addRegistryValue(root, 'SubCommands', '');
        for (const entry of enabled) {
          const key = `${root}\\shell\\${entry.actionId}`;
          await addRegistryValue(key, 'MUIVerb', entry.label);
          await addRegistryDefault(`${key}\\command`, buildExplorerCommand(entry.actionId));
        }
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private registerActions(): void {
    this.actions.replaceOwnerActions('explorer-actions', [
      {
        definition: {
          id: 'explorer.copy-path',
          ownerId: 'explorer-actions',
          ownerLabel: 'Explorer',
          label: 'Copy path',
          description: 'Copy a local file or folder path',
          category: 'file',
          keywords: ['explorer', 'copy', 'path', 'file', 'folder'],
          parameters: [{ id: 'path', label: 'Path', type: 'string', required: true }],
        },
        handler: parameters => {
          const targetPath = requiredPath(parameters);
          clipboard.writeText(targetPath);
        },
      },
      {
        definition: {
          id: 'explorer.hash-sha256',
          ownerId: 'explorer-actions',
          ownerLabel: 'Explorer',
          label: 'Copy file SHA-256',
          description: 'Calculate a local file SHA-256 hash and copy it',
          category: 'file',
          keywords: ['explorer', 'hash', 'sha256', 'checksum', 'file'],
          parameters: [{ id: 'path', label: 'File path', type: 'string', required: true }],
        },
        handler: async parameters => {
          const targetPath = requiredPath(parameters, 'file');
          const hash = await hashFile(targetPath);
          clipboard.writeText(hash);
          if (Notification.isSupported()) {
            new Notification({ title: 'WinUtils', body: `SHA-256 copied for ${path.basename(targetPath)}` }).show();
          }
        },
      },
      {
        definition: {
          id: 'explorer.open-terminal',
          ownerId: 'explorer-actions',
          ownerLabel: 'Explorer',
          label: 'Open terminal here',
          description: 'Open PowerShell in a local folder',
          category: 'file',
          keywords: ['explorer', 'terminal', 'powershell', 'folder'],
          parameters: [{ id: 'path', label: 'Folder path', type: 'string', required: true }],
        },
        handler: parameters => {
          const targetPath = requiredPath(parameters, 'folder');
          const child = spawn('powershell.exe', ['-NoExit', '-Command', 'Set-Location -LiteralPath $env:WINUTILS_CONTEXT_PATH'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            env: { ...process.env, WINUTILS_CONTEXT_PATH: targetPath },
          });
          child.unref();
        },
      },
    ]);
  }

  private readConfig(): ExplorerContextEntry[] {
    let enabled = new Set<ExplorerContextActionId>();
    try {
      if (fs.existsSync(this.configPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as { enabled?: unknown };
        if (!Array.isArray(parsed.enabled) || parsed.enabled.length > 3 || parsed.enabled.some(id => !isContextActionId(id))) throw new Error('Invalid Explorer settings schema.');
        enabled = new Set(parsed.enabled as ExplorerContextActionId[]);
      }
    } catch (error) {
      throw new Error(`Could not read Explorer context-menu settings; the original file was preserved. ${String(error)}`);
    }
    return ENTRY_DEFINITIONS.map(definition => ({ ...definition, enabled: enabled.has(definition.actionId) }));
  }

  private persist(entries: ExplorerContextEntry[]): void {
    writeJsonAtomicallySync(this.configPath, { enabled: entries.filter(entry => entry.enabled).map(entry => entry.actionId) });
  }
}

async function registryKeyExists(key: string): Promise<boolean> {
  try {
    await execFileAsync('reg.exe', ['query', key], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    return true;
  } catch {
    return false;
  }
}

async function removeRegistryTree(key: string): Promise<void> {
  if (!await registryKeyExists(key)) return;
  await execFileAsync('reg.exe', ['delete', key, '/f'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
}

async function addRegistryValue(key: string, name: string, value: string): Promise<void> {
  await execFileAsync('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
}

async function addRegistryDefault(key: string, value: string): Promise<void> {
  await execFileAsync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
}

function buildExplorerCommand(actionId: ExplorerContextActionId): string {
  const command = [quoteArgument(contextMenuExecutablePath())];
  if (process.defaultApp) command.push(quoteArgument(app.getAppPath()));
  command.push(`--context-action=${actionId}`, '--context-path="%1"');
  return command.join(' ');
}

function contextMenuExecutablePath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE?.trim() || process.execPath;
}

function quoteArgument(value: string): string {
  return quoteWindowsArgument(value);
}

function readArgument(argv: string[], prefix: string): string {
  return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function isContextActionId(value: unknown): value is ExplorerContextActionId {
  return value === 'copy-path' || value === 'hash-sha256' || value === 'open-terminal';
}

function requiredPath(parameters: Record<string, unknown>, expected?: 'file' | 'folder'): string {
  const targetPath = parameters.path;
  if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('Path is required.');
  const resolved = path.resolve(targetPath.trim());
  if (!fs.existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
  if (expected) {
    const stat = fs.statSync(resolved);
    if (expected === 'file' && !stat.isFile()) throw new Error('The selected path is not a file.');
    if (expected === 'folder' && !stat.isDirectory()) throw new Error('The selected path is not a folder.');
  }
  return resolved;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
