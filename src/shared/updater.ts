export type UpdateInstallMode = 'development' | 'installer' | 'portable';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface AppUpdateInfo {
  version: string;
  releaseName: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
}

export interface UpdateDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateState {
  currentVersion: string;
  status: UpdateStatus;
  installMode: UpdateInstallMode;
  update: AppUpdateInfo | null;
  progress: UpdateDownloadProgress | null;
  error: string | null;
  lastCheckedAt: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
}