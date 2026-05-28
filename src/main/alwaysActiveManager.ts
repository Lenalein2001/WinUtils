import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type {
  AlwaysActiveForegroundWindow,
  AlwaysActiveMode,
  AlwaysActiveRule,
  AlwaysActiveRuleUpdate,
  AlwaysActiveSettings,
  AlwaysActiveState,
  AlwaysActiveWindow,
} from '../shared/alwaysActive';

const DEFAULT_SETTINGS: AlwaysActiveSettings = {
  enabled: false,
  pollIntervalMs: 450,
  pausedUntil: null,
};
const WORKER_TIMEOUT_MS = 5000;
const DEFAULT_MODE: AlwaysActiveMode = 'prevent-deactivation';
const MAX_WINDOW_ROWS = 160;

interface AlwaysActiveFile {
  version: 1;
  settings: AlwaysActiveSettings;
  rules: AlwaysActiveRule[];
}

interface AlwaysActiveManagerOptions {
  onStateChanged?: () => void;
}

interface WorkerWindowPayload {
  handle?: string;
  processId?: number;
  processName?: string;
  processPath?: string;
  title?: string;
  threadId?: number;
  isForeground?: boolean;
  isMinimized?: boolean;
  isVisible?: boolean;
}

interface WorkerResultPayload {
  windows?: WorkerWindowPayload[];
  foregroundWindow?: WorkerWindowPayload | null;
  activeRuleIds?: string[];
  actionCount?: number;
  errors?: string[];
}

interface WorkerApplyRequest {
  enabled: boolean;
  ownProcessId: number;
  controlWindowTitle: string;
  hookLibraryPath: string;
  rules: Array<{
    id: string;
    enabled: boolean;
    mode: AlwaysActiveMode;
    processName: string;
    processPath: string;
    title: string;
    restoreMinimized: boolean;
  }>;
}

interface PendingWorkerRequest {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const ALWAYS_ACTIVE_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public class RuleInput {
  public string id { get; set; }
  public bool enabled { get; set; }
  public string mode { get; set; }
  public string processName { get; set; }
  public string processPath { get; set; }
  public string title { get; set; }
  public bool restoreMinimized { get; set; }
}

public class ApplyRequest {
  public bool enabled { get; set; }
  public int ownProcessId { get; set; }
  public string controlWindowTitle { get; set; }
  public string hookLibraryPath { get; set; }
  public List<RuleInput> rules { get; set; }
}

public class WindowInfo {
  public string handle { get; set; }
  public int processId { get; set; }
  public string processName { get; set; }
  public string processPath { get; set; }
  public string title { get; set; }
  public int threadId { get; set; }
  public bool isForeground { get; set; }
  public bool isMinimized { get; set; }
  public bool isVisible { get; set; }
}

public class ApplyResult {
  public List<WindowInfo> windows { get; set; }
  public WindowInfo foregroundWindow { get; set; }
  public List<string> activeRuleIds { get; set; }
  public int actionCount { get; set; }
  public List<string> errors { get; set; }
}

public class HookRecord {
  public string key { get; set; }
  public IntPtr handle { get; set; }
  public IntPtr hwnd { get; set; }
  public uint threadId { get; set; }
}

public static class AlwaysActiveHelper {
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  private const uint WM_ACTIVATE = 0x0006;
  private const uint WM_SETFOCUS = 0x0007;
  private const uint WM_NCACTIVATE = 0x0086;
  private const uint WM_ACTIVATEAPP = 0x001C;
  private const uint WM_NULL = 0x0000;
  private const uint WINUTILS_RESTORE_MESSAGE = 0x8066;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const int WH_CALLWNDPROC = 4;
  private const int WA_ACTIVE = 1;
  private const int SW_RESTORE = 9;
  private const int WORKER_TICK_MS = 125;
  private const int GAME_SIGNAL_INTERVAL_MS = 350;
  private const int ACTIVE_SIGNAL_INTERVAL_MS = 900;
  private const int WINDOW_REFRESH_MS = 250;

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")]
  private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int idHook, IntPtr lpfn, IntPtr hmod, uint dwThreadId);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern IntPtr LoadLibrary(string lpFileName);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
  private static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);

  private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
  private static readonly object StateLock = new object();
  private static Timer PulseTimer;
  private static bool StoredEnabled;
  private static int StoredOwnProcessId;
  private static string StoredControlWindowTitle = "";
  private static string StoredHookLibraryPath = "";
  private static List<RuleInput> StoredRules = new List<RuleInput>();
  private static List<WindowInfo> CachedWindows = new List<WindowInfo>();
  private static DateTime CachedWindowsAt = DateTime.MinValue;
  private static List<string> LastActiveRuleIds = new List<string>();
  private static int LastActionCount;
  private static List<string> LastErrors = new List<string>();
  private static Dictionary<string, DateTime> LastSignalAtByHandle = new Dictionary<string, DateTime>();
  private static Dictionary<string, HookRecord> InstalledHooks = new Dictionary<string, HookRecord>();
  private static IntPtr HookModule = IntPtr.Zero;
  private static IntPtr HookProcedure = IntPtr.Zero;
  private static int PulseBusy;

  public static string ListWindowsJson() {
    RefreshWindowCache(true);
    ApplyResult result = new ApplyResult();
    result.windows = CloneWindows(CachedWindows);
    result.foregroundWindow = GetWindowInfo(GetForegroundWindow());
    result.activeRuleIds = new List<string>(LastActiveRuleIds);
    result.actionCount = LastActionCount;
    result.errors = new List<string>(LastErrors);
    return Serializer.Serialize(result);
  }

  public static string ApplyJson(string base64Request) {
    string requestJson = Encoding.UTF8.GetString(Convert.FromBase64String(base64Request));
    ApplyRequest request = Serializer.Deserialize<ApplyRequest>(requestJson);
    Configure(request);
    ApplyStoredRules(true);
    return ListWindowsJson();
  }

  public static string ShutdownJson() {
    StopPulseTimer();
    RemoveUnwantedHooks(new HashSet<string>());
    LastActiveRuleIds.Clear();
    LastActionCount = 0;
    LastErrors.Clear();
    return "{}";
  }

  private static void Configure(ApplyRequest request) {
    lock (StateLock) {
      StoredEnabled = request != null && request.enabled && request.rules != null && request.rules.Count > 0;
      StoredOwnProcessId = request != null ? request.ownProcessId : 0;
      StoredControlWindowTitle = request != null && request.controlWindowTitle != null ? request.controlWindowTitle : "";
      StoredHookLibraryPath = request != null && request.hookLibraryPath != null ? request.hookLibraryPath : "";
      StoredRules = request != null && request.rules != null ? request.rules : new List<RuleInput>();
      if (StoredEnabled) {
        EnsurePulseTimer();
      } else {
        StopPulseTimer();
        RemoveUnwantedHooks(new HashSet<string>());
        LastActiveRuleIds.Clear();
        LastActionCount = 0;
        LastErrors.Clear();
      }
    }
  }

  private static void EnsurePulseTimer() {
    if (PulseTimer != null) return;
    PulseTimer = new Timer(PulseTick, null, 0, WORKER_TICK_MS);
  }

  private static void StopPulseTimer() {
    if (PulseTimer == null) return;
    PulseTimer.Dispose();
    PulseTimer = null;
  }

  private static void PulseTick(object state) {
    if (Interlocked.Exchange(ref PulseBusy, 1) == 1) return;
    try {
      ApplyStoredRules(false);
    } catch {
    } finally {
      Interlocked.Exchange(ref PulseBusy, 0);
    }
  }

  private static ApplyResult ApplyStoredRules(bool includeWindows) {
    ApplyResult result = new ApplyResult();
    result.activeRuleIds = new List<string>();
    result.actionCount = 0;
    result.errors = new List<string>();
    result.foregroundWindow = GetWindowInfo(GetForegroundWindow());

    List<RuleInput> rules;
    bool enabled;
    int ownProcessId;
    string controlWindowTitle;
    lock (StateLock) {
      enabled = StoredEnabled;
      ownProcessId = StoredOwnProcessId;
      controlWindowTitle = StoredControlWindowTitle;
      rules = new List<RuleInput>(StoredRules);
    }

    RefreshWindowCache(includeWindows || IsWindowCacheStale());
    result.windows = includeWindows ? CloneWindows(CachedWindows) : new List<WindowInfo>();

    if (!enabled || rules.Count == 0) {
      StoreLastResult(result);
      return result;
    }

    bool controlWindowForeground = IsControlWindowForeground(ownProcessId, controlWindowTitle, result.foregroundWindow);
    bool foregroundClaimed = false;
    HashSet<string> desiredHookKeys = new HashSet<string>();
    for (int i = 0; i < rules.Count; i++) {
      RuleInput rule = rules[i];
      if (rule == null || !rule.enabled) continue;

      List<WindowInfo> matches = new List<WindowInfo>();
      for (int w = 0; w < CachedWindows.Count; w++) {
        WindowInfo window = CachedWindows[w];
        if (RuleMatchesWindow(rule, window)) matches.Add(window);
      }

      if (matches.Count == 0) continue;
      if (!String.IsNullOrWhiteSpace(rule.id) && !result.activeRuleIds.Contains(rule.id)) {
        result.activeRuleIds.Add(rule.id);
      }

      if (String.Equals(rule.mode, "prevent-deactivation", StringComparison.OrdinalIgnoreCase)) {
        for (int m = 0; m < matches.Count; m++) {
          WindowInfo match = matches[m];
          string hookKey = BuildHookKey(rule, match);
          if (!String.IsNullOrWhiteSpace(hookKey)) desiredHookKeys.Add(hookKey);
          try {
            if (InstallPreventDeactivationHook(rule, match, hookKey, result.errors)) result.actionCount++;
          } catch (Exception ex) {
            result.errors.Add(ex.Message);
          }
        }
        continue;
      }

      if (String.Equals(rule.mode, "keep-foreground", StringComparison.OrdinalIgnoreCase)) {
        if (foregroundClaimed || controlWindowForeground) continue;
        WindowInfo first = matches[0];
        if (!first.isForeground) {
          try {
            if (ForceForeground(ParseHandle(first.handle), rule.restoreMinimized)) result.actionCount++;
          } catch (Exception ex) {
            result.errors.Add(ex.Message);
          }
        }
        foregroundClaimed = true;
        continue;
      }

      for (int m = 0; m < matches.Count; m++) {
        WindowInfo match = matches[m];
        if (match.isForeground) continue;
        try {
          if (String.Equals(rule.mode, "game-keepalive", StringComparison.OrdinalIgnoreCase) && ShouldSignal(match.handle, GAME_SIGNAL_INTERVAL_MS)) {
            if (SignalGameKeepAlive(ParseHandle(match.handle))) result.actionCount++;
          } else if (!String.Equals(rule.mode, "game-keepalive", StringComparison.OrdinalIgnoreCase) && ShouldSignal(match.handle, ACTIVE_SIGNAL_INTERVAL_MS) && SignalActive(ParseHandle(match.handle))) {
            result.actionCount++;
          }
        } catch (Exception ex) {
          result.errors.Add(ex.Message);
        }
      }
    }

    RemoveUnwantedHooks(desiredHookKeys);
    StoreLastResult(result);
    return result;
  }

  private static void StoreLastResult(ApplyResult result) {
    lock (StateLock) {
      LastActiveRuleIds = result.activeRuleIds != null ? new List<string>(result.activeRuleIds) : new List<string>();
      LastActionCount = result.actionCount;
      LastErrors = result.errors != null ? new List<string>(result.errors) : new List<string>();
    }
  }

  private static bool IsWindowCacheStale() {
    return (DateTime.UtcNow - CachedWindowsAt).TotalMilliseconds >= WINDOW_REFRESH_MS;
  }

  private static void RefreshWindowCache(bool force) {
    if (!force && !IsWindowCacheStale()) return;
    CachedWindows = ListWindows();
    CachedWindowsAt = DateTime.UtcNow;
  }

  private static List<WindowInfo> CloneWindows(List<WindowInfo> windows) {
    return windows != null ? new List<WindowInfo>(windows) : new List<WindowInfo>();
  }

  private static List<WindowInfo> ListWindows() {
    List<WindowInfo> windows = new List<WindowInfo>();
    IntPtr foreground = GetForegroundWindow();

    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      int textLength = GetWindowTextLength(hWnd);
      if (textLength <= 0) return true;
      WindowInfo info = GetWindowInfo(hWnd, foreground);
      if (info == null || info.processId <= 0 || String.IsNullOrWhiteSpace(info.title)) return true;
      windows.Add(info);
      return true;
    }, IntPtr.Zero);

    return windows;
  }

  private static WindowInfo GetWindowInfo(IntPtr hWnd) {
    return GetWindowInfo(hWnd, GetForegroundWindow());
  }

  private static WindowInfo GetWindowInfo(IntPtr hWnd, IntPtr foreground) {
    if (hWnd == IntPtr.Zero) return null;
    uint pid = 0;
    uint threadId = GetWindowThreadProcessId(hWnd, out pid);
    string processPath = pid > 0 ? GetProcessPathByPid(pid) : "";
    string processName = pid > 0 ? GetProcessNameByPid(pid, processPath) : "";

    WindowInfo info = new WindowInfo();
    info.handle = hWnd.ToInt64().ToString();
    info.processId = pid > Int32.MaxValue ? 0 : (int)pid;
    info.processName = processName ?? "";
    info.processPath = processPath ?? "";
    info.title = GetWindowTitle(hWnd) ?? "";
    info.threadId = threadId > Int32.MaxValue ? 0 : (int)threadId;
    info.isForeground = hWnd == foreground;
    info.isMinimized = IsIconic(hWnd);
    info.isVisible = IsWindowVisible(hWnd);
    return info;
  }

  private static string GetWindowTitle(IntPtr hWnd) {
    try {
      int length = GetWindowTextLength(hWnd);
      if (length <= 0) return "";
      StringBuilder sb = new StringBuilder(length + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      return sb.ToString();
    } catch {
      return "";
    }
  }

  private static string GetProcessNameByPid(uint processId, string knownPath) {
    try {
      using (Process process = Process.GetProcessById((int)processId)) {
        if (!String.IsNullOrWhiteSpace(process.ProcessName)) return process.ProcessName;
      }
    } catch {
    }

    if (!String.IsNullOrWhiteSpace(knownPath)) {
      try {
        return Path.GetFileNameWithoutExtension(knownPath);
      } catch {
      }
    }

    return "";
  }

  private static string GetProcessPathByPid(uint processId) {
    try {
      using (Process process = Process.GetProcessById((int)processId)) {
        if (process.MainModule != null && !String.IsNullOrWhiteSpace(process.MainModule.FileName)) {
          return process.MainModule.FileName;
        }
      }
    } catch {
    }

    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
    if (handle == IntPtr.Zero) return "";
    try {
      StringBuilder sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (!QueryFullProcessImageName(handle, 0, sb, ref size) || size <= 0) return "";
      return sb.ToString(0, size);
    } catch {
      return "";
    } finally {
      CloseHandle(handle);
    }
  }

  private static bool RuleMatchesWindow(RuleInput rule, WindowInfo window) {
    if (window == null || rule == null) return false;
    bool hasProcessCriteria = !String.IsNullOrWhiteSpace(rule.processPath) || !String.IsNullOrWhiteSpace(rule.processName);

    if (hasProcessCriteria) {
      if (!String.IsNullOrWhiteSpace(rule.processPath) && !String.IsNullOrWhiteSpace(window.processPath) &&
          String.Equals(rule.processPath, window.processPath, StringComparison.OrdinalIgnoreCase)) {
        return true;
      }

      string ruleProcess = NormalizeProcessToken(rule.processName);
      string windowProcess = NormalizeProcessToken(window.processName);
      if (!String.IsNullOrEmpty(ruleProcess) && !String.IsNullOrEmpty(windowProcess) && ruleProcess == windowProcess) {
        return true;
      }

      return false;
    }

    if (!String.IsNullOrWhiteSpace(rule.title) && !String.IsNullOrWhiteSpace(window.title)) {
      return window.title.IndexOf(rule.title, StringComparison.OrdinalIgnoreCase) >= 0 ||
        rule.title.IndexOf(window.title, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    return false;
  }

  private static bool SignalActive(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    PostMessage(hWnd, WM_NCACTIVATE, new IntPtr(1), IntPtr.Zero);
    PostMessage(hWnd, WM_ACTIVATEAPP, new IntPtr(1), IntPtr.Zero);
    PostMessage(hWnd, WM_ACTIVATE, new IntPtr(WA_ACTIVE), IntPtr.Zero);
    return true;
  }

  private static bool SignalGameKeepAlive(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    PostMessage(hWnd, WM_NCACTIVATE, new IntPtr(1), IntPtr.Zero);
    PostMessage(hWnd, WM_ACTIVATEAPP, new IntPtr(1), IntPtr.Zero);
    PostMessage(hWnd, WM_ACTIVATE, new IntPtr(WA_ACTIVE), IntPtr.Zero);
    PostMessage(hWnd, WM_SETFOCUS, IntPtr.Zero, IntPtr.Zero);
    return true;
  }

  private static bool ShouldSignal(string handle, int intervalMs) {
    if (String.IsNullOrWhiteSpace(handle)) return false;
    DateTime now = DateTime.UtcNow;
    DateTime last;
    if (LastSignalAtByHandle.TryGetValue(handle, out last) && (now - last).TotalMilliseconds < intervalMs) {
      return false;
    }
    LastSignalAtByHandle[handle] = now;
    return true;
  }

  private static string BuildHookKey(RuleInput rule, WindowInfo window) {
    if (rule == null || window == null || window.threadId <= 0) return "";
    return rule.id + ":" + window.threadId.ToString();
  }

  private static bool InstallPreventDeactivationHook(RuleInput rule, WindowInfo window, string hookKey, List<string> errors) {
    if (window == null || window.threadId <= 0 || String.IsNullOrWhiteSpace(hookKey)) return false;
    if (InstalledHooks.ContainsKey(hookKey)) {
      PostMessage(ParseHandle(window.handle), WM_NULL, IntPtr.Zero, IntPtr.Zero);
      return false;
    }

    if (!EnsureHookLibraryLoaded(errors)) return false;

    IntPtr hookHandle = SetWindowsHookEx(WH_CALLWNDPROC, HookProcedure, HookModule, (uint)window.threadId);
    if (hookHandle == IntPtr.Zero) {
      errors.Add("Prevent Deactivation hook install failed for " + window.title + " (Win32 " + Marshal.GetLastWin32Error().ToString() + ").");
      return false;
    }

    IntPtr hwnd = ParseHandle(window.handle);
    InstalledHooks[hookKey] = new HookRecord {
      key = hookKey,
      handle = hookHandle,
      hwnd = hwnd,
      threadId = (uint)window.threadId,
    };

    PostMessage(hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
    return true;
  }

  private static bool EnsureHookLibraryLoaded(List<string> errors) {
    if (HookModule != IntPtr.Zero && HookProcedure != IntPtr.Zero) return true;
    if (String.IsNullOrWhiteSpace(StoredHookLibraryPath) || !File.Exists(StoredHookLibraryPath)) {
      errors.Add("Prevent Deactivation hook DLL is missing: " + StoredHookLibraryPath);
      return false;
    }

    HookModule = LoadLibrary(StoredHookLibraryPath);
    if (HookModule == IntPtr.Zero) {
      errors.Add("Prevent Deactivation hook DLL could not be loaded (Win32 " + Marshal.GetLastWin32Error().ToString() + ").");
      return false;
    }

    HookProcedure = GetProcAddress(HookModule, "WinUtilsCallWndProc");
    if (HookProcedure == IntPtr.Zero) {
      errors.Add("Prevent Deactivation hook export WinUtilsCallWndProc was not found.");
      return false;
    }

    return true;
  }

  private static void RemoveUnwantedHooks(HashSet<string> desiredHookKeys) {
    List<string> removeKeys = new List<string>();
    foreach (KeyValuePair<string, HookRecord> pair in InstalledHooks) {
      if (!desiredHookKeys.Contains(pair.Key)) removeKeys.Add(pair.Key);
    }

    for (int i = 0; i < removeKeys.Count; i++) {
      HookRecord record = InstalledHooks[removeKeys[i]];
      if (record.hwnd != IntPtr.Zero) {
        PostMessage(record.hwnd, WINUTILS_RESTORE_MESSAGE, IntPtr.Zero, IntPtr.Zero);
      }
    }

    if (removeKeys.Count > 0) {
      Thread.Sleep(160);
    }

    for (int i = 0; i < removeKeys.Count; i++) {
      HookRecord record = InstalledHooks[removeKeys[i]];
      if (record.handle != IntPtr.Zero) {
        UnhookWindowsHookEx(record.handle);
      }
      InstalledHooks.Remove(removeKeys[i]);
    }
  }

  private static bool ForceForeground(IntPtr hWnd, bool restoreMinimized) {
    if (hWnd == IntPtr.Zero) return false;
    if (restoreMinimized && IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);

    IntPtr current = GetForegroundWindow();
    if (current == hWnd) return true;

    uint currentPid = 0;
    uint targetPid = 0;
    uint currentThread = current != IntPtr.Zero ? GetWindowThreadProcessId(current, out currentPid) : 0;
    uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
    uint ownThread = GetCurrentThreadId();
    bool attachedCurrent = false;
    bool attachedOwn = false;

    try {
      if (currentThread != 0 && targetThread != 0 && currentThread != targetThread) {
        attachedCurrent = AttachThreadInput(currentThread, targetThread, true);
      }
      if (ownThread != 0 && targetThread != 0 && ownThread != targetThread) {
        attachedOwn = AttachThreadInput(ownThread, targetThread, true);
      }

      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
      SetFocus(hWnd);
      return GetForegroundWindow() == hWnd;
    } finally {
      if (attachedOwn) AttachThreadInput(ownThread, targetThread, false);
      if (attachedCurrent) AttachThreadInput(currentThread, targetThread, false);
    }
  }

  private static bool IsControlWindowForeground(int ownProcessId, string controlWindowTitle, WindowInfo foreground) {
    if (foreground == null) return false;
    if (ownProcessId > 0 && foreground.processId == ownProcessId) return true;
    if (!String.IsNullOrWhiteSpace(controlWindowTitle) && !String.IsNullOrWhiteSpace(foreground.title)) {
      return foreground.title.IndexOf(controlWindowTitle, StringComparison.OrdinalIgnoreCase) >= 0;
    }
    return false;
  }

  private static string NormalizeProcessToken(string value) {
    if (String.IsNullOrWhiteSpace(value)) return "";
    string trimmed = value.Trim().ToLowerInvariant();
    if (trimmed.EndsWith(".exe")) trimmed = trimmed.Substring(0, trimmed.Length - 4);
    StringBuilder sb = new StringBuilder(trimmed.Length);
    for (int i = 0; i < trimmed.Length; i++) {
      char c = trimmed[i];
      if (Char.IsLetterOrDigit(c)) sb.Append(c);
    }
    return sb.ToString();
  }

  private static IntPtr ParseHandle(string value) {
    long handle;
    if (!Int64.TryParse(value, out handle)) return IntPtr.Zero;
    return new IntPtr(handle);
  }
}
'@ -Language CSharp -ReferencedAssemblies 'System.Web.Extensions'

try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $parts = $line -split ([char]9), 3
    if ($parts.Count -lt 2) { continue }
    $requestId = $parts[0]
    $command = $parts[1]

    try {
      if ($command -eq 'LIST') {
        $json = [AlwaysActiveHelper]::ListWindowsJson()
      } elseif ($command -eq 'APPLY' -and $parts.Count -ge 3) {
        $json = [AlwaysActiveHelper]::ApplyJson($parts[2])
      } elseif ($command -eq 'SHUTDOWN') {
        $json = [AlwaysActiveHelper]::ShutdownJson()
      } else {
        throw "Unknown Always Active command: $command"
      }

      $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
      [Console]::Out.WriteLine($requestId + [char]9 + 'OK' + [char]9 + $payload)
      [Console]::Out.Flush()
    } catch {
      $message = $_.Exception.Message
      $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message))
      [Console]::Out.WriteLine($requestId + [char]9 + 'ERR' + [char]9 + $payload)
      [Console]::Out.Flush()
    }
  }
} finally {
  try { [AlwaysActiveHelper]::ShutdownJson() | Out-Null } catch {}
}
`;

export class AlwaysActiveManager {
  private file: AlwaysActiveFile | null = null;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerOutput = '';
  private readonly pendingRequests = new Map<string, PendingWorkerRequest>();
  private enforcementTimer: NodeJS.Timeout | null = null;
  private applyInFlight = false;
  private destroyed = false;
  private lastWindows: AlwaysActiveWindow[] = [];
  private foregroundWindow: AlwaysActiveForegroundWindow | null = null;
  private lastStartedAt: string | null = null;
  private lastAppliedAt: string | null = null;
  private lastAppliedRuleIds: string[] = [];
  private lastActionCount = 0;
  private lastError: string | null = null;

  constructor(private readonly options: AlwaysActiveManagerOptions = {}) {}

  async init(): Promise<void> {
    await this.load();
    this.startLoop();
    await this.refreshWindows().catch(() => undefined);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.enforcementTimer) {
      clearInterval(this.enforcementTimer);
      this.enforcementTimer = null;
    }
    this.rejectAllPending(new Error('Always Active worker stopped.'));
    if (this.worker) {
      const worker = this.worker;
      worker.stdin.write(`${randomUUID()}\tSHUTDOWN\n`, () => {
        worker.kill();
      });
      this.worker = null;
    }
  }

  async getState(refresh = true): Promise<AlwaysActiveState> {
    await this.load();
    if (refresh) {
      await this.refreshWindows().catch(() => undefined);
    }
    return this.buildState();
  }

  async refreshWindows(): Promise<AlwaysActiveState> {
    await this.load();
    if (process.platform !== 'win32') {
      this.lastError = 'Always Active is only available on Windows.';
      return this.buildState();
    }

    try {
      const result = await this.requestWorker<WorkerResultPayload>('LIST');
      this.updateWorkerSnapshot(result);
      this.lastError = result.errors?.[0] ?? null;
    } catch (error) {
      this.lastError = getErrorMessage(error, 'Unable to list active windows.');
    }

    return this.buildState();
  }

  async setEnabled(enabled: boolean): Promise<AlwaysActiveState> {
    const file = await this.load();
    file.settings.enabled = enabled;
    if (enabled) file.settings.pausedUntil = null;
    await this.save(file);
    if (enabled) void this.applyRules();
    this.notifyStateChanged();
    return this.getState(false);
  }

  async pause(seconds: number): Promise<AlwaysActiveState> {
    const file = await this.load();
    const boundedSeconds = Math.max(1, Math.min(3600, Math.round(seconds)));
    file.settings.pausedUntil = new Date(Date.now() + boundedSeconds * 1000).toISOString();
    await this.save(file);
    this.notifyStateChanged();
    return this.getState(false);
  }

  async addRuleFromWindow(windowId: string, mode: AlwaysActiveMode = DEFAULT_MODE): Promise<AlwaysActiveState> {
    const file = await this.load();
    if (!this.lastWindows.some((window) => window.id === windowId)) {
      await this.refreshWindows();
    }

    const window = this.lastWindows.find((item) => item.id === windowId);
    if (!window) throw new Error('The selected window is no longer available.');
    if (window.title.toLowerCase().includes('winutils')) {
      throw new Error('WinUtils cannot keep its own window active.');
    }

    const now = new Date().toISOString();
    const existing = this.findEquivalentRule(file.rules, window);
    if (existing) {
      existing.enabled = true;
      existing.mode = normalizeMode(mode);
      existing.updatedAt = now;
    } else {
      file.rules.push({
        id: randomUUID(),
        label: buildRuleLabel(window),
        enabled: true,
        mode: normalizeMode(mode),
        processName: window.processName,
        processPath: window.processPath,
        title: window.title,
        restoreMinimized: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    await this.save(file);
    await this.applyRules();
    this.notifyStateChanged();
    return this.getState(false);
  }

  async updateRule(patch: AlwaysActiveRuleUpdate): Promise<AlwaysActiveState> {
    const file = await this.load();
    const rule = file.rules.find((item) => item.id === patch.id);
    if (!rule) throw new Error('The selected Always Active rule could not be found.');

    if (patch.label !== undefined) rule.label = patch.label.trim() || rule.label;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    if (patch.mode !== undefined) rule.mode = normalizeMode(patch.mode);
    if (patch.restoreMinimized !== undefined) rule.restoreMinimized = patch.restoreMinimized;
    rule.updatedAt = new Date().toISOString();

    await this.save(file);
    await this.applyRules();
    this.notifyStateChanged();
    return this.getState(false);
  }

  async deleteRule(id: string): Promise<AlwaysActiveState> {
    const file = await this.load();
    const nextRules = file.rules.filter((rule) => rule.id !== id);
    if (nextRules.length === file.rules.length) throw new Error('The selected Always Active rule could not be found.');
    file.rules = nextRules;
    await this.save(file);
    this.lastAppliedRuleIds = this.lastAppliedRuleIds.filter((ruleId) => ruleId !== id);
    this.notifyStateChanged();
    return this.getState(false);
  }

  private async applyRules(): Promise<void> {
    if (this.applyInFlight || process.platform !== 'win32') return;

    const file = await this.load();
    if (!file.settings.enabled || this.isPaused(file.settings)) return;
    const activeRules = file.rules.filter((rule) => rule.enabled);
    if (activeRules.length === 0) return;

    this.applyInFlight = true;
    try {
      const request: WorkerApplyRequest = {
        enabled: true,
        ownProcessId: process.pid,
        controlWindowTitle: 'WinUtils',
        hookLibraryPath: this.hookLibraryPath,
        rules: activeRules.map((rule) => ({
          id: rule.id,
          enabled: rule.enabled,
          mode: rule.mode,
          processName: rule.processName,
          processPath: rule.processPath,
          title: rule.title,
          restoreMinimized: rule.restoreMinimized,
        })),
      };
      const result = await this.requestWorker<WorkerResultPayload>('APPLY', request);
      this.updateWorkerSnapshot(result);
      this.lastAppliedAt = new Date().toISOString();
      this.lastAppliedRuleIds = result.activeRuleIds ?? [];
      this.lastActionCount = result.actionCount ?? 0;
      this.lastError = result.errors?.[0] ?? null;
      await this.markMatchedRules(this.lastAppliedRuleIds);
    } catch (error) {
      this.lastError = getErrorMessage(error, 'Unable to apply Always Active rules.');
    } finally {
      this.applyInFlight = false;
    }
  }

  private startLoop(): void {
    if (this.enforcementTimer) return;
    this.enforcementTimer = setInterval(() => {
      void this.applyRules();
    }, DEFAULT_SETTINGS.pollIntervalMs);
  }

  private async load(): Promise<AlwaysActiveFile> {
    if (this.file) return this.file;
    await mkdir(path.dirname(this.filePath), { recursive: true });

    if (!existsSync(this.filePath)) {
      this.file = { version: 1, settings: { ...DEFAULT_SETTINGS }, rules: [] };
      await this.save(this.file);
      return this.file;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AlwaysActiveFile>;
      this.file = {
        version: 1,
        settings: normalizeSettings(parsed.settings),
        rules: Array.isArray(parsed.rules) ? parsed.rules.map(normalizeRule).filter((rule): rule is AlwaysActiveRule => rule !== null) : [],
      };
    } catch {
      this.file = { version: 1, settings: { ...DEFAULT_SETTINGS }, rules: [] };
      await this.save(this.file);
    }

    return this.file;
  }

  private async save(file: AlwaysActiveFile): Promise<void> {
    this.file = file;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'always-active.json');
  }

  private get workerScriptPath(): string {
    return path.join(app.getPath('userData'), 'always-active-worker.ps1');
  }

  private get hookLibraryPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'resources', 'native', 'WinUtils.AlwaysActiveHook.dll');
    }

    return path.join(app.getAppPath(), 'resources', 'native', 'WinUtils.AlwaysActiveHook.dll');
  }

  private async requestWorker<T>(command: 'LIST' | 'APPLY', payload?: unknown): Promise<T> {
    const worker = await this.ensureWorker();
    const id = randomUUID();
    const encodedPayload = payload === undefined ? '' : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const line = [id, command, encodedPayload].filter((part, index) => index < 2 || part).join('\t') + '\n';

    const json = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Always Active worker timed out.'));
      }, WORKER_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      worker.stdin.write(line, (error) => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.reject(error);
      });
    });

    return JSON.parse(json) as T;
  }

  private async ensureWorker(): Promise<ChildProcessWithoutNullStreams> {
    if (process.platform !== 'win32') throw new Error('Always Active is only available on Windows.');
    if (this.worker) return this.worker;

    await mkdir(path.dirname(this.workerScriptPath), { recursive: true });
    await writeFile(this.workerScriptPath, ALWAYS_ACTIVE_WORKER_SCRIPT, 'utf8');

    this.worker = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.workerScriptPath,
    ], { stdio: 'pipe' });
    this.workerOutput = '';
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;

    this.worker.stdout.on('data', (chunk: Buffer) => this.handleWorkerOutput(chunk));
    this.worker.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) this.lastError = message;
    });
    this.worker.on('exit', (code) => {
      this.worker = null;
      this.rejectAllPending(new Error(`Always Active worker exited${code === null ? '' : ` with code ${code}`}.`));
      if (!this.destroyed) this.lastError = 'Always Active worker stopped and will restart on the next request.';
    });

    return this.worker;
  }

  private handleWorkerOutput(chunk: Buffer): void {
    this.workerOutput += chunk.toString();
    const lines = this.workerOutput.split(/\r?\n/);
    this.workerOutput = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [id, status, encodedPayload] = parts;
      const pending = this.pendingRequests.get(id);
      if (!pending) continue;

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      const text = Buffer.from(encodedPayload, 'base64').toString('utf8');
      if (status === 'OK') {
        pending.resolve(text);
      } else {
        pending.reject(new Error(text));
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private updateWorkerSnapshot(result: WorkerResultPayload): void {
    this.lastWindows = (result.windows ?? [])
      .slice(0, MAX_WINDOW_ROWS)
      .map((window) => this.mapWorkerWindow(window))
      .filter((window): window is AlwaysActiveWindow => window !== null);
    this.foregroundWindow = this.mapForegroundWindow(result.foregroundWindow ?? null);
  }

  private mapWorkerWindow(window: WorkerWindowPayload): AlwaysActiveWindow | null {
    const hwnd = String(window.handle ?? '').trim();
    if (!hwnd) return null;

    const mapped: AlwaysActiveWindow = {
      id: hwnd,
      hwnd,
      processId: Number.isFinite(window.processId) ? Number(window.processId) : 0,
      processName: String(window.processName ?? '').trim(),
      processPath: String(window.processPath ?? '').trim(),
      title: String(window.title ?? '').trim(),
      threadId: Number.isFinite(window.threadId) ? Number(window.threadId) : 0,
      isForeground: Boolean(window.isForeground),
      isMinimized: Boolean(window.isMinimized),
      isVisible: Boolean(window.isVisible),
      ruleIds: [],
    };
    mapped.ruleIds = this.findMatchingRuleIds(mapped, true);
    return mapped;
  }

  private mapForegroundWindow(window: WorkerWindowPayload | null): AlwaysActiveForegroundWindow | null {
    if (!window?.handle) return null;
    return {
      hwnd: String(window.handle),
      processId: Number.isFinite(window.processId) ? Number(window.processId) : 0,
      processName: String(window.processName ?? '').trim(),
      processPath: String(window.processPath ?? '').trim(),
      title: String(window.title ?? '').trim(),
    };
  }

  private findMatchingRuleIds(window: AlwaysActiveWindow, includeDisabled: boolean): string[] {
    const file = this.file;
    if (!file) return [];
    return file.rules
      .filter((rule) => (includeDisabled || rule.enabled) && ruleMatchesWindow(rule, window))
      .map((rule) => rule.id);
  }

  private findEquivalentRule(rules: AlwaysActiveRule[], window: AlwaysActiveWindow): AlwaysActiveRule | undefined {
    return rules.find((rule) => {
      if (rule.processPath && window.processPath && rule.processPath.toLowerCase() === window.processPath.toLowerCase()) return true;
      if (normalizeToken(rule.processName) && normalizeToken(rule.processName) === normalizeToken(window.processName)) return true;
      return false;
    });
  }

  private async markMatchedRules(ruleIds: string[]): Promise<void> {
    if (ruleIds.length === 0 || !this.file) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const rule of this.file.rules) {
      if (!ruleIds.includes(rule.id)) continue;
      rule.lastMatchedAt = now;
      changed = true;
    }
    if (changed) await this.save(this.file);
  }

  private isPaused(settings: AlwaysActiveSettings): boolean {
    return Boolean(settings.pausedUntil && new Date(settings.pausedUntil).getTime() > Date.now());
  }

  private buildState(): AlwaysActiveState {
    const file = this.file ?? { version: 1 as const, settings: { ...DEFAULT_SETTINGS }, rules: [] };
    return {
      settings: { ...file.settings },
      rules: file.rules.map((rule) => ({ ...rule })),
      windows: this.lastWindows.map((window) => ({ ...window, ruleIds: [...window.ruleIds] })),
      foregroundWindow: this.foregroundWindow ? { ...this.foregroundWindow } : null,
      workerStatus: {
        supported: process.platform === 'win32',
        running: this.worker !== null,
        error: this.lastError,
        lastStartedAt: this.lastStartedAt,
        lastAppliedAt: this.lastAppliedAt,
        lastAppliedRuleIds: [...this.lastAppliedRuleIds],
        lastActionCount: this.lastActionCount,
      },
    };
  }

  private notifyStateChanged(): void {
    this.options.onStateChanged?.();
  }
}

function normalizeSettings(settings: Partial<AlwaysActiveSettings> | undefined): AlwaysActiveSettings {
  return {
    enabled: Boolean(settings?.enabled),
    pollIntervalMs: normalizePollInterval(settings?.pollIntervalMs),
    pausedUntil: typeof settings?.pausedUntil === 'string' ? settings.pausedUntil : null,
  };
}

function normalizePollInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : DEFAULT_SETTINGS.pollIntervalMs;
  return Math.max(250, Math.min(2000, Math.round(parsed)));
}

function normalizeRule(rule: Partial<AlwaysActiveRule>): AlwaysActiveRule | null {
  const processName = String(rule.processName ?? '').trim();
  const processPath = String(rule.processPath ?? '').trim();
  const title = String(rule.title ?? '').trim();
  if (!processName && !processPath && !title) return null;

  const now = new Date().toISOString();
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : randomUUID(),
    label: typeof rule.label === 'string' && rule.label.trim() ? rule.label.trim() : processName || title || 'Always Active App',
    enabled: rule.enabled !== false,
    mode: normalizeMode(rule.mode),
    processName,
    processPath,
    title,
    restoreMinimized: rule.restoreMinimized !== false,
    createdAt: typeof rule.createdAt === 'string' ? rule.createdAt : now,
    updatedAt: typeof rule.updatedAt === 'string' ? rule.updatedAt : now,
    lastMatchedAt: typeof rule.lastMatchedAt === 'string' ? rule.lastMatchedAt : undefined,
  };
}

function normalizeMode(mode: unknown): AlwaysActiveMode {
  if (mode === 'prevent-deactivation') return 'prevent-deactivation';
  if (mode === 'keep-foreground') return 'keep-foreground';
  if (mode === 'active-signal') return 'active-signal';
  if (mode === 'game-keepalive') return 'game-keepalive';
  return 'prevent-deactivation';
}

function buildRuleLabel(window: AlwaysActiveWindow): string {
  if (window.processName) return window.processName.endsWith('.exe') ? window.processName : `${window.processName}.exe`;
  if (window.title) return window.title;
  return `PID ${window.processId}`;
}

function ruleMatchesWindow(rule: AlwaysActiveRule, window: AlwaysActiveWindow): boolean {
  const hasProcessCriteria = Boolean(rule.processPath || rule.processName);
  if (hasProcessCriteria) {
    if (rule.processPath && window.processPath && rule.processPath.toLowerCase() === window.processPath.toLowerCase()) return true;
    const ruleProcess = normalizeToken(rule.processName);
    const windowProcess = normalizeToken(window.processName);
    return Boolean(ruleProcess && windowProcess && ruleProcess === windowProcess);
  }

  if (!rule.title || !window.title) return false;
  return window.title.toLowerCase().includes(rule.title.toLowerCase()) || rule.title.toLowerCase().includes(window.title.toLowerCase());
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
