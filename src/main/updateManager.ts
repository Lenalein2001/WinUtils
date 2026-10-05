import { app, BrowserWindow, shell } from 'electron';
import { createRequire } from 'node:module';
import { verifiedPublisher } from './updateTrust';
import { verifyReleaseInstaller, verifyInstallerBytes, type VerifiedInstaller } from './updateArtifact';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { AppUpdateInfo, UpdateDownloadProgress, UpdateInstallMode, UpdateState, UpdateStatus } from '../shared/updater';

const requireUpdater = createRequire(import.meta.url);
const { autoUpdater, CancellationToken } = requireUpdater('electron-updater') as typeof import('electron-updater');

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
  private checking: Promise<UpdateState> | null = null;
  private downloading: Promise<UpdateState> | null = null;
  private downloadToken: import('electron-updater').CancellationToken | null = null;
  private publisherCheck: Promise<string | null> | null = null;
  private publisher: string | null = null;
  private downloadVerified = false;
  private verifiedInstaller: VerifiedInstaller | null = null;
  private downloadVerification: Promise<void> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  private ensurePublisher(): Promise<string | null> {
    if (!this.publisherCheck) this.publisherCheck = verifiedPublisher(process.execPath)
      .then(subject => { this.publisher = subject; return subject; }).catch(() => null);
    return this.publisherCheck;
  }

  constructor(private readonly beforeInstall: () => void | Promise<void>) {}

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.getInstallMode() !== 'installer') return;
    void this.ensurePublisher().then(() => this.broadcast());

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: null, progress: null }));
    autoUpdater.on('update-available', (info) => this.setState({ status: 'available', update: this.fromElectronUpdateInfo(info), error: null, progress: null }));
    autoUpdater.on('update-not-available', () => this.setState({ status: 'not-available', update: null, error: null, progress: null }));
    autoUpdater.on('download-progress', (progress) => {
      if (this.downloadToken && !this.downloadToken.cancelled) this.setState({ status: 'downloading', progress: this.fromProgressInfo(progress), error: null });
    });
    autoUpdater.on('update-downloaded', (info) => {
      const token = this.downloadToken;
      if (!token || token.cancelled) return;
      this.downloadVerification = (async () => {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        token.once('cancel', cancel);
        let installer: VerifiedInstaller;
        try {
          installer = await verifyReleaseInstaller(info.downloadedFile, info.version, controller.signal);
          if (this.publisher && await verifiedPublisher(info.downloadedFile) !== this.publisher) {
            throw new Error('Update publisher could not be verified against the installed application. Use the GitHub release page.');
          }
        } finally {
          token.removeListener('cancel', cancel);
        }
        if (token.cancelled) return;
        this.verifiedInstaller = installer;
        this.downloadVerified = true;
        this.setState({ status: 'downloaded', update: this.fromElectronUpdateInfo(info), progress: null, error: null });
      })().catch(error => { if (!token.cancelled) this.setError(error); });
    });
    autoUpdater.on('error', (error) => { if (!this.downloadToken?.cancelled) this.setError(error); });
  }

  scheduleStartupCheck(): void {
    if (!app.isPackaged) return;

    this.startupTimer = setTimeout(() => {
      void this.checkForUpdates().catch(() => undefined);
    }, 45_000);
  }

  dispose(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (this.status === 'downloading') this.downloadToken?.cancel();
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
      canInstall: installMode === 'installer' && this.status === 'downloaded' && this.downloadVerified,
      automaticUpdates: installMode === 'installer',
    };
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (this.downloading || this.status === 'downloaded') return this.getState();
    if (!this.checking) this.checking = this.checkInternal().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async checkInternal(): Promise<UpdateState> {
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
        await this.ensurePublisher();
        await autoUpdater.checkForUpdates();
      }
    } catch (error) {
      this.setError(error);
    }

    return this.getState();
  }

  async downloadUpdate(): Promise<UpdateState> {
    if (this.downloading) return this.downloading;
    if (this.status !== 'available') throw new Error('Check for an available update before downloading.');
    this.downloading = this.downloadInternal().finally(() => { this.downloading = null; });
    return this.downloading;
  }

  async cancelDownload(): Promise<UpdateState> {
    if (this.downloadToken) {
      this.downloadToken.cancel();
      this.setState({ status: 'available', progress: null, error: null });
    }
    return this.getState();
  }

  private async downloadInternal(): Promise<UpdateState> {
    const installMode = this.getInstallMode();

    if (installMode === 'portable') {
      if (this.update?.downloadUrl) await shell.openExternal(this.update.downloadUrl);
      return this.getState();
    }

    if (installMode !== 'installer') {
      throw new Error('Updates can only be downloaded from packaged builds.');
    }
    await this.ensurePublisher();

    const token = new CancellationToken();
    this.downloadVerified = false; this.downloadVerification = null;
    this.verifiedInstaller = null;
    this.downloadToken = token;
    this.setState({ status: 'downloading', progress: null, error: null });
    const deadline = setTimeout(() => {
      token.cancel(); this.setError(new Error('Update download timed out. Retry from Settings.'));
    }, 600_000);

    try {
      await autoUpdater.downloadUpdate(token);
      if (this.downloadVerification) await this.downloadVerification;
    } catch (error) {
      if (!token.cancelled) this.setError(error);
    } finally {
      clearTimeout(deadline);
      if (this.downloadToken === token) this.downloadToken = null;
    }

    return this.getState();
  }

  async installUpdate(): Promise<UpdateState> {
    if (this.getInstallMode() !== 'installer') throw new Error('Only installed builds can apply updates in-app.');
    if (this.status !== 'downloaded') throw new Error('No downloaded update is ready to install.');
    if (!this.downloadVerified || !this.verifiedInstaller) throw new Error('Update installer has not been verified.');
    try {
      await verifyInstallerBytes(this.verifiedInstaller);
      if (this.publisher && await verifiedPublisher(this.verifiedInstaller.path) !== this.publisher) {
        throw new Error('Update publisher changed. Download it again.');
      }
    } catch (error) {
      this.downloadVerified = false;
      this.setError(error);
      throw error;
    }

    await this.beforeInstall();
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
      signal: AbortSignal.timeout(15_000),
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
      releaseUrl: validateReleaseUrl(release.html_url ?? GITHUB_RELEASES_URL),
      downloadUrl: validateReleaseUrl(portableAsset?.browser_download_url ?? release.html_url ?? GITHUB_RELEASES_URL),
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

function validateReleaseUrl(value: string): string {
  const url = new URL(value);
  const prefix = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
    || url.username || url.password || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error('Update response contains an untrusted release URL.');
  }
  return url.href;
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
