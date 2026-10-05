import { drainIpcRequests, handleTrustedIpc, protectAppWindow, rendererDocumentUrl, stopAcceptingIpc } from './ipcSecurity';
import { createShutdown } from './shutdown';
import { createOptionalModule } from './optionalModule';
import { app, BrowserWindow, dialog, nativeImage, screen, Tray } from 'electron';
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAlwaysActiveIpcHandlers } from './alwaysActiveIpc';
import { AlwaysActiveManager } from './alwaysActiveManager';
import { ActionEngine } from './actionEngine';
import { registerAutomationIpcHandlers, registerAutomationSafetyIpc } from './automationIpc';
import { registerAutomationTriggerIpc } from './automationTriggerIpc';
import { AutomationTriggerManager } from './automationTriggerManager';
import { registerContextMenuIpc } from './contextMenuIpc';
import { ContextMenuManager } from './contextMenuManager';
import { StartupCacheStore } from './cacheStore';
import { registerClipboardIpcHandlers } from './clipboardIpc';
import { ClipboardManager } from './clipboardManager';
import { FileSyncManager } from './fileSyncManager';
import { registerFileSyncIpcHandlers } from './fileSyncIpc';
import { FocusAudioManager } from './focusAudioManager';
import { registerFocusAudioIpcHandlers } from './focusAudioIpc';
import { registerIpcHandlers } from './ipc';
import { AppSettingsStore } from './appSettingsStore';
import { applyAppLoginItemSettings, getAppLaunchAtLogin } from './loginItem';
import { HotkeyManager } from './hotkeyManager';
import { MacroManager, registerMacroIpcHandlers } from './macroManager';
import { registerRenamerIpcHandlers } from './renamerIpc';
import { RenamerManager } from './renamerManager';
import { registerSettingsIpcHandlers } from './settingsIpc';
import { StartupManager } from './startupManager';
import { registerAudioActions, registerSystemActions } from './systemActions';
import { registerUpdateIpcHandlers } from './updateIpc';
import { UpdateManager } from './updateManager';
import { registerWindowIpcHandlers } from './windowIpc';
import { WindowManager } from './windowManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = rendererDocumentUrl(path.join(__dirname, '../renderer/index.html'));
const startupLogFile = path.join(tmpdir(), 'WinUtils-startup.log');

let mainWindow: BrowserWindow | null = null;
let trayWindow: BrowserWindow | null = null;
let clipboardWindow: BrowserWindow | null = null;
let clipboardWindowCreation: Promise<BrowserWindow> | null = null;
let commandPaletteWindow: BrowserWindow | null = null;
let commandPaletteWindowCreation: Promise<BrowserWindow> | null = null;
let appTray: Tray | null = null;
let isQuitting = false;
let showMainAfterStartup = false;
let rendererCrashRetries = 0;
let handleSecondInstanceArguments: ((commandLine: string[]) => void) | null = null;
const pendingSecondInstanceArguments: string[][] = [];

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  logStartup('Another instance already has the single-instance lock. Exiting.');
  app.quit();
}

app.on('second-instance', (_event, commandLine) => {
  logStartup('Second instance event received.');
  if (handleSecondInstanceArguments) {
    handleSecondInstanceArguments(commandLine);
  } else {
    pendingSecondInstanceArguments.push(commandLine);
  }
});

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
    if (existsSync(startupLogFile) && statSync(startupLogFile).size > 1_048_576) {
      const previous = startupLogFile + '.previous';
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(startupLogFile, previous);
    }
    appendFileSync(startupLogFile, line.slice(0, 16_384) + (line.length > 16_384 ? '\n' : ''), 'utf8');
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

function showMainWindow(): void {
  if (!mainWindow) return;

  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray(): void {
  if (!mainWindow) return;

  mainWindow.hide();
  mainWindow.setSkipTaskbar(true);
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
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  protectAppWindow(trayWindow, 'tray', rendererUrl);
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await trayWindow.loadURL(`${rendererUrl}#tray`);
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

async function createClipboardWindow(preloadPath: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 430,
    height: 560,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#07111f',
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, 'pop-up-menu');
  protectAppWindow(window, 'clipboard', rendererUrl);

  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(`${rendererUrl}#clipboard-popup`);
    } else {
      const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
      await window.loadFile(rendererHtmlPath, { hash: 'clipboard-popup' });
    }
  } catch (error) {
    window.destroy();
    throw error;
  }

  clipboardWindow = window;
  window.on('blur', () => {
    window.hide();
  });
  window.on('closed', () => {
    if (clipboardWindow === window) clipboardWindow = null;
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      event.preventDefault();
      window.hide();
    }
  });

  return window;
}

async function getClipboardWindow(preloadPath: string): Promise<BrowserWindow> {
  if (clipboardWindow && !clipboardWindow.isDestroyed()) return clipboardWindow;
  if (!clipboardWindowCreation) {
    clipboardWindowCreation = createClipboardWindow(preloadPath)
      .finally(() => {
        clipboardWindowCreation = null;
      });
  }
  return clipboardWindowCreation;
}

async function showClipboardWindow(preloadPath: string): Promise<void> {
  const window = await getClipboardWindow(preloadPath);
  const cursor = screen.getCursorScreenPoint();
  const workArea = screen.getDisplayNearestPoint(cursor).workArea;
  const bounds = window.getBounds();
  const margin = 12;
  const preferredX = cursor.x - Math.round(bounds.width / 2);
  const preferredY = cursor.y + 18;
  const x = Math.max(workArea.x + margin, Math.min(preferredX, workArea.x + workArea.width - bounds.width - margin));
  const yBelow = Math.min(preferredY, workArea.y + workArea.height - bounds.height - margin);
  const y = yBelow >= cursor.y
    ? yBelow
    : Math.max(workArea.y + margin, cursor.y - bounds.height - 18);

  trayWindow?.hide();
  window.setPosition(Math.round(x), Math.round(y), false);
  window.show();
  window.focus();
  window.webContents.send('clipboard:open');
}

async function createCommandPaletteWindow(preloadPath: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 590,
    height: 450,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#07111f',
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, 'pop-up-menu');
  protectAppWindow(window, 'command-palette', rendererUrl);

  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(`${rendererUrl}#command-palette`);
    } else {
      const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
      await window.loadFile(rendererHtmlPath, { hash: 'command-palette' });
    }
  } catch (error) {
    window.destroy();
    throw error;
  }

  commandPaletteWindow = window;
  window.on('blur', () => {
    window.hide();
  });
  window.on('closed', () => {
    if (commandPaletteWindow === window) commandPaletteWindow = null;
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

async function getCommandPaletteWindow(preloadPath: string): Promise<BrowserWindow> {
  if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) return commandPaletteWindow;
  if (!commandPaletteWindowCreation) {
    commandPaletteWindowCreation = createCommandPaletteWindow(preloadPath)
      .finally(() => {
        commandPaletteWindowCreation = null;
      });
  }
  return commandPaletteWindowCreation;
}

async function showCommandPaletteWindow(preloadPath: string): Promise<void> {
  const window = await getCommandPaletteWindow(preloadPath);
  const cursor = screen.getCursorScreenPoint();
  const workArea = screen.getDisplayNearestPoint(cursor).workArea;
  const bounds = window.getBounds();
  const x = workArea.x + Math.round((workArea.width - bounds.width) / 2);
  const y = workArea.y + Math.max(32, Math.round((workArea.height - bounds.height) * 0.3));

  trayWindow?.hide();
  clipboardWindow?.hide();
  window.setPosition(x, y, false);
  window.show();
  window.focus();
  window.webContents.send('commandPalette:open');
}

function openMainModule(moduleId: string): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error('The main WinUtils window is not available.');
  }
  showMainWindow();
  window.webContents.send('navigation:openModule', moduleId);
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

  handleTrustedIpc('tray:show-main', () => {
    trayWindow?.hide();
    showMainWindow();
  });

  handleTrustedIpc('tray:quit', () => {
    isQuitting = true;
    appTray?.destroy();
    app.quit();
  });

  if (mainWindow) {
    mainWindow.on('close', (event) => {
      if (!isQuitting && settingsStore.get().closeToTray) {
        event.preventDefault();
        hideMainWindowToTray();
      }
    });

    (mainWindow as NodeJS.EventEmitter).on('minimize', (event: { preventDefault(): void }) => {
      if (settingsStore.get().minimizeToTray) {
        event.preventDefault();
        hideMainWindowToTray();
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
    skipTaskbar: startMinimized,
    backgroundColor: '#07111f',
    title: 'WinUtils',
    icon: getIconPath('icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    logStartup('Window ready-to-show fired.');
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logStartup('Renderer process gone', details);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      if (++rendererCrashRetries > 3) {
        dialog.showErrorBox('WinUtils renderer stopped', 'The interface crashed repeatedly. Restart WinUtils to retry.');
        return;
      }
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

  protectAppWindow(mainWindow, 'main', rendererUrl);
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    logStartup('Loading renderer from dev server URL', process.env.ELECTRON_RENDERER_URL);
    await mainWindow.loadURL(rendererUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
    logStartup('Loading renderer from file', rendererHtmlPath);
    await mainWindow.loadFile(rendererHtmlPath);
  }

  if (startMinimized) {
    hideMainWindowToTray();
  } else {
    showMainWindow();
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
  const preloadPath = path.join(__dirname, '../preload/index.js');

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

  const actionEngine = new ActionEngine();
  registerSystemActions(actionEngine);
  const contextMenuManager = createOptionalModule('Explorer context menu', () => new ContextMenuManager(actionEngine), logStartup);
  registerContextMenuIpc(contextMenuManager);
  handleSecondInstanceArguments = commandLine => {
    void contextMenuManager.handleArguments(commandLine)
      .then(handled => {
        if (handled) return;
        if (mainWindow) showMainWindow();
        else showMainAfterStartup = true;
      })
      .catch(error => logStartup('Explorer context action failed.', error));
  };
  for (const commandLine of pendingSecondInstanceArguments.splice(0)) {
    handleSecondInstanceArguments(commandLine);
  }
  const hotkeyManager = new HotkeyManager(actionEngine, () => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('hotkeys:changed');
    });
  });
  registerAutomationIpcHandlers(actionEngine, hotkeyManager);
  await hotkeyManager.init();
  actionEngine.replaceOwnerActions('command-palette', [{
    definition: {
      id: 'commandPalette.open',
      ownerId: 'command-palette',
      ownerLabel: 'Command Palette',
      label: 'Open Command Palette',
      description: 'Search and run WinUtils actions',
      category: 'system',
      keywords: ['command', 'palette', 'launcher', 'search', 'actions'],
    },
    handler: () => showCommandPaletteWindow(preloadPath),
  }]);
  hotkeyManager.registerFeatureBinding({
    id: 'commandPalette.quickAccess',
    actionId: 'commandPalette.open',
    ownerId: 'command-palette',
    ownerLabel: 'Command Palette',
    label: 'Open Command Palette',
    description: 'Search and run WinUtils actions',
    defaultHotkey: 'Ctrl+Space',
    suppressWhenAppFocused: false,
  });

  const moduleActions = [
    ['startup-apps', 'Startup Apps', 'Review and manage Windows startup entries'],
    ['macros', 'Macros', 'Open macro profiles and recorded actions'],
    ['hotkeys', 'Hotkeys', 'Manage centralized global shortcuts'],
    ['focus-audio', 'Focus Audio', 'Open focus-based audio rules'],
    ['always-active', 'Always Active', 'Open active-window rules'],
    ['windows', 'Window Manager', 'Control and position open desktop windows'],
    ['automation', 'Automation', 'Run actions from application, file, clipboard, and system triggers'],
    ['context-menu', 'Context Menu', 'Configure WinUtils actions in Windows Explorer'],
    ['renamer', 'Batch Renamer', 'Open preview-first bulk renaming'],
    ['regex-lab', 'Regex Lab', 'Open visual regular expression tools'],
    ['clipboard', 'Clipboard Manager', 'Open the full clipboard manager'],
    ['file-sync', 'File Sync', 'Open safe local folder synchronization'],
    ['settings', 'Settings', 'Open WinUtils settings'],
  ] as const;
  actionEngine.replaceOwnerActions('navigation', moduleActions.map(([moduleId, label, description]) => ({
    definition: {
      id: `navigation.open.${moduleId}`,
      ownerId: 'navigation',
      ownerLabel: 'WinUtils',
      label: `Open ${label}`,
      description,
      category: 'system',
      keywords: ['open', 'module', label.toLowerCase()],
    },
    handler: () => openMainModule(moduleId),
  })));

  const macroManager = new MacroManager(actionEngine, hotkeyManager);
  registerMacroIpcHandlers(macroManager);
  await macroManager.init().catch(err => logStartup('MacroManager init error', err));

  const focusAudioManager = createOptionalModule('Focus Audio', () => new FocusAudioManager(), logStartup);
  registerAudioActions(actionEngine, focusAudioManager);
  registerFocusAudioIpcHandlers(focusAudioManager);
  focusAudioManager.startPolling();

  const alwaysActiveManager = createOptionalModule('Always Active', () => new AlwaysActiveManager({
    onStateChanged: () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('alwaysActive:changed');
      });
    },
  }), logStartup);
  registerAlwaysActiveIpcHandlers(alwaysActiveManager);
  alwaysActiveManager.init().catch(err => logStartup('AlwaysActiveManager init error', err));

  const renamerManager = new RenamerManager();
  registerRenamerIpcHandlers(renamerManager);
  await renamerManager.init().catch(error => logStartup('Rename recovery needs attention.', error));

  const windowManager = createOptionalModule('Window Manager', () => new WindowManager(actionEngine), logStartup);
  await Promise.resolve().then(() => windowManager.restoreAll()).catch(error => logStartup('Hidden-window recovery needs attention.', error));
  registerWindowIpcHandlers(windowManager);

  const fileSyncManager = new FileSyncManager({
    onStateChanged: () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('fileSync:changed');
      });
    },
  });
  registerFileSyncIpcHandlers(fileSyncManager);
  fileSyncManager.init().catch(err => logStartup('FileSyncManager init error', err));

  const clipboardManager = new ClipboardManager(actionEngine, hotkeyManager, {
    onStateChanged: () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('clipboard:changed');
      });
    },
    onQuickAccess: () => {
      void showClipboardWindow(preloadPath)
        .catch(error => logStartup('Failed to show Clipboard Quick Access.', error));
    },
  });
  registerClipboardIpcHandlers(clipboardManager);
  clipboardManager.init().catch(err => logStartup('ClipboardManager init error', err));

  const automationTriggerManager = createOptionalModule('Automation Triggers', () => new AutomationTriggerManager(actionEngine), logStartup);
  registerAutomationTriggerIpc(automationTriggerManager);
    getClipboardSource: () => macroManager.getClipboardSource(),
  automationTriggerManager.init();

  registerAutomationSafetyIpc(actionEngine, async () => {
    const results = await Promise.allSettled([
      macroManager.stopAll(), fileSyncManager.pause(), windowManager.restoreAll(),
      focusAudioManager.setEnabled(false), focusAudioManager.setDuckingEnabled(false), alwaysActiveManager.setEnabled(false),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new Error('Emergency stop needs attention: ' + failures.map(result => String(result.reason)).join('; '));
  }, () => fileSyncManager.resume());

  let shutdownComplete = false;
  const cleanup = createShutdown({
    actions: () => actionEngine.cancelAll(),
    automation: () => automationTriggerManager.dispose(),
    hotkeys: () => hotkeyManager.destroy(),
    windows: () => windowManager.dispose(),
    macros: () => macroManager.destroy(),
    audio: () => focusAudioManager.stopPolling(),
    alwaysActive: () => alwaysActiveManager.destroy(),
    fileSync: () => fileSyncManager.destroy(),
    clipboard: () => clipboardManager.destroy(),
  }, (name, error) => logStartup(`Shutdown cleanup failed: ${name}`, error));
  const prepareShutdown = async (): Promise<void> => {
    isQuitting = true;
    stopAcceptingIpc();
    await cleanup();
    await drainIpcRequests();
    shutdownComplete = true;
  };
  const updateManager = new UpdateManager(prepareShutdown);
  updateManager.init();
  registerUpdateIpcHandlers(updateManager);
  logStartup('IPC handlers registered.');

  try {
    const loginState = app.getLoginItemSettings();
    const hasMinimizedArg = process.argv.includes('--minimized');
    const contextInvocation = process.argv.some(argument => argument.startsWith('--context-action='));
    const shouldStartMinimized = contextInvocation
      || (settings.startMinimized && (hasMinimizedArg || Boolean(loginState.wasOpenedAtLogin)));
    await createWindow(shouldStartMinimized);
    setupTray(preloadPath, settingsStore);
    if (contextInvocation) {
      await contextMenuManager.handleArguments(process.argv);
    }
    if (showMainAfterStartup) {
      showMainAfterStartup = false;
      showMainWindow();
    }
    updateManager.scheduleStartupCheck();
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

  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    void prepareShutdown().then(() => app.quit());
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
