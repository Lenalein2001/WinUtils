export type AppTheme = 'winutils-blue' | 'sable-night' | 'sable-ember';

export interface AppSettings {
  launchAtLogin: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  theme: AppTheme;
}

export const defaultAppSettings: AppSettings = {
  launchAtLogin: false,
  startMinimized: false,
  minimizeToTray: false,
  closeToTray: false,
  theme: 'winutils-blue',
};
