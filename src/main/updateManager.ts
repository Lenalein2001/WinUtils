import { app, BrowserWindow, shell } from 'electron';
import { createRequire } from 'node:module';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { AppUpdateInfo, UpdateDownloadProgress, UpdateInstallMode, UpdateState, UpdateStatus } from '../shared/updater';

const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

const GITHUB_OWNER = 'Lenalein2001';
const GITHUB_REPO = 'WinUtils';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_LATEST_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string | null;
  published_at?: string | null;
  assets?: GitHubReleaseAsset[];
}

interface UpdateStatePatch {
  status?: UpdateStatus;
  update?: AppUpdateInfo | null;
  progress?: UpdateDownloadProgress | null;
  error?: string | null;
}

export class UpdateManager {
  private status: UpdateStatus = 'idle';
  private update: AppUpdateInfo | null = null;
  private progress: UpdateDownloadProgress | null = null;
  private error: string | null = null;
  private lastCheckedAt: string | null = null;
  private initialized = false;

  constructor(private readonly beforeInstall: () => void) {}

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.getInstallMode() !== 'installer') return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: null, progress: null }));
    autoUpdater.on('update-available', (info) => this.setState({ status: 'available', update: this.fromElectronUpdateInfo(info), error: null, progress: null }));
    autoUpdater.on('update-not-available', () => this.setState({ status: 'not-available', update: null, error: null, progress: null }));
    autoUpdater.on('download-progress', (progress) => this.setState({ status: 'downloading', progress: this.fromProgressInfo(progress), error: null }));
    autoUpdater.on('update-downloaded', (info) => this.setState({ status: 'downloaded', update: this.fromElectronUpdateInfo(info), progress: null, error: null }));
    autoUpdater.on('error', (error) => this.setError(error));
  }

  scheduleStartupCheck(): void {
    if (!app.isPackaged) return;

    setTimeout(() => {
      void this.checkForUpdates().catch(() => undefined);
    }, 45_000);
  }

  getState(): UpdateState {
    const installMode = this.getInstallMode();
    const busy = this.status === 'checking' || this.status === 'downloading';

    return {
      currentVersion: app.getVersion(),
      status: this.status,
      installMode,
      update: this.update,
      progress: this.progress,
      error: this.error,
      lastCheckedAt: this.lastCheckedAt,
      canCheck: installMode !== 'development' && !busy,
      canDownload: this.status === 'available' && !busy && (installMode === 'installer' || Boolean(this.update?.downloadUrl)),
      canInstall: installMode === 'installer' && this.status === 'downloaded',
    };
  }

  async checkForUpdates(): Promise<UpdateState> {
    const installMode = this.getInstallMode();

    if (installMode === 'development') {
      this.setState({ status: 'not-available', error: 'Update checks are available in packaged builds only.', progress: null });
      return this.getState();
    }

    this.lastCheckedAt = new Date().toISOString();
    this.setState({ status: 'checking', error: null, progress: null });

    try {
      if (installMode === 'portable') {
        await this.checkPortableRelease();
      } else {
        await autoUpdater.checkForUpdates();
      }
    } catch (error) {
      this.setError(error);
    }

    return this.getState();
  }

  async downloadUpdate(): Promise<UpdateState> {
    const installMode = this.getInstallMode();

    if (installMode === 'portable') {
      if (this.update?.downloadUrl) await shell.openExternal(this.update.downloadUrl);
      return this.getState();
    }

    if (installMode !== 'installer') {
      throw new Error('Updates can only be downloaded from packaged builds.');
    }

    this.setState({ status: 'downloading', progress: null, error: null });

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.setError(error);
    }

    return this.getState();
  }

  async installUpdate(): Promise<UpdateState> {
    if (this.getInstallMode() !== 'installer') throw new Error('Only installed builds can apply updates in-app.');
    if (this.status !== 'downloaded') throw new Error('No downloaded update is ready to install.');

    this.beforeInstall();
    autoUpdater.quitAndInstall(true, true);
    return this.getState();
  }

  async openReleasePage(): Promise<void> {
    await shell.openExternal(this.update?.releaseUrl ?? GITHUB_RELEASES_URL);
  }

  async getLatestRelease(): Promise<AppUpdateInfo> {
    return this.fromGitHubRelease(await this.fetchLatestRelease());
  }

  async getReleaseHistory(): Promise<AppUpdateInfo[]> {
    const releases: GitHubRelease[] = [];

    for (let page = 1; page <= 10; page += 1) {
      const pageReleases = await this.fetchReleasesPage(page);
      releases.push(...pageReleases);
      if (pageReleases.length < 100) break;
    }

    return releases.map((release) => this.fromGitHubRelease(release));
  }

  private async checkPortableRelease(): Promise<void> {
    const update = this.fromGitHubRelease(await this.fetchLatestRelease());

    if (compareVersions(update.version, app.getVersion()) <= 0) {
      this.setState({ status: 'not-available', update: null, progress: null, error: null });
      return;
    }

    this.setState({
      status: 'available',
      update,
      progress: null,
      error: null,
    });
  }

  private async fetchLatestRelease(): Promise<GitHubRelease> {
    return await this.fetchGitHubRelease(GITHUB_LATEST_API_URL) as GitHubRelease;
  }

  private async fetchReleasesPage(page: number): Promise<GitHubRelease[]> {
    const url = `${GITHUB_RELEASES_API_URL}?per_page=100&page=${page}`;
    const releases = await this.fetchGitHubRelease(url);
    if (!Array.isArray(releases)) throw new Error('GitHub release history returned an invalid response.');
    return releases as GitHubRelease[];
  }

  private async fetchGitHubRelease(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'WinUtils',
      },
    });

    if (!response.ok) throw new Error(`GitHub update check failed with HTTP ${response.status}.`);

    return await response.json() as unknown;
  }

  private fromGitHubRelease(release: GitHubRelease): AppUpdateInfo {
    const version = normalizeVersion(release.tag_name ?? '');
    if (!version) throw new Error('GitHub latest release did not include a version tag.');

    const portableAsset = release.assets?.find((asset) => /portable\.exe$/i.test(asset.name ?? ''));
    return {
      version,
      releaseName: release.name ?? null,
      releaseDate: release.published_at ?? null,
      releaseNotes: release.body ?? null,
      releaseUrl: release.html_url ?? GITHUB_RELEASES_URL,
      downloadUrl: portableAsset?.browser_download_url ?? release.html_url ?? GITHUB_RELEASES_URL,
    };
  }

  private fromElectronUpdateInfo(info: UpdateInfo): AppUpdateInfo {
    return {
      version: info.version,
      releaseName: typeof info.releaseName === 'string' ? info.releaseName : null,
      releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : null,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseUrl: GITHUB_RELEASES_URL,
      downloadUrl: null,
    };
  }

  private fromProgressInfo(progress: ProgressInfo): UpdateDownloadProgress {
    return {
      percent: Number.isFinite(progress.percent) ? progress.percent : 0,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    };
  }

  private setState(patch: UpdateStatePatch): void {
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.update !== undefined) this.update = patch.update;
    if (patch.progress !== undefined) this.progress = patch.progress;
    if (patch.error !== undefined) this.error = patch.error;
    this.broadcast();
  }

  private setError(error: unknown): void {
    this.setState({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      progress: null,
    });
  }

  private broadcast(): void {
    const state = this.getState();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('updates:state', state);
    }
  }

  private getInstallMode(): UpdateInstallMode {
    if (!app.isPackaged) return 'development';
    return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installer';
  }
}

function normalizeReleaseNotes(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const notes = value
    .map((entry) => typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'note' in entry ? String(entry.note) : '')
    .map((note) => note.trim())
    .filter(Boolean);

  return notes.length ? notes.join('\n\n') : null;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
}
