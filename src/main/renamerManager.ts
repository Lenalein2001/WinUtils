import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { isMissingFile, SerialTaskQueue, writeJsonAtomically } from './atomicFile';
import { RenameTransactionRunner } from './renameTransactionRunner';
import type {
  RenameApplyResult,
  RenameIssue,
  RenamePreview,
  RenamePreviewRow,
  RenameRule,
  RenameTransaction,
  RenameTransactionOperation,
  RenameUndoResult,
  RenamerItem,
  RenamerLoadOptions,
  RenamerLoadPathsInput,
  RenamerPreviewInput,
  RenamerTransactionFile,
} from '../shared/renamer';

const WINDOWS_INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PATH_WARNING_LENGTH = 240;
const MAX_PATH_ERROR_LENGTH = 260;
const ITEM_STAT_CONCURRENCY = 32;
const DIRECTORY_SCAN_CONCURRENCY = 6;

class RenamerTransactionStore {
  private cache: RenamerTransactionFile | null = null;

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'renamer-transactions.json');
  }

  async list(): Promise<RenameTransaction[]> {
    const file = await this.load();
    return file.transactions;
  }

  async add(transaction: RenameTransaction): Promise<void> {
    const file = await this.load();
    await this.save({ ...file, transactions: [transaction, ...file.transactions.filter(item => item.id !== transaction.id)].slice(0, 50) });
  }

  async markUndone(transactionId: string, undoneAt: string): Promise<RenameTransaction> {
    const file = await this.load();
    const transaction = file.transactions.find((item) => item.id === transactionId);

    if (!transaction) {
      throw new Error('The selected rename transaction could not be found.');
    }

    const updated = { ...transaction, undoneAt };
    await this.save({ ...file, transactions: file.transactions.map(item => item.id === transactionId ? updated : item) });
    return updated;
  }

  private async load(): Promise<RenamerTransactionFile> {
    if (this.cache) return this.cache;

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RenamerTransactionFile>;
      if (parsed?.version !== 1 || !Array.isArray(parsed.transactions)
        || !parsed.transactions.every(transaction => typeof transaction.id === 'string'
          && Array.isArray(transaction.operations)
          && transaction.operations.every(operation => typeof operation.fromPath === 'string'
            && typeof operation.toPath === 'string' && path.isAbsolute(operation.fromPath)
            && path.isAbsolute(operation.toPath)))) {
        throw new Error('Invalid rename history. The original file has been preserved.');
      }
      this.cache = parsed as RenamerTransactionFile;
      return this.cache;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cache = { version: 1, transactions: [] };
      return this.cache;
    }
  }

  private async save(file: RenamerTransactionFile): Promise<void> {
    await writeJsonAtomically(this.filePath, file);
    this.cache = file;
  }
}

export class RenamerManager {
  private readonly transactionStore = new RenamerTransactionStore();
  private readonly mutations = new SerialTaskQueue();
  private readonly runner = new RenameTransactionRunner(
    path.join(app.getPath('userData'), 'rename-journal.json'),
    async journal => {
      if (journal.undo) {
        await this.transactionStore.markUndone(journal.transaction.id, journal.transaction.undoneAt!);
      } else {
        await this.transactionStore.add(journal.transaction);
      }
    },
  );

  init(): Promise<void> {
    return this.mutations.run(() => this.runner.recover());
  }

  async loadPaths(input: RenamerLoadPathsInput): Promise<RenamerItem[]> {
    const seen = new Set<string>();
    const items: RenamerItem[] = [];
    const selectedPaths = input.paths.map((rawPath) => rawPath.trim()).filter(Boolean);

    await runWithConcurrency(selectedPaths, DIRECTORY_SCAN_CONCURRENCY, async (selectedPath) => {
      await this.collectSelectedPath(selectedPath, input, items, seen);
    });

    return this.sortItems(items);
  }

  async preview(input: RenamerPreviewInput): Promise<RenamePreview> {
    const selectedPaths = new Set(input.items.map((item) => normalizePathKey(item.path)));
    const rows: RenamePreviewRow[] = input.items.map((item, index) => {
      const applied = applyRules(item, input.rules, index);
      const targetName = applied.name;
      const targetPath = path.join(item.directory, targetName);
      const issues = [...applied.issues, ...validateTargetName(item, targetName, targetPath)];

      return {
        id: item.id,
        path: item.path,
        directory: item.directory,
        kind: item.kind,
        originalName: item.name,
        targetName,
        targetPath,
        status: 'ready',
        issues,
      };
    });

    this.addDuplicateTargetIssues(rows);
    this.addExistingTargetIssues(rows, selectedPaths);
    this.addNestedFolderIssues(rows);

    let changed = 0;
    let unchanged = 0;
    let warnings = 0;
    let errors = 0;
    let conflicts = 0;

    for (const row of rows) {
      if (row.targetName === row.originalName) {
        unchanged += 1;
      } else {
        changed += 1;
      }

      if (row.issues.some((issue) => issue.message.toLowerCase().includes('conflict') || issue.message.toLowerCase().includes('already exists'))) {
        conflicts += 1;
      }

      if (row.issues.some((issue) => issue.severity === 'error')) {
        row.status = 'error';
        errors += 1;
      } else if (row.issues.some((issue) => issue.severity === 'warning')) {
        row.status = 'warning';
        warnings += 1;
      } else if (row.targetName === row.originalName) {
        row.status = 'unchanged';
      } else {
        row.status = 'ready';
      }
    }

    return {
      rows,
      counts: {
        total: rows.length,
        changed,
        unchanged,
        warnings,
        errors,
        conflicts,
      },
    };
  }

  async apply(input: RenamerPreviewInput): Promise<RenameApplyResult> {
    return this.mutations.run(async () => {
      await this.runner.recover();
      return this.applyInternal(input);
    });
  }

  private async applyInternal(input: RenamerPreviewInput): Promise<RenameApplyResult> {
    // Never mutate files when their undo history cannot be read and preserved.
    await this.transactionStore.list();
    const preview = await this.preview(input);
    const errorRows = preview.rows.filter((row) => row.status === 'error');

    if (errorRows.length > 0) {
      throw new Error('Resolve preview errors before applying the rename batch.');
    }

    const changedRows = preview.rows.filter((row) => row.targetName !== row.originalName);

    if (changedRows.length === 0) {
      return {
        transaction: null,
        renamedCount: 0,
        items: input.items,
      };
    }

    const transactionId = randomUUID();
    const operations: RenameTransactionOperation[] = changedRows.map((row) => ({
      fromPath: row.path,
      toPath: row.targetPath,
      originalName: row.originalName,
      targetName: row.targetName,
      kind: row.kind,
    }));

    const transaction: RenameTransaction = {
      id: transactionId,
      createdAt: new Date().toISOString(),
      operations,
    };

    await this.runner.execute(transaction, operations, false);

    const nextPaths = input.items.map((item) => {
      const operation = operations.find((candidate) => normalizePathKey(candidate.fromPath) === normalizePathKey(item.path));
      return operation?.toPath ?? item.path;
    });

    return {
      transaction,
      renamedCount: operations.length,
      items: await this.loadDirectItems(nextPaths),
    };
  }

  async undo(transactionId?: string): Promise<RenameUndoResult> {
    return this.mutations.run(async () => {
      await this.runner.recover();
      return this.undoInternal(transactionId);
    });
  }

  private async undoInternal(transactionId?: string): Promise<RenameUndoResult> {
    const transactions = await this.transactionStore.list();
    const transaction = transactionId
      ? transactions.find((item) => item.id === transactionId)
      : transactions.find((item) => !item.undoneAt);

    if (!transaction) {
      throw new Error('No rename transaction is available to undo.');
    }

    if (transaction.undoneAt) {
      throw new Error('This rename transaction was already undone.');
    }

    const restoreOperations = [...transaction.operations].reverse().map(operation => ({
      ...operation,
      fromPath: operation.toPath,
      toPath: operation.fromPath,
      originalName: operation.targetName,
      targetName: operation.originalName,
    }));
    const updatedTransaction = { ...transaction, undoneAt: new Date().toISOString() };
    await this.runner.execute(updatedTransaction, restoreOperations, true);

    return {
      transaction: updatedTransaction,
      restoredCount: transaction.operations.length,
      items: await this.loadDirectItems(transaction.operations.map((operation) => operation.fromPath)),
    };
  }

  async listTransactions(): Promise<RenameTransaction[]> {
    return this.mutations.run(async () => {
      await this.runner.recover();
      return this.transactionStore.list();
    });
  }

  private async collectSelectedPath(
    selectedPath: string,
    options: RenamerLoadOptions,
    items: RenamerItem[],
    seen: Set<string>,
  ): Promise<void> {
    let stats;

    try {
      stats = await stat(selectedPath);
    } catch {
      return;
    }

    if (stats.isFile()) {
      await this.pushItem(selectedPath, items, seen);
      return;
    }

    if (stats.isDirectory()) {
      await this.collectDirectoryContents(selectedPath, options, items, seen);
    }
  }

  private async collectDirectoryContents(
    directoryPath: string,
    options: RenamerLoadOptions,
    items: RenamerItem[],
    seen: Set<string>,
  ): Promise<void> {
    let entries;

    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    const filePaths: string[] = [];
    const directoryPaths: string[] = [];

    for (const entry of entries) {
      const childPath = path.join(directoryPath, entry.name);

      if (entry.isFile()) {
        filePaths.push(childPath);
        continue;
      }

      if (entry.isDirectory()) {
        directoryPaths.push(childPath);
      }
    }

    await this.pushItems(filePaths, items, seen);

    if (options.includeFolders) {
      await this.pushItems(directoryPaths, items, seen);
    }

    if (options.recursive) {
      await runWithConcurrency(directoryPaths, DIRECTORY_SCAN_CONCURRENCY, async (childPath) => {
        await this.collectDirectoryContents(childPath, options, items, seen);
      });
    }
  }

  private async loadDirectItems(paths: string[]): Promise<RenamerItem[]> {
    const seen = new Set<string>();
    const items: RenamerItem[] = [];

    await this.pushItems(paths, items, seen);

    return this.sortItems(items);
  }

  private async pushItems(itemPaths: string[], items: RenamerItem[], seen: Set<string>): Promise<void> {
    await runWithConcurrency(itemPaths, ITEM_STAT_CONCURRENCY, async (itemPath) => {
      await this.pushItem(itemPath, items, seen);
    });
  }

  private async pushItem(itemPath: string, items: RenamerItem[], seen: Set<string>): Promise<void> {
    const key = normalizePathKey(itemPath);
    if (seen.has(key)) return;
    seen.add(key);

    let stats;

    try {
      stats = await stat(itemPath);
    } catch {
      return;
    }

    if (!stats.isFile() && !stats.isDirectory()) return;

    const name = path.basename(itemPath);
    const extension = stats.isDirectory() ? '' : path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;

    items.push({
      id: createStableId(itemPath),
      path: itemPath,
      directory: path.dirname(itemPath),
      name,
      stem,
      extension,
      kind: stats.isDirectory() ? 'folder' : 'file',
      size: stats.size,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  private sortItems(items: RenamerItem[]): RenamerItem[] {
    return [...items].sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
  }

  private addDuplicateTargetIssues(rows: RenamePreviewRow[]): void {
    const byTarget = new Map<string, RenamePreviewRow[]>();

    for (const row of rows) {
      const key = normalizePathKey(row.targetPath);
      const group = byTarget.get(key) ?? [];
      group.push(row);
      byTarget.set(key, group);
    }

    for (const group of byTarget.values()) {
      if (group.length < 2) continue;

      for (const row of group) {
        row.issues.push({ severity: 'error', message: 'Target name conflict inside this batch.' });
      }
    }
  }

  private addExistingTargetIssues(rows: RenamePreviewRow[], selectedPaths: Set<string>): void {
    for (const row of rows) {
      const targetKey = normalizePathKey(row.targetPath);
      const sourceKey = normalizePathKey(row.path);

      if (targetKey === sourceKey || selectedPaths.has(targetKey)) continue;

      if (existsSync(row.targetPath)) {
        row.issues.push({ severity: 'error', message: 'Target already exists on disk.' });
      }
    }
  }

  private addNestedFolderIssues(rows: RenamePreviewRow[]): void {
    const folderRows = rows.filter((row) => row.kind === 'folder' && row.targetName !== row.originalName);

    for (const folderRow of folderRows) {
      const folderKey = normalizePathKey(folderRow.path + path.sep);
      const hasDescendant = rows.some((row) => row.path !== folderRow.path && normalizePathKey(row.path).startsWith(folderKey));

      if (hasDescendant) {
        folderRow.issues.push({
          severity: 'error',
          message: 'Rename folders with selected descendants in a separate batch.',
        });
      }
    }
  }

}

function applyRules(item: RenamerItem, rules: RenameRule[], index: number): { name: string; issues: RenameIssue[] } {
  let stem = item.stem;
  let extension = item.extension;
  const issues: RenameIssue[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    try {
      switch (rule.type) {
        case 'find-replace': {
          if (!rule.find) break;
          if (rule.useRegex) {
            const flags = rule.caseSensitive ? 'g' : 'gi';
            stem = stem.replace(new RegExp(rule.find, flags), rule.replace);
          } else if (rule.caseSensitive) {
            stem = stem.split(rule.find).join(rule.replace);
          } else {
            stem = stem.replace(new RegExp(escapeRegExp(rule.find), 'gi'), rule.replace);
          }
          break;
        }
        case 'prefix-suffix':
          stem = `${rule.prefix}${stem}${rule.suffix}`;
          break;
        case 'case':
          stem = applyCase(stem, rule.mode);
          break;
        case 'spaces':
          stem = applySpaces(stem, rule.mode);
          break;
        case 'trim':
          stem = stem.slice(Math.max(0, rule.start), Math.max(Math.max(0, rule.start), stem.length - Math.max(0, rule.end)));
          break;
        case 'clear-name':
          stem = '';
          break;
        case 'numbering': {
          const number = String(rule.start + index * rule.increment).padStart(Math.max(0, rule.padding), '0');
          const separator = stem ? rule.separator : '';
          stem = rule.position === 'prefix'
            ? `${number}${separator}${stem}`
            : `${stem}${separator}${number}`;
          break;
        }
        case 'extension': {
          if (item.kind === 'folder') break;
          const nextExtension = rule.extension.trim();
          extension = nextExtension ? `.${nextExtension.replace(/^\.+/, '')}` : '';
          break;
        }
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Rule failed while building this preview.',
      });
    }
  }

  return {
    name: `${stem}${extension}`,
    issues,
  };
}

function validateTargetName(item: RenamerItem, targetName: string, targetPath: string): RenameIssue[] {
  const issues: RenameIssue[] = [];
  const baseName = item.kind === 'file' ? targetName.slice(0, targetName.length - path.extname(targetName).length) : targetName;

  if (!targetName.trim()) {
    issues.push({ severity: 'error', message: 'Target name cannot be empty.' });
  }

  if (WINDOWS_INVALID_FILENAME_CHARS.test(targetName)) {
    issues.push({ severity: 'error', message: 'Target name contains invalid Windows characters.' });
  }

  if (targetName.endsWith(' ') || targetName.endsWith('.')) {
    issues.push({ severity: 'error', message: 'Target name cannot end with a space or period.' });
  }

  if (WINDOWS_RESERVED_NAMES.test(baseName)) {
    issues.push({ severity: 'error', message: 'Target name is reserved by Windows.' });
  }

  if (targetPath.length > MAX_PATH_ERROR_LENGTH) {
    issues.push({ severity: 'error', message: 'Target path is longer than the classic Windows path limit.' });
  } else if (targetPath.length > MAX_PATH_WARNING_LENGTH) {
    issues.push({ severity: 'warning', message: 'Target path is close to the Windows path limit.' });
  }

  return issues;
}

function applyCase(value: string, mode: 'lower' | 'upper' | 'title'): string {
  if (mode === 'lower') return value.toLowerCase();
  if (mode === 'upper') return value.toUpperCase();

  return value
    .toLowerCase()
    .replace(/(^|[\s_-])([a-z0-9])/g, (_match, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`);
}

function applySpaces(value: string, mode: 'underscore' | 'hyphen' | 'remove' | 'collapse'): string {
  if (mode === 'underscore') return value.replace(/\s+/g, '_');
  if (mode === 'hyphen') return value.replace(/\s+/g, '-');
  if (mode === 'remove') return value.replace(/\s+/g, '');
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createStableId(value: string): string {
  return createHash('sha1').update(value.toLowerCase()).digest('hex');
}

function normalizePathKey(value: string): string {
  return path.normalize(value).toLowerCase();
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }));
}
