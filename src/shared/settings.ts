export interface AppSettings {
  launchAtLogin: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
}

export const defaultAppSettings: AppSettings = {
  launchAtLogin: false,
  startMinimized: false,
  minimizeToTray: false,
  closeToTray: false,
};
