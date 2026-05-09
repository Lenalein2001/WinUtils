import { app } from 'electron';
import type { AppSettings } from '../shared/settings';

const LOGIN_ITEM_NAME = 'Winutils';
const LEGACY_LOGIN_ITEM_NAMES = ['electron.app.WinUtils', 'WinUtils'];

type WindowsLoginItem = {
  name?: string;
  enabled?: boolean;
};

function getLoginArgs(startMinimized: boolean): string[] {
  return startMinimized ? ['--minimized'] : [];
}

function isWinutilsLoginItem(item: WindowsLoginItem): boolean {
  return item.name === LOGIN_ITEM_NAME || LEGACY_LOGIN_ITEM_NAMES.includes(item.name ?? '');
}

export function getAppLaunchAtLogin(): boolean {
  const login = app.getLoginItemSettings();
  const launchItems = (login.launchItems ?? []) as WindowsLoginItem[];
  const hasNamedItem = launchItems.some((item) => isWinutilsLoginItem(item) && item.enabled !== false);

  return hasNamedItem || Boolean(login.openAtLogin);
}

export function applyAppLoginItemSettings(settings: Pick<AppSettings, 'launchAtLogin' | 'startMinimized'>): void {
  app.setLoginItemSettings({ openAtLogin: false });

  for (const name of [LOGIN_ITEM_NAME, ...LEGACY_LOGIN_ITEM_NAMES]) {
    app.setLoginItemSettings({ openAtLogin: false, name });
  }

  if (!settings.launchAtLogin) return;

  app.setLoginItemSettings({
    openAtLogin: true,
    name: LOGIN_ITEM_NAME,
    args: getLoginArgs(settings.startMinimized),
  });
}