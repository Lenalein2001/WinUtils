import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, clipboard as electronClipboard, globalShortcut, nativeImage } from 'electron';
import type {
  ClipboardCategory,
  ClipboardClearMode,
  ClipboardEntry,
  ClipboardEntryType,
  ClipboardFilter,
  ClipboardQuery,
  ClipboardSettings,
  ClipboardState,
} from '../shared/clipboard';

const execFile = promisify(execFileCallback);

const CLIPBOARD_POLL_MS = 700;
const CLIPBOARD_TEXT_LIMIT = 500_000;
const IMAGE_OCR_SIZE_LIMIT = 8 * 1024 * 1024;
const THUMBNAIL_MAX_WIDTH = 220;
const THUMBNAIL_MAX_HEIGHT = 150;
const DEFAULT_SETTINGS: ClipboardSettings = {
  monitoring: true,
  captureImages: true,
  imageOcr: true,
  quickAccessHotkey: 'Ctrl+Alt+V',
  maxEntries: 350,
};
const QUICK_ACCESS_FALLBACK_HOTKEY = 'Ctrl+Shift+Alt+V';
const AVAILABLE_CATEGORIES: ClipboardCategory[] = ['plain-text', 'url', 'email', 'code', 'file-path', 'image'];

interface ClipboardHistoryFile {
  version: 1;
  settings: ClipboardSettings;
  entries: ClipboardEntry[];
}

interface ClipboardManagerOptions {
  onStateChanged?: () => void;
  onQuickAccess?: () => void;
}

interface ClipboardSnapshot {
  type: ClipboardEntryType;
  hash: string;
  text?: string;
  filePaths?: string[];
  imageBuffer?: Buffer;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

const WINDOWS_OCR_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ImagePath)) {
  throw "Image file does not exist: $ImagePath"
}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
function Await-WinRt($operation, [Type]$resultType, [string]$step) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  try {
    $task.Wait()
  } catch {
    if ($task.Exception -and $task.Exception.InnerException) {
      throw "$step failed: $($task.Exception.InnerException.Message)"
    }
    throw
  }
  $task.Result
}
$stream = $null
$bitmap = $null
try {
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile]) 'Open image file'
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]) 'Open image stream'
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) 'Create image decoder'
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap]) 'Decode OCR bitmap'
  $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($bitmap.PixelWidth -gt $maxDimension -or $bitmap.PixelHeight -gt $maxDimension) {
    throw "Image is too large for Windows OCR."
  }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    throw "No Windows OCR language is available for the current user."
  }
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]) 'Recognize text'
  $result.Text
} finally {
  if ($null -ne $bitmap -and $bitmap -is [System.IDisposable]) {
    $bitmap.Dispose()
  }
  if ($null -ne $stream -and $stream -is [System.IDisposable]) {
    $stream.Dispose()
  }
}
`;

export class ClipboardManager {
  private cache: ClipboardHistoryFile | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private lastSignature: string | null = null;
  private quickAccessRegistered = false;
  private registeredQuickAccessHotkey: string | null = null;
  private registeredQuickAccessHotkeys: string[] = [];
  private quickAccessRegistrationError: string | null = null;
  private lastQuickAccessAt: string | null = null;
  private readonly activeOcrTasks = new Set<string>();

  constructor(private readonly options: ClipboardManagerOptions = {}) {}

  async init(): Promise<void> {
    await this.load();
    this.startPolling();
    this.registerQuickAccessShortcut();
    await this.captureNow();
  }

  destroy(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }

    for (const accelerator of this.registeredQuickAccessHotkeys) {
      globalShortcut.unregister(accelerator);
    }

    this.quickAccessRegistered = false;
    this.registeredQuickAccessHotkey = null;
    this.registeredQuickAccessHotkeys = [];
  }

  async getState(query: ClipboardQuery = {}): Promise<ClipboardState> {
    const file = await this.load();
    const entries = this.applyQuery(file.entries, query);

    return {
      entries,
      total: file.entries.length,
      pinnedCount: file.entries.filter((entry) => entry.pinned).length,
      textCount: file.entries.filter((entry) => entry.type === 'text').length,
      imageCount: file.entries.filter((entry) => entry.type === 'image').length,
      fileCount: file.entries.filter((entry) => entry.type === 'files').length,
      settings: file.settings,
      quickAccessRegistered: this.quickAccessRegistered,
      registeredQuickAccessHotkey: this.registeredQuickAccessHotkey,
      registeredQuickAccessHotkeys: this.registeredQuickAccessHotkeys,
      quickAccessRegistrationError: this.quickAccessRegistrationError,
      lastQuickAccessAt: this.lastQuickAccessAt,
      availableCategories: AVAILABLE_CATEGORIES,
    };
  }

  async captureNow(): Promise<ClipboardState> {
    await this.captureClipboard();
    return this.getState();
  }

  async setMonitoring(enabled: boolean): Promise<ClipboardState> {
    const file = await this.load();
    file.settings = { ...file.settings, monitoring: enabled };
    await this.save(file);
    this.notifyStateChanged();
    return this.getState();
  }

  async setCaptureImages(enabled: boolean): Promise<ClipboardState> {
    const file = await this.load();
    file.settings = { ...file.settings, captureImages: enabled };
    await this.save(file);
    this.notifyStateChanged();
    return this.getState();
  }

  async setImageOcr(enabled: boolean): Promise<ClipboardState> {
    const file = await this.load();
    file.settings = { ...file.settings, imageOcr: enabled };
    await this.save(file);

    if (enabled) {
      for (const entry of file.entries) {
        if (entry.type === 'image' && entry.image && (!entry.ocrText || entry.ocrStatus === 'none' || entry.ocrStatus === 'unsupported' || entry.ocrStatus === 'error')) {
          entry.ocrStatus = 'pending';
          entry.ocrError = undefined;
          void this.runOcr(entry.id, this.imagePath(entry.image.fileName));
        }
      }
      await this.save(file);
    }

    this.notifyStateChanged();
    return this.getState();
  }

  async setPinned(id: string, pinned: boolean): Promise<ClipboardState> {
    const file = await this.load();
    const entry = file.entries.find((item) => item.id === id);

    if (!entry) {
      throw new Error('Clipboard entry could not be found.');
    }

    entry.pinned = pinned;
    entry.updatedAt = new Date().toISOString();
    await this.save(file);
    this.notifyStateChanged();
    return this.getState();
  }

  async copyEntry(id: string): Promise<ClipboardState> {
    const file = await this.load();
    const entry = file.entries.find((item) => item.id === id);

    if (!entry) {
      throw new Error('Clipboard entry could not be found.');
    }

    if (entry.type === 'image') {
      if (!entry.image) throw new Error('The selected image clipboard entry is missing its stored image.');
      const image = nativeImage.createFromPath(this.imagePath(entry.image.fileName));
      if (image.isEmpty()) throw new Error('The stored clipboard image could not be read.');
      electronClipboard.writeImage(image);
    } else if (entry.type === 'files') {
      electronClipboard.writeText((entry.filePaths ?? []).join('\n'));
    } else {
      electronClipboard.writeText(entry.text ?? '');
    }

    const now = new Date().toISOString();
    entry.lastUsedAt = now;
    entry.updatedAt = now;
    entry.useCount += 1;
    this.lastSignature = entry.hash;
    await this.save(file);
    this.notifyStateChanged();
    return this.getState();
  }

  async rerunOcr(id: string): Promise<ClipboardState> {
    const file = await this.load();
    const entry = file.entries.find((item) => item.id === id);

    if (!entry || entry.type !== 'image' || !entry.image) {
      throw new Error('Select an image clipboard entry before running OCR.');
    }

    entry.ocrStatus = 'pending';
    entry.ocrError = undefined;
    await this.save(file);
    void this.runOcr(entry.id, this.imagePath(entry.image.fileName));
    this.notifyStateChanged();
    return this.getState();
  }

  async deleteEntry(id: string): Promise<ClipboardState> {
    const file = await this.load();
    const entry = file.entries.find((item) => item.id === id);

    if (!entry) {
      return this.getState();
    }

    file.entries = file.entries.filter((item) => item.id !== id);
    await this.deleteEntryImage(entry);
    await this.save(file);
    this.notifyStateChanged();
    return this.getState();
  }

  async clear(mode: ClipboardClearMode): Promise<ClipboardState> {
    const file = await this.load();
    const removed = mode === 'all' ? file.entries : file.entries.filter((entry) => !entry.pinned);
    file.entries = mode === 'all' ? [] : file.entries.filter((entry) => entry.pinned);

    await Promise.all(removed.map((entry) => this.deleteEntryImage(entry)));
    await this.save(file);
    this.lastSignature = null;
    this.notifyStateChanged();
    return this.getState();
  }

  async openQuickAccess(): Promise<ClipboardState> {
    this.triggerQuickAccess();
    return this.getState();
  }

  private get historyDir(): string {
    return path.join(app.getPath('userData'), 'clipboard-history');
  }

  private get imagesDir(): string {
    return path.join(this.historyDir, 'images');
  }

  private get filePath(): string {
    return path.join(this.historyDir, 'history.json');
  }

  private imagePath(fileName: string): string {
    return path.join(this.imagesDir, fileName);
  }

  private get ocrScriptPath(): string {
    return path.join(this.historyDir, 'windows-ocr.ps1');
  }

  private startPolling(): void {
    if (this.pollHandle) return;

    this.pollHandle = setInterval(() => {
      void this.captureClipboard();
    }, CLIPBOARD_POLL_MS);
  }

  private registerQuickAccessShortcut(): void {
    for (const accelerator of this.registeredQuickAccessHotkeys) {
      globalShortcut.unregister(accelerator);
    }

    const settings = this.cache?.settings ?? DEFAULT_SETTINGS;
    const candidates = buildQuickAccessCandidates(settings.quickAccessHotkey);
    let lastError: string | null = null;

    this.quickAccessRegistered = false;
    this.registeredQuickAccessHotkey = null;
    this.registeredQuickAccessHotkeys = [];
    this.quickAccessRegistrationError = null;

    for (const accelerator of candidates) {
      try {
        if (globalShortcut.register(accelerator, () => this.triggerQuickAccess())) {
          this.registeredQuickAccessHotkeys.push(accelerator);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.quickAccessRegistered = this.registeredQuickAccessHotkeys.length > 0;
    this.registeredQuickAccessHotkey = this.registeredQuickAccessHotkeys[0] ?? null;

    if (this.quickAccessRegistered) {
      return;
    }

    const preferred = candidates[0] ?? DEFAULT_SETTINGS.quickAccessHotkey;
    this.quickAccessRegistrationError = lastError ?? `${formatAccelerator(preferred)} is already used by another app or Windows.`;
  }

  private triggerQuickAccess(): void {
    this.lastQuickAccessAt = new Date().toISOString();
    this.options.onQuickAccess?.();
    this.notifyStateChanged();
  }

  private async captureClipboard(): Promise<void> {
    const file = await this.load();
    if (!file.settings.monitoring) return;

    const snapshot = await this.readClipboardSnapshot(file.settings);
    if (!snapshot || snapshot.hash === this.lastSignature) return;

    this.lastSignature = snapshot.hash;
    const duplicate = file.entries.find((entry) => entry.hash === snapshot.hash);

    if (duplicate) {
      duplicate.copiedAt = new Date().toISOString();
      duplicate.updatedAt = duplicate.copiedAt;
      file.entries = [duplicate, ...file.entries.filter((entry) => entry.id !== duplicate.id)];
      await this.save(file);
      this.notifyStateChanged();
      return;
    }

    const entry = await this.createEntry(snapshot, file.settings);
    file.entries = [entry, ...file.entries];
    await this.pruneEntries(file);
    await this.save(file);

    if (entry.type === 'image' && entry.image && entry.ocrStatus === 'pending') {
      void this.runOcr(entry.id, this.imagePath(entry.image.fileName));
    }

    this.notifyStateChanged();
  }

  private async readClipboardSnapshot(settings: ClipboardSettings): Promise<ClipboardSnapshot | null> {
    const filePaths = readClipboardFilePaths();
    if (filePaths.length > 0) {
      const text = filePaths.join('\n');
      return {
        type: 'files',
        hash: hashContent('files', text),
        text,
        filePaths,
        sizeBytes: Buffer.byteLength(text, 'utf8'),
      };
    }

    if (settings.captureImages) {
      const image = electronClipboard.readImage();
      if (!image.isEmpty()) {
        const png = image.toPNG();
        if (png.length > 0) {
          const size = image.getSize();
          return {
            type: 'image',
            hash: hashContent('image', png),
            imageBuffer: png,
            width: size.width,
            height: size.height,
            sizeBytes: png.length,
          };
        }
      }
    }

    const rawText = electronClipboard.readText().trim();
    if (!rawText) return null;

    const text = rawText.length > CLIPBOARD_TEXT_LIMIT ? rawText.slice(0, CLIPBOARD_TEXT_LIMIT) : rawText;
    const detectedPaths = detectExistingFilePaths(text);
    const type: ClipboardEntryType = detectedPaths.length > 0 && detectedPaths.join('\n') === text ? 'files' : 'text';

    return {
      type,
      hash: hashContent(type, text),
      text,
      filePaths: detectedPaths.length > 0 ? detectedPaths : undefined,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
    };
  }

  private async createEntry(snapshot: ClipboardSnapshot, settings: ClipboardSettings): Promise<ClipboardEntry> {
    const now = new Date().toISOString();
    const baseEntry: ClipboardEntry = {
      id: randomUUID(),
      type: snapshot.type,
      categories: [],
      preview: '',
      text: snapshot.text,
      filePaths: snapshot.filePaths,
      ocrStatus: 'none',
      hash: snapshot.hash,
      pinned: false,
      copiedAt: now,
      updatedAt: now,
      useCount: 0,
      sizeBytes: snapshot.sizeBytes,
    };

    if (snapshot.type === 'image' && snapshot.imageBuffer) {
      await mkdir(this.imagesDir, { recursive: true });
      const fileName = `${baseEntry.id}.png`;
      const imagePath = this.imagePath(fileName);
      await writeFile(imagePath, snapshot.imageBuffer);
      const image = nativeImage.createFromBuffer(snapshot.imageBuffer);
      baseEntry.image = {
        width: snapshot.width ?? image.getSize().width,
        height: snapshot.height ?? image.getSize().height,
        fileName,
        thumbnailDataUrl: createThumbnailDataUrl(image),
      };
      baseEntry.ocrStatus = settings.imageOcr && snapshot.imageBuffer.length <= IMAGE_OCR_SIZE_LIMIT ? 'pending' : 'none';
      if (!settings.imageOcr) {
        baseEntry.ocrError = 'Image OCR is turned off.';
      } else if (snapshot.imageBuffer.length > IMAGE_OCR_SIZE_LIMIT) {
        baseEntry.ocrError = 'Image is above the automatic OCR size limit. Use Retry OCR to try it manually.';
      }
    }

    baseEntry.categories = detectCategories(baseEntry);
    baseEntry.preview = createPreview(baseEntry);
    return baseEntry;
  }

  private async runOcr(entryId: string, imagePath: string): Promise<void> {
    if (this.activeOcrTasks.has(entryId)) return;
    this.activeOcrTasks.add(entryId);

    try {
      const file = await this.load();
      const entry = file.entries.find((item) => item.id === entryId);
      if (!entry) return;
      entry.ocrStatus = 'pending';
      entry.ocrError = undefined;
      entry.updatedAt = new Date().toISOString();
      await this.save(file);
      this.notifyStateChanged();

      const scriptPath = await this.ensureOcrScript();
      const { stdout } = await execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, imagePath],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );

      const text = stdout.trim();
      const nextFile = await this.load();
      const nextEntry = nextFile.entries.find((item) => item.id === entryId);
      if (!nextEntry) return;

      nextEntry.ocrText = text || undefined;
      nextEntry.ocrStatus = 'complete';
      nextEntry.ocrError = undefined;
      nextEntry.updatedAt = new Date().toISOString();
      nextEntry.categories = detectCategories(nextEntry);
      nextEntry.preview = createPreview(nextEntry);
      await this.save(nextFile);
      this.notifyStateChanged();
    } catch (error) {
      const file = await this.load();
      const entry = file.entries.find((item) => item.id === entryId);
      if (!entry) return;

      entry.ocrStatus = 'error';
      entry.ocrError = commandErrorMessage(error);
      entry.updatedAt = new Date().toISOString();
      await this.save(file);
      this.notifyStateChanged();
    } finally {
      this.activeOcrTasks.delete(entryId);
    }
  }

  private async ensureOcrScript(): Promise<string> {
    await mkdir(this.historyDir, { recursive: true });
    await writeFile(this.ocrScriptPath, WINDOWS_OCR_SCRIPT, 'utf8');
    return this.ocrScriptPath;
  }

  private async pruneEntries(file: ClipboardHistoryFile): Promise<void> {
    const pinned = file.entries.filter((entry) => entry.pinned);
    const unpinned = file.entries.filter((entry) => !entry.pinned);
    const keep = [...pinned, ...unpinned.slice(0, file.settings.maxEntries)];
    const keepIds = new Set(keep.map((entry) => entry.id));
    const removed = file.entries.filter((entry) => !keepIds.has(entry.id));

    await Promise.all(removed.map((entry) => this.deleteEntryImage(entry)));
    file.entries = sortEntries(keep);
  }

  private async deleteEntryImage(entry: ClipboardEntry): Promise<void> {
    if (!entry.image) return;

    try {
      await unlink(this.imagePath(entry.image.fileName));
    } catch {
      // Missing image files should not block history cleanup.
    }
  }

  private applyQuery(entries: ClipboardEntry[], query: ClipboardQuery): ClipboardEntry[] {
    const filter = query.filter ?? 'all';
    const type = query.type ?? 'all';
    const search = query.search?.trim().toLowerCase() ?? '';
    const limit = Math.max(1, Math.min(query.limit ?? 120, 500));

    return sortEntries(entries)
      .filter((entry) => filter === 'all' || (filter === 'pinned' ? entry.pinned : entry.categories.includes(filter)))
      .filter((entry) => type === 'all' || entry.type === type)
      .filter((entry) => !search || searchableText(entry).includes(search))
      .slice(0, limit);
  }

  private async load(): Promise<ClipboardHistoryFile> {
    if (this.cache) return this.cache;

    await mkdir(this.historyDir, { recursive: true });
    await mkdir(this.imagesDir, { recursive: true });

    if (!existsSync(this.filePath)) {
      this.cache = { version: 1, settings: DEFAULT_SETTINGS, entries: [] };
      await this.save(this.cache);
      return this.cache;
    }

    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ClipboardHistoryFile>;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.map(normalizeEntry).filter((entry): entry is ClipboardEntry => entry !== null)
        : [];
      const loadedFile: ClipboardHistoryFile = {
        version: 1,
        settings: normalizeSettings(parsed.settings),
        entries,
      };
      this.cache = loadedFile;
      return this.cache;
    } catch {
      this.cache = { version: 1, settings: DEFAULT_SETTINGS, entries: [] };
      await this.save(this.cache);
      return this.cache;
    }
  }

  private async save(file: ClipboardHistoryFile): Promise<void> {
    this.cache = file;
    await mkdir(this.historyDir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  private notifyStateChanged(): void {
    this.options.onStateChanged?.();
  }
}

function normalizeSettings(settings: Partial<ClipboardSettings> | undefined): ClipboardSettings {
  return {
    monitoring: settings?.monitoring ?? DEFAULT_SETTINGS.monitoring,
    captureImages: settings?.captureImages ?? DEFAULT_SETTINGS.captureImages,
    imageOcr: settings?.imageOcr ?? DEFAULT_SETTINGS.imageOcr,
    quickAccessHotkey: normalizeQuickAccessHotkey(settings?.quickAccessHotkey),
    maxEntries: Number.isFinite(settings?.maxEntries) ? Math.max(50, Math.min(Number(settings?.maxEntries), 1000)) : DEFAULT_SETTINGS.maxEntries,
  };
}

function buildQuickAccessCandidates(preferredHotkey: string): string[] {
  return Array.from(new Set([
    normalizeQuickAccessHotkey(preferredHotkey),
    QUICK_ACCESS_FALLBACK_HOTKEY,
  ]));
}

function normalizeQuickAccessHotkey(hotkey: string | undefined): string {
  const value = hotkey?.trim() || DEFAULT_SETTINGS.quickAccessHotkey;
  return value
    .replace(/CommandOrControl|CmdOrCtrl/gi, process.platform === 'darwin' ? 'Command' : 'Ctrl')
    .replace(/Control/gi, 'Ctrl');
}

function formatAccelerator(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, process.platform === 'darwin' ? 'Command' : 'Ctrl')
    .replace(/Control/gi, 'Ctrl');
}

function normalizeEntry(entry: ClipboardEntry): ClipboardEntry | null {
  if (!entry || typeof entry.id !== 'string' || typeof entry.hash !== 'string') return null;

  return {
    ...entry,
    categories: Array.isArray(entry.categories) ? entry.categories : ['plain-text'],
    preview: entry.preview || createPreview(entry),
    ocrStatus: entry.ocrStatus ?? 'none',
    pinned: Boolean(entry.pinned),
    copiedAt: entry.copiedAt || new Date().toISOString(),
    updatedAt: entry.updatedAt || entry.copiedAt || new Date().toISOString(),
    useCount: Number.isFinite(entry.useCount) ? entry.useCount : 0,
  };
}

function sortEntries(entries: ClipboardEntry[]): ClipboardEntry[] {
  return [...entries].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return Date.parse(right.copiedAt) - Date.parse(left.copiedAt);
  });
}

function createThumbnailDataUrl(image: Electron.NativeImage): string | undefined {
  const size = image.getSize();
  if (!size.width || !size.height) return undefined;

  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / size.width, THUMBNAIL_MAX_HEIGHT / size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  return image.resize({ width, height, quality: 'good' }).toDataURL();
}

function readClipboardFilePaths(): string[] {
  const paths = new Set<string>();
  appendNullSeparatedBuffer(paths, safeReadBuffer('FileNameW'), 'utf16le');
  appendNullSeparatedBuffer(paths, safeReadBuffer('FileName'), 'latin1');
  return Array.from(paths).filter(Boolean);
}

function safeReadBuffer(format: string): Buffer {
  try {
    return electronClipboard.readBuffer(format);
  } catch {
    return Buffer.alloc(0);
  }
}

function appendNullSeparatedBuffer(paths: Set<string>, buffer: Buffer, encoding: BufferEncoding): void {
  if (buffer.length === 0) return;

  const decoded = buffer.toString(encoding).replace(/\0+$/g, '');
  for (const item of decoded.split('\0').map((value) => value.trim()).filter(Boolean)) {
    paths.add(item);
  }
}

function detectExistingFilePaths(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 200) return [];

  const pathLike = lines.filter((line) => /^(?:[a-zA-Z]:\\|\\\\|~?\/)/.test(line));
  if (pathLike.length !== lines.length) return [];

  return pathLike.filter((line) => existsSync(line));
}

function detectCategories(entry: ClipboardEntry): ClipboardCategory[] {
  const categories = new Set<ClipboardCategory>();
  const text = `${entry.text ?? ''}\n${entry.ocrText ?? ''}`.trim();

  if (entry.type === 'image') categories.add('image');
  if (entry.filePaths?.length || /(?:[a-zA-Z]:\\|\\\\)[^\r\n]+/.test(text)) categories.add('file-path');
  if (/\b(?:https?:\/\/|www\.)\S+/i.test(text)) categories.add('url');
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) categories.add('email');
  if (looksLikeCode(text)) categories.add('code');
  if (categories.size === 0) categories.add('plain-text');

  return Array.from(categories);
}

function looksLikeCode(text: string): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return false;

  return /(?:\b(?:import|export|const|let|var|function|class|interface|type|return|if|else|for|while|def|public|private|using|namespace)\b|=>|[{};]|<\/[a-z][\s\S]*>)/i.test(text);
}

function createPreview(entry: ClipboardEntry): string {
  if (entry.type === 'image') {
    const dimensions = entry.image ? `${entry.image.width} x ${entry.image.height}` : 'image';
    return entry.ocrText ? compactText(entry.ocrText, 220) : `Image ${dimensions}`;
  }

  if (entry.type === 'files') {
    const paths = entry.filePaths ?? [];
    const firstNames = paths.slice(0, 3).map((filePath) => path.basename(filePath)).join(', ');
    const suffix = paths.length > 3 ? `, +${paths.length - 3} more` : '';
    return firstNames ? `${firstNames}${suffix}` : compactText(entry.text ?? '', 220);
  }

  return compactText(entry.text ?? '', 260);
}

function searchableText(entry: ClipboardEntry): string {
  return [
    entry.preview,
    entry.text,
    entry.ocrText,
    ...(entry.filePaths ?? []),
    ...entry.categories,
  ].filter(Boolean).join('\n').toLowerCase();
}

function compactText(text: string, limit: number): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  return compacted.length > limit ? `${compacted.slice(0, limit - 1)}...` : compacted;
}

function hashContent(type: ClipboardEntryType, content: string | Buffer): string {
  return createHash('sha256').update(type).update('\0').update(content).digest('hex');
}

function commandErrorMessage(error: unknown): string {
  const output = getCommandOutput(error);
  if (output) return simplifyPowerShellError(output);
  if (error instanceof Error) return simplifyPowerShellError(error.message);
  return String(error);
}

function getCommandOutput(error: unknown): string {
  const commandError = error as { stderr?: string | Buffer; stdout?: string | Buffer };
  return [commandError.stderr, commandError.stdout]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : value ?? '')
    .map((value) => value.trim())
    .find(Boolean) ?? '';
}

function simplifyPowerShellError(output: string): string {
  const lines = output
    .replace(/Command failed:[\s\S]*?(?=\r?\n|$)/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('+') && !/^At .*:\d+ char:\d+/i.test(line))
    .filter((line) => !/^CategoryInfo\s*:/i.test(line) && !/^FullyQualifiedErrorId\s*:/i.test(line));

  return (lines[0] ?? output).replace(/\s+/g, ' ').trim();
}