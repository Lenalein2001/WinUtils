import { app, BrowserWindow, dialog, ipcMain, nativeImage, Tray } from 'electron';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StartupCacheStore } from './cacheStore';
import { FocusAudioManager } from './focusAudioManager';
import { registerFocusAudioIpcHandlers } from './focusAudioIpc';
import { registerIpcHandlers } from './ipc';
import { AppSettingsStore } from './appSettingsStore';
import { applyAppLoginItemSettings, getAppLaunchAtLogin } from './loginItem';
import { MacroManager, registerMacroIpcHandlers } from './macroManager';
import { registerPlayitIpcHandlers } from './playitIpc';
import { PlayitManager } from './playitManager';
import { registerSettingsIpcHandlers } from './settingsIpc';
import { StartupManager } from './startupManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startupLogFile = path.join(tmpdir(), 'WinUtils-startup.log');

let mainWindow: BrowserWindow | null = null;
let trayWindow: BrowserWindow | null = null;
let appTray: Tray | null = null;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  logStartup('Another instance already has the single-instance lock. Exiting.');
  app.quit();
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');

process.on('uncaughtException', (error) => {
  logStartup('uncaughtException', error);
  dialog.showErrorBox('WinUtils Startup Error', error.stack ?? error.message);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logStartup('unhandledRejection', message);
  dialog.showErrorBox('WinUtils Startup Error', message);
});

function logStartup(message: string, details?: unknown): void {
  const detailText =
    details instanceof Error
      ? details.stack ?? details.message
      : typeof details === 'string'
        ? details
        : details === undefined
          ? ''
          : JSON.stringify(details);

  const line = `[${new Date().toISOString()}] ${message}${detailText ? ` | ${detailText}` : ''}\n`;

  try {
    appendFileSync(startupLogFile, line, 'utf8');
  } catch {
    // Ignore logging write errors to avoid startup recursion.
  }
}

function getIconPath(filename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', filename);
  }
  return path.join(__dirname, '../../resources', filename);
}

function buildTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(getIconPath('icon.png'));
}

async function createTrayWindow(preloadPath: string): Promise<void> {
  trayWindow = new BrowserWindow({
    width: 232,
    height: 104,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await trayWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#tray`);
  } else {
    const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
    await trayWindow.loadFile(rendererHtmlPath, { hash: 'tray' });
  }

  trayWindow.on('blur', () => {
    trayWindow?.hide();
  });

  trayWindow.on('closed', () => {
    trayWindow = null;
  });
}

function setupTray(preloadPath: string, settingsStore: AppSettingsStore): void {
  const icon = buildTrayIcon();
  appTray = new Tray(icon);
  appTray.setToolTip('WinUtils');

  void createTrayWindow(preloadPath);

  appTray.on('click', () => {
    if (!trayWindow) return;

    if (trayWindow.isVisible()) {
      trayWindow.hide();
      return;
    }

    const trayBounds = appTray!.getBounds();
    const winBounds = trayWindow.getBounds();
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
    const y = Math.round(trayBounds.y - winBounds.height - 4);
    trayWindow.setPosition(x, y, false);
    trayWindow.show();
    trayWindow.focus();
  });

  ipcMain.handle('tray:show-main', () => {
    trayWindow?.hide();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.handle('tray:quit', () => {
    appTray?.destroy();
    app.quit();
  });

  if (mainWindow) {
    mainWindow.on('close', (event) => {
      if (settingsStore.get().closeToTray) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });

    (mainWindow as NodeJS.EventEmitter).on('minimize', () => {
      if (settingsStore.get().minimizeToTray) {
        mainWindow?.hide();
      }
    });
  }
}

async function createWindow(startMinimized: boolean): Promise<void> {
  const preloadPath = path.join(__dirname, '../preload/index.js');
  logStartup('Creating BrowserWindow', { preloadPath });

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 760,
    center: true,
    show: !startMinimized,
    backgroundColor: '#07111f',
    title: 'WinUtils',
    icon: getIconPath('icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
    },
  });

  mainWindow.once('ready-to-show', () => {
    logStartup('Window ready-to-show fired.');
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logStartup('Renderer process gone', details);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          logStartup('Reloading renderer after crash.');
          mainWindow.reload();
        }
      }, 1500);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logStartup('did-fail-load', { errorCode, errorDescription, validatedURL });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    logStartup('Loading renderer from dev server URL', process.env.ELECTRON_RENDERER_URL);
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
    logStartup('Loading renderer from file', rendererHtmlPath);
    await mainWindow.loadFile(rendererHtmlPath);
  }

  if (startMinimized) {
    mainWindow.minimize();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }

  mainWindow.on('closed', () => {
    logStartup('Main window closed.');
    mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  logStartup('Bootstrap started.');
  await app.whenReady();
  logStartup('Electron app is ready.');

  const cacheStore = new StartupCacheStore();
  logStartup('Cache store created (lazy initialization enabled).');

  const startupManager = new StartupManager(cacheStore);
  registerIpcHandlers(startupManager);

  const settingsStore = new AppSettingsStore();
  registerSettingsIpcHandlers(settingsStore);
  const loadedSettings = await settingsStore.load();
  const launchAtLogin = getAppLaunchAtLogin();
  const settings = { ...loadedSettings, launchAtLogin };

  if (loadedSettings.launchAtLogin !== launchAtLogin) {
    await settingsStore.save(settings);
  }

  if (launchAtLogin) {
    applyAppLoginItemSettings(settings);
  }

  const macroManager = new MacroManager();
  registerMacroIpcHandlers(macroManager);
  macroManager.init().catch(err => logStartup('MacroManager init error', err));

  const focusAudioManager = new FocusAudioManager();
  registerFocusAudioIpcHandlers(focusAudioManager);
  focusAudioManager.startPolling();

  const playitManager = new PlayitManager();
  registerPlayitIpcHandlers(playitManager);
  logStartup('IPC handlers registered.');

  app.on('second-instance', () => {
    logStartup('Second instance event received.');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  const preloadPath = path.join(__dirname, '../preload/index.js');

  try {
    const loginState = app.getLoginItemSettings();
    const hasMinimizedArg = process.argv.includes('--minimized');
    const shouldStartMinimized = settings.startMinimized && (hasMinimizedArg || Boolean(loginState.wasOpenedAtLogin));
    await createWindow(shouldStartMinimized);
    setupTray(preloadPath, settingsStore);
  } catch (error) {
    logStartup('Failed to create main window.', error);
    console.error('Failed to create the main window.', error);
    dialog.showErrorBox('WinUtils Startup Error', error instanceof Error ? error.stack ?? error.message : String(error));
    app.quit();
    return;
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await createWindow(false);
      } catch (error) {
        logStartup('Failed to recreate main window.', error);
        console.error('Failed to re-create the main window.', error);
        dialog.showErrorBox('WinUtils Startup Error', error instanceof Error ? error.stack ?? error.message : String(error));
        app.quit();
      }
    }
  });

  app.on('before-quit', () => {
    focusAudioManager.stopPolling();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

bootstrap().catch((error) => {
  logStartup('Bootstrap failed.', error);
  console.error('Failed to start WinUtils', error);
  dialog.showErrorBox('WinUtils Startup Error', error instanceof Error ? error.stack ?? error.message : String(error));
  app.quit();
});