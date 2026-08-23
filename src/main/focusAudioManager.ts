import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import type { FocusAudioConfig, FocusAudioDuckRule } from '../shared/focusAudio';

// ─── C# type definitions that work correctly with COM vtables ────────────────
const CSHARP_TYPES = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class CMMDeviceEnumerator {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    void EnumAudioEndpoints();
    [return: MarshalAs(UnmanagedType.Interface)] object GetDefaultAudioEndpoint(int dataFlow, int role);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [return: MarshalAs(UnmanagedType.Interface)] object Activate([In] ref Guid iid, int dwClsCtx, IntPtr p);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
    void GetAudioSessionControl(); void GetSimpleAudioVolume();
    [return: MarshalAs(UnmanagedType.Interface)] object GetSessionEnumerator();
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
    int GetCount();
    [return: MarshalAs(UnmanagedType.Interface)] object GetSession(int i);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
    int GetState();
    [return: MarshalAs(UnmanagedType.BStr)] string GetDisplayName();
    void SetDisplayName([MarshalAs(UnmanagedType.BStr)] string v, [In] ref Guid g);
    [return: MarshalAs(UnmanagedType.BStr)] string GetIconPath();
    void SetIconPath([MarshalAs(UnmanagedType.BStr)] string v, [In] ref Guid g);
    Guid GetGroupingParam();
    void SetGroupingParam([In] ref Guid grp, [In] ref Guid ctx);
    void RegisterAudioSessionNotification([MarshalAs(UnmanagedType.Interface)] object e);
    void UnregisterAudioSessionNotification([MarshalAs(UnmanagedType.Interface)] object e);
    [return: MarshalAs(UnmanagedType.BStr)] string GetSessionIdentifier();
    // Returns LPWSTR (CoTaskMem), not BSTR: marshal by hand or the CLR frees it wrongly.
    IntPtr GetSessionInstanceIdentifier();
    uint GetProcessId();
    [PreserveSig] int IsSystemSoundsSession();
    void SetDuckingPreference(bool b);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
    void SetMasterVolume(float f, [In] ref Guid g);
    float GetMasterVolume();
    void SetMute(bool b, [In] ref Guid g);
    bool GetMute();
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
    float GetPeakValue();
}

class SessionInfo {
    public int Pid;
    public string Name;
    public int State;
    public bool Muted;
    public bool Playing;
    public float Peak;
    public string InstanceId;
    public object SessionObj;
    public IAudioSessionControl2 Ctrl;
    public ISimpleAudioVolume Volume;
    public IAudioMeterInformation Meter;
}

class DuckRule {
    public HashSet<string> Triggers;
    public HashSet<string> Targets;
    public float Factor;
}

public class WinAudio {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);

    static string GetProcessNameByPid(int pid) {
        try {
            return Process.GetProcessById(pid).ProcessName.ToLower();
        } catch {
            return "";
        }
    }

    static int GetFocusedProcessId() {
        try {
            var hwnd = GetForegroundWindow();
            int pid;
            GetWindowThreadProcessId(hwnd, out pid);
            return pid > 0 ? pid : 0;
        } catch {
            return 0;
        }
    }

        static string GetWindowTitle(IntPtr hwnd) {
          try {
            int length = GetWindowTextLength(hwnd);
            if (length <= 0) return "";
            var sb = new StringBuilder(length + 1);
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
          } catch {
            return "";
          }
        }

    static HashSet<int> MutedByUs = new HashSet<int>();
    static HashSet<string> MutedProcessNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    // Session instance id -> volume captured before we ducked it.
    static Dictionary<string, float> DuckedOriginals = new Dictionary<string, float>();
    // Session instance id -> last tick the session actually emitted sound.
    static Dictionary<string, long> LastAudibleTicks = new Dictionary<string, long>();
    // Browsers keep a paused session Active for ~20s, so treat silence as stopped
    // after a short hold that still bridges gaps between tracks.
    const float PeakSilenceThreshold = 0.0005f;
    const long PlayingHoldMs = 1500;

    static string ReadCoTaskString(IntPtr ptr) {
      if (ptr == IntPtr.Zero) return "";
      try {
        return Marshal.PtrToStringUni(ptr);
      } finally {
        Marshal.FreeCoTaskMem(ptr);
      }
    }

    static string NormalizeProcessName(string name) {
      if (name == null) return "";
      var normalized = name.Trim().ToLower();
      if (normalized.EndsWith(".exe")) {
        normalized = normalized.Substring(0, normalized.Length - 4);
      }
      return normalized;
    }

    static string NormalizeIdentityToken(string value) {
      var normalized = NormalizeProcessName(value);
      if (String.IsNullOrEmpty(normalized)) return "";
      var sb = new StringBuilder(normalized.Length);
      for (int i = 0; i < normalized.Length; i++) {
        char c = normalized[i];
        if (Char.IsLetterOrDigit(c)) sb.Append(c);
      }
      return sb.ToString();
    }

    static bool TokenMatches(string a, string b) {
      if (String.IsNullOrEmpty(a) || String.IsNullOrEmpty(b)) return false;
      if (a == b) return true;
      if (a.Length >= 5 && b.IndexOf(a, StringComparison.OrdinalIgnoreCase) >= 0) return true;
      if (b.Length >= 5 && a.IndexOf(b, StringComparison.OrdinalIgnoreCase) >= 0) return true;
      return false;
    }

    static bool ForegroundMatchesSession(int sessionPid, string sessionName, int focusedPid, string focusedName, string focusedTitle) {
      if (focusedPid > 0 && sessionPid == focusedPid) return true;
      string sessionToken = NormalizeIdentityToken(sessionName);
      string focusedNameToken = NormalizeIdentityToken(focusedName);
      string focusedTitleToken = NormalizeIdentityToken(focusedTitle);
      if (TokenMatches(sessionToken, focusedNameToken)) return true;
      if (TokenMatches(sessionToken, focusedTitleToken)) return true;
      return false;
    }

    static HashSet<string> ParseProcessList(string text) {
      var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      if (String.IsNullOrEmpty(text)) return set;

      var parts = text.Split(new char[] { '\\n' }, StringSplitOptions.RemoveEmptyEntries);
      for (int i = 0; i < parts.Length; i++) {
        var normalized = NormalizeProcessName(parts[i]);
        if (!String.IsNullOrEmpty(normalized)) set.Add(normalized);
      }
      return set;
    }

    static HashSet<string> ParseCsvList(string text) {
      var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      if (String.IsNullOrEmpty(text)) return set;

      var parts = text.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
      for (int i = 0; i < parts.Length; i++) {
        var normalized = NormalizeProcessName(parts[i]);
        if (!String.IsNullOrEmpty(normalized)) set.Add(normalized);
      }
      return set;
    }

    // One rule per line: "triggers,csv|targets,csv|reducePercent"
    static List<DuckRule> ParseDuckRules(string text) {
      var rules = new List<DuckRule>();
      if (String.IsNullOrEmpty(text)) return rules;

      var lines = text.Split(new char[] { '\\n' }, StringSplitOptions.RemoveEmptyEntries);
      for (int i = 0; i < lines.Length; i++) {
        var parts = lines[i].Split(new char[] { '|' });
        if (parts.Length < 3) continue;

        var rule = new DuckRule();
        rule.Triggers = ParseCsvList(parts[0]);
        rule.Targets = ParseCsvList(parts[1]);
        if (rule.Triggers.Count == 0 || rule.Targets.Count == 0) continue;

        int percent = 0;
        Int32.TryParse(parts[2].Trim(), out percent);
        if (percent < 0) percent = 0;
        if (percent > 95) percent = 95;
        rule.Factor = 1.0f - (percent / 100.0f);
        rules.Add(rule);
      }
      return rules;
    }

    static bool ShouldMuteProcess(string processName, bool isFocused, string mode, HashSet<string> whitelist, HashSet<string> blacklist) {
      if (mode == "blacklist") {
        return blacklist.Contains(processName) && !isFocused;
      }
      return !whitelist.Contains(processName) && !isFocused;
    }

    static bool IsManagedProcess(string processName, string mode, HashSet<string> whitelist, HashSet<string> blacklist) {
      if (mode == "blacklist") return blacklist.Contains(processName);
      return !whitelist.Contains(processName);
    }

    public static List<string> ApplyRules(string mode, string whitelistText, string blacklistText, string duckRulesText, bool muteEnabled) {
      var results = new List<string>();
      var whitelist = ParseProcessList(whitelistText);
      var blacklist = ParseProcessList(blacklistText);
      var duckRules = ParseDuckRules(duckRulesText);
      var focusedHwnd = GetForegroundWindow();
      int focusedPid = 0;
      try { GetWindowThreadProcessId(focusedHwnd, out focusedPid); } catch { focusedPid = 0; }
      var focusedName = focusedPid > 0 ? GetProcessNameByPid(focusedPid) : "";
      var focusedTitle = GetWindowTitle(focusedHwnd);
      var activeProcessIds = new HashSet<int>();
      results.Add("FOCUSED:" + focusedPid);

      IMMDeviceEnumerator deviceEnum = null;
      IMMDevice device = null;
      IAudioSessionManager2 sessionManager = null;
      IAudioSessionEnumerator sessionEnum = null;
      var sessions = new List<SessionInfo>();

      try {
        deviceEnum = (IMMDeviceEnumerator)new CMMDeviceEnumerator();
        device = (IMMDevice)deviceEnum.GetDefaultAudioEndpoint(0, 0);

        var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        sessionManager = (IAudioSessionManager2)device.Activate(ref iid, 1, IntPtr.Zero);
        sessionEnum = (IAudioSessionEnumerator)sessionManager.GetSessionEnumerator();

        int count = sessionEnum.GetCount();
        var g = Guid.Empty;

        for (int i = 0; i < count; i++) {
          object sessionObj = null;
          IAudioSessionControl2 ctrl = null;
          bool retained = false;

          try {
            sessionObj = sessionEnum.GetSession(i);
            ctrl = sessionObj as IAudioSessionControl2;
            if (ctrl == null) continue;

            int sessionPid = (int)ctrl.GetProcessId();
            if (sessionPid == 0) continue;

            string name = NormalizeProcessName(GetProcessNameByPid(sessionPid));
            if (String.IsNullOrEmpty(name)) continue;

            var info = new SessionInfo();
            info.Pid = sessionPid;
            info.Name = name;
            info.SessionObj = sessionObj;
            info.Ctrl = ctrl;
            info.Volume = sessionObj as ISimpleAudioVolume;
            info.Meter = sessionObj as IAudioMeterInformation;
            try { info.State = ctrl.GetState(); } catch { info.State = 0; }
            try { info.InstanceId = ReadCoTaskString(ctrl.GetSessionInstanceIdentifier()); } catch { info.InstanceId = ""; }
            if (String.IsNullOrEmpty(info.InstanceId)) info.InstanceId = sessionPid + "#" + i;
            try { info.Muted = info.Volume != null && info.Volume.GetMute(); } catch { info.Muted = false; }
            info.Peak = -1.0f;
            if (info.Meter != null) {
              try { info.Peak = info.Meter.GetPeakValue(); } catch { info.Peak = -1.0f; }
            }
            info.Playing = IsSessionPlaying(info);

            sessions.Add(info);
            activeProcessIds.Add(sessionPid);
            retained = true;
          } finally {
            if (!retained) {
              if (ctrl != null && Marshal.IsComObject(ctrl)) Marshal.ReleaseComObject(ctrl);
              if (sessionObj != null && Marshal.IsComObject(sessionObj)) Marshal.ReleaseComObject(sessionObj);
            }
          }
        }

        for (int i = 0; i < sessions.Count; i++) {
          var s = sessions[i];
          bool isFocused = ForegroundMatchesSession(s.Pid, s.Name, focusedPid, focusedName, focusedTitle);
          bool focusUnknown = focusedPid <= 0 && String.IsNullOrEmpty(focusedName) && String.IsNullOrEmpty(focusedTitle);
          bool wasManagedByUs = MutedByUs.Contains(s.Pid) || MutedProcessNames.Contains(s.Name);
          // Fullscreen games can briefly make GetForegroundWindow return
          // no usable process id after focus transitions. In that case,
          // fail open for sessions we already muted, otherwise a game can
          // remain stuck muted indefinitely even though the user returned
          // to it.
          bool shouldTreatAsFocused = isFocused || (focusUnknown && wasManagedByUs);
          bool shouldMute = muteEnabled && ShouldMuteProcess(s.Name, shouldTreatAsFocused, mode, whitelist, blacklist);
          bool currentMuted = s.Muted;

          if (s.Volume != null && shouldMute) {
            if (!currentMuted) {
              try {
                s.Volume.SetMute(true, ref g);
                currentMuted = true;
              } catch {}
            }
            if (currentMuted) {
              MutedByUs.Add(s.Pid);
              MutedProcessNames.Add(s.Name);
            }
          } else if (s.Volume != null && !shouldMute && currentMuted) {
            if (wasManagedByUs || shouldTreatAsFocused) {
              try {
                s.Volume.SetMute(false, ref g);
                currentMuted = false;
                MutedByUs.Remove(s.Pid);
              } catch {}
            }
          }

          s.Muted = currentMuted;
        }

        ApplyDuckingRules(sessions, duckRules);

        for (int i = 0; i < sessions.Count; i++) {
          var s = sessions[i];
          bool ducked = s.InstanceId != null && DuckedOriginals.ContainsKey(s.InstanceId);
          results.Add("SESSION:" + s.Pid + "|" + s.Name + "|" + (s.Muted ? "1" : "0") + "|" + (s.Playing ? "1" : "0") + "|" + (ducked ? "1" : "0"));
        }

        var deadPids = new List<int>();
        foreach (var pid in MutedByUs) {
          if (!activeProcessIds.Contains(pid)) deadPids.Add(pid);
        }
        for (int i = 0; i < deadPids.Count; i++) MutedByUs.Remove(deadPids[i]);
      } catch (Exception ex) {
        results.Add("ERR:" + ex.Message);
      } finally {
        for (int i = 0; i < sessions.Count; i++) {
          var s = sessions[i];
          if (s.Meter != null && Marshal.IsComObject(s.Meter)) Marshal.ReleaseComObject(s.Meter);
          if (s.Volume != null && Marshal.IsComObject(s.Volume)) Marshal.ReleaseComObject(s.Volume);
          if (s.Ctrl != null && Marshal.IsComObject(s.Ctrl)) Marshal.ReleaseComObject(s.Ctrl);
          if (s.SessionObj != null && Marshal.IsComObject(s.SessionObj)) Marshal.ReleaseComObject(s.SessionObj);
        }
        if (sessionEnum != null && Marshal.IsComObject(sessionEnum)) Marshal.ReleaseComObject(sessionEnum);
        if (sessionManager != null && Marshal.IsComObject(sessionManager)) Marshal.ReleaseComObject(sessionManager);
        if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device);
        if (deviceEnum != null && Marshal.IsComObject(deviceEnum)) Marshal.ReleaseComObject(deviceEnum);
      }

      return results;
    }

    static bool IsSessionPlaying(SessionInfo info) {
      if (info.State != 1) return false;

      // No meter available: fall back to session state alone.
      if (info.Peak < 0.0f) return true;

      long nowTicks = DateTime.UtcNow.Ticks;
      if (info.Peak > PeakSilenceThreshold) {
        if (!String.IsNullOrEmpty(info.InstanceId)) LastAudibleTicks[info.InstanceId] = nowTicks;
        return true;
      }

      if (String.IsNullOrEmpty(info.InstanceId)) return false;
      if (!LastAudibleTicks.ContainsKey(info.InstanceId)) return false;

      long elapsedMs = (nowTicks - LastAudibleTicks[info.InstanceId]) / TimeSpan.TicksPerMillisecond;
      return elapsedMs < PlayingHoldMs;
    }

    static void ApplyDuckingRules(List<SessionInfo> sessions, List<DuckRule> rules) {
      var g = Guid.Empty;
      var liveIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      for (int i = 0; i < sessions.Count; i++) {
        if (!String.IsNullOrEmpty(sessions[i].InstanceId)) liveIds.Add(sessions[i].InstanceId);
      }

      // Sessions that vanished while ducked can never be restored; drop them
      // so the map does not grow across the lifetime of the worker.
      var staleIds = new List<string>();
      foreach (var key in DuckedOriginals.Keys) {
        if (!liveIds.Contains(key)) staleIds.Add(key);
      }
      for (int i = 0; i < staleIds.Count; i++) DuckedOriginals.Remove(staleIds[i]);

      var staleMeterIds = new List<string>();
      foreach (var key in LastAudibleTicks.Keys) {
        if (!liveIds.Contains(key)) staleMeterIds.Add(key);
      }
      for (int i = 0; i < staleMeterIds.Count; i++) LastAudibleTicks.Remove(staleMeterIds[i]);

      var wanted = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
      for (int r = 0; r < rules.Count; r++) {
        var rule = rules[r];

        bool triggerPlaying = false;
        for (int i = 0; i < sessions.Count; i++) {
          var s = sessions[i];
          if (s.Playing && !s.Muted && rule.Triggers.Contains(s.Name)) { triggerPlaying = true; break; }
        }
        if (!triggerPlaying) continue;

        for (int i = 0; i < sessions.Count; i++) {
          var s = sessions[i];
          if (s.Volume == null || String.IsNullOrEmpty(s.InstanceId)) continue;
          if (rule.Triggers.Contains(s.Name)) continue;
          if (!rule.Targets.Contains(s.Name)) continue;

          if (wanted.ContainsKey(s.InstanceId)) {
            if (rule.Factor < wanted[s.InstanceId]) wanted[s.InstanceId] = rule.Factor;
          } else {
            wanted[s.InstanceId] = rule.Factor;
          }
        }
      }

      for (int i = 0; i < sessions.Count; i++) {
        var s = sessions[i];
        if (s.Volume == null || String.IsNullOrEmpty(s.InstanceId)) continue;

        bool shouldDuck = wanted.ContainsKey(s.InstanceId);
        bool isDucked = DuckedOriginals.ContainsKey(s.InstanceId);

        if (shouldDuck) {
          float original;
          if (isDucked) {
            original = DuckedOriginals[s.InstanceId];
          } else {
            try { original = s.Volume.GetMasterVolume(); } catch { continue; }
            DuckedOriginals[s.InstanceId] = original;
          }

          float target = original * wanted[s.InstanceId];
          if (target < 0.0f) target = 0.0f;
          if (target > 1.0f) target = 1.0f;

          try {
            float current = s.Volume.GetMasterVolume();
            if (Math.Abs(current - target) > 0.01f) s.Volume.SetMasterVolume(target, ref g);
          } catch {}
        } else if (isDucked) {
          float original = DuckedOriginals[s.InstanceId];
          try { s.Volume.SetMasterVolume(original, ref g); } catch {}
          DuckedOriginals.Remove(s.InstanceId);
        }
      }
    }

    public static void ClearDucking() {
      if (DuckedOriginals.Count == 0) return;

      IMMDeviceEnumerator deviceEnum = null;
      IMMDevice device = null;
      IAudioSessionManager2 sessionManager = null;
      IAudioSessionEnumerator sessionEnum = null;

      try {
        deviceEnum = (IMMDeviceEnumerator)new CMMDeviceEnumerator();
        device = (IMMDevice)deviceEnum.GetDefaultAudioEndpoint(0, 0);

        var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        sessionManager = (IAudioSessionManager2)device.Activate(ref iid, 1, IntPtr.Zero);
        sessionEnum = (IAudioSessionEnumerator)sessionManager.GetSessionEnumerator();

        int count = sessionEnum.GetCount();
        var g = Guid.Empty;

        for (int i = 0; i < count; i++) {
          object sessionObj = null;
          IAudioSessionControl2 ctrl = null;
          ISimpleAudioVolume volume = null;

          try {
            sessionObj = sessionEnum.GetSession(i);
            ctrl = sessionObj as IAudioSessionControl2;
            if (ctrl == null) continue;

            string instanceId = "";
            try { instanceId = ReadCoTaskString(ctrl.GetSessionInstanceIdentifier()); } catch { instanceId = ""; }
            if (String.IsNullOrEmpty(instanceId) || !DuckedOriginals.ContainsKey(instanceId)) continue;

            volume = sessionObj as ISimpleAudioVolume;
            if (volume != null) {
              try { volume.SetMasterVolume(DuckedOriginals[instanceId], ref g); } catch {}
            }
          } finally {
            if (volume != null && Marshal.IsComObject(volume)) Marshal.ReleaseComObject(volume);
            if (ctrl != null && Marshal.IsComObject(ctrl)) Marshal.ReleaseComObject(ctrl);
            if (sessionObj != null && Marshal.IsComObject(sessionObj)) Marshal.ReleaseComObject(sessionObj);
          }
        }
      } catch {}
      finally {
        DuckedOriginals.Clear();
        if (sessionEnum != null && Marshal.IsComObject(sessionEnum)) Marshal.ReleaseComObject(sessionEnum);
        if (sessionManager != null && Marshal.IsComObject(sessionManager)) Marshal.ReleaseComObject(sessionManager);
        if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device);
        if (deviceEnum != null && Marshal.IsComObject(deviceEnum)) Marshal.ReleaseComObject(deviceEnum);
      }
    }

    public static void ClearManagedMutes(string mode, string whitelistText, string blacklistText) {
      var whitelist = ParseProcessList(whitelistText);
      var blacklist = ParseProcessList(blacklistText);

      IMMDeviceEnumerator deviceEnum = null;
      IMMDevice device = null;
      IAudioSessionManager2 sessionManager = null;
      IAudioSessionEnumerator sessionEnum = null;

      try {
        deviceEnum = (IMMDeviceEnumerator)new CMMDeviceEnumerator();
        device = (IMMDevice)deviceEnum.GetDefaultAudioEndpoint(0, 0);

        var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        sessionManager = (IAudioSessionManager2)device.Activate(ref iid, 1, IntPtr.Zero);
        sessionEnum = (IAudioSessionEnumerator)sessionManager.GetSessionEnumerator();

        int count = sessionEnum.GetCount();
        var g = Guid.Empty;

        for (int i = 0; i < count; i++) {
          object sessionObj = null;
          IAudioSessionControl2 ctrl = null;
          ISimpleAudioVolume volume = null;

          try {
            sessionObj = sessionEnum.GetSession(i);
            ctrl = sessionObj as IAudioSessionControl2;
            if (ctrl == null) continue;

            int sessionPid = (int)ctrl.GetProcessId();
            if (sessionPid == 0) continue;

            string name = NormalizeProcessName(GetProcessNameByPid(sessionPid));
            if (String.IsNullOrEmpty(name)) continue;

            bool shouldClear = MutedByUs.Contains(sessionPid) || MutedProcessNames.Contains(name) || IsManagedProcess(name, mode, whitelist, blacklist);
            if (!shouldClear) continue;

            volume = sessionObj as ISimpleAudioVolume;
            if (volume != null) {
              try { volume.SetMute(false, ref g); } catch {}
            }
          } finally {
            if (volume != null && Marshal.IsComObject(volume)) Marshal.ReleaseComObject(volume);
            if (ctrl != null && Marshal.IsComObject(ctrl)) Marshal.ReleaseComObject(ctrl);
            if (sessionObj != null && Marshal.IsComObject(sessionObj)) Marshal.ReleaseComObject(sessionObj);
          }
        }
      } catch {}
      finally {
        MutedByUs.Clear();
        MutedProcessNames.Clear();
        if (sessionEnum != null && Marshal.IsComObject(sessionEnum)) Marshal.ReleaseComObject(sessionEnum);
        if (sessionManager != null && Marshal.IsComObject(sessionManager)) Marshal.ReleaseComObject(sessionManager);
        if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device);
        if (deviceEnum != null && Marshal.IsComObject(deviceEnum)) Marshal.ReleaseComObject(deviceEnum);
      }
    }

    public static List<string> ListSessions() {
        var results = new List<string>();
        var focusedPid = GetFocusedProcessId();
        results.Add("FOCUSED:" + focusedPid);
        
        IMMDeviceEnumerator deviceEnum = null;
        IMMDevice device = null;
        IAudioSessionManager2 sessionManager = null;
        IAudioSessionEnumerator sessionEnum = null;

        try {
            deviceEnum = (IMMDeviceEnumerator)new CMMDeviceEnumerator();
            device = (IMMDevice)deviceEnum.GetDefaultAudioEndpoint(0, 0);
            
            var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            sessionManager = (IAudioSessionManager2)device.Activate(ref iid, 1, IntPtr.Zero);
            sessionEnum = (IAudioSessionEnumerator)sessionManager.GetSessionEnumerator();

            int count = sessionEnum.GetCount();
            for (int i = 0; i < count; i++) {
                object sessionObj = null;
                IAudioSessionControl2 ctrl = null;
                ISimpleAudioVolume volume = null;

                try {
                    sessionObj = sessionEnum.GetSession(i);
                    ctrl = sessionObj as IAudioSessionControl2;
                    if (ctrl == null) {
                        results.Add("DBG:session_" + i + "_no_ctrl2");
                        continue;
                    }

                    uint sessionPid = ctrl.GetProcessId();
                    // System sounds session has pid == 0; skip it (matches SilentFocus approach)
                    if (sessionPid == 0) continue;

                    volume = sessionObj as ISimpleAudioVolume;
                    bool muted = volume != null && volume.GetMute();
                    string name = GetProcessNameByPid((int)sessionPid);
                    
                    if (!string.IsNullOrEmpty(name)) {
                        results.Add("SESSION:" + sessionPid + "|" + name + "|" + (muted ? "1" : "0"));
                    } else {
                        results.Add("DBG:pid_" + sessionPid + "_no_name");
                    }
                } finally {
                    if (volume != null && Marshal.IsComObject(volume)) Marshal.ReleaseComObject(volume);
                    if (ctrl != null && Marshal.IsComObject(ctrl)) Marshal.ReleaseComObject(ctrl);
                    if (sessionObj != null && Marshal.IsComObject(sessionObj)) Marshal.ReleaseComObject(sessionObj);
                }
            }
        } catch (Exception ex) {
            results.Add("ERR:" + ex.Message);
        } finally {
            if (sessionEnum != null && Marshal.IsComObject(sessionEnum)) Marshal.ReleaseComObject(sessionEnum);
            if (sessionManager != null && Marshal.IsComObject(sessionManager)) Marshal.ReleaseComObject(sessionManager);
            if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device);
            if (deviceEnum != null && Marshal.IsComObject(deviceEnum)) Marshal.ReleaseComObject(deviceEnum);
        }

        return results;
    }

    public static void SetMute(int pid, bool mute) {
        IMMDeviceEnumerator deviceEnum = null;
        IMMDevice device = null;
        IAudioSessionManager2 sessionManager = null;
        IAudioSessionEnumerator sessionEnum = null;

        try {
            deviceEnum = (IMMDeviceEnumerator)new CMMDeviceEnumerator();
            device = (IMMDevice)deviceEnum.GetDefaultAudioEndpoint(0, 0);
            
            var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            sessionManager = (IAudioSessionManager2)device.Activate(ref iid, 1, IntPtr.Zero);
            sessionEnum = (IAudioSessionEnumerator)sessionManager.GetSessionEnumerator();

            int count = sessionEnum.GetCount();
            var g = Guid.Empty;

            for (int i = 0; i < count; i++) {
                object sessionObj = null;
                IAudioSessionControl2 ctrl = null;
                ISimpleAudioVolume volume = null;

                try {
                    sessionObj = sessionEnum.GetSession(i);
                    ctrl = sessionObj as IAudioSessionControl2;
                    if (ctrl == null) continue;

                    if ((int)ctrl.GetProcessId() != pid) continue;

                    volume = sessionObj as ISimpleAudioVolume;
                    if (volume != null) {
                        try { volume.SetMute(mute, ref g); } catch {}
                    }
                    // NOTE: do not break - some processes (e.g. games like War Thunder,
                    // Helldivers 2) own multiple audio sessions for engine sounds, music
                    // and voice. We must mute/unmute every session for the PID.
                } finally {
                    if (volume != null && Marshal.IsComObject(volume)) Marshal.ReleaseComObject(volume);
                    if (ctrl != null && Marshal.IsComObject(ctrl)) Marshal.ReleaseComObject(ctrl);
                    if (sessionObj != null && Marshal.IsComObject(sessionObj)) Marshal.ReleaseComObject(sessionObj);
                }
            }
        } catch {}
        finally {
            if (sessionEnum != null && Marshal.IsComObject(sessionEnum)) Marshal.ReleaseComObject(sessionEnum);
            if (sessionManager != null && Marshal.IsComObject(sessionManager)) Marshal.ReleaseComObject(sessionManager);
            if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device);
            if (deviceEnum != null && Marshal.IsComObject(deviceEnum)) Marshal.ReleaseComObject(deviceEnum);
        }
    }
}
`;

// ─── Persistent PowerShell worker ────────────────────────────────────────────
// Protocol uses a request id prefix so stale replies (from commands that
// timed out on our side but eventually completed) cannot be misrouted to a
// later request. Format:
//   request : "<id>:LIST"  or  "<id>:MUTE:<pid>:<true|false>"
//   reply   : "<id>:<line>"            (data, only for LIST)
//             "<id>:END" or "<id>:OK"  (terminator)
const WORKER_PS1 = `
Add-Type -TypeDefinition @"
${CSHARP_TYPES}
"@

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

function Decode-B64Text($value) {
  if ([string]::IsNullOrEmpty($value)) { return "" }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    $line = $line.Trim()

    if ($line -match "^([0-9]+):(.*)$") {
        $reqId = $Matches[1]
        $cmd = $Matches[2]

        if ($cmd -eq "LIST") {
            try {
                $results = [WinAudio]::ListSessions()
                foreach ($r in $results) { [Console]::Out.WriteLine($reqId + ":" + $r) }
            } catch {
                [Console]::Out.WriteLine($reqId + ":ERR:" + $_.Exception.Message)
            }
            [Console]::Out.WriteLine($reqId + ":END")
            [Console]::Out.Flush()
        } elseif ($cmd -match "^APPLY:(whitelist|blacklist):([^:]*):([^:]*):([^:]*):(true|false)$") {
          $mode = $Matches[1]
          $whitelistText = Decode-B64Text $Matches[2]
          $blacklistText = Decode-B64Text $Matches[3]
          $duckText = Decode-B64Text $Matches[4]
          $muteEnabled = $Matches[5] -eq "true"
          try {
            $results = [WinAudio]::ApplyRules($mode, $whitelistText, $blacklistText, $duckText, $muteEnabled)
            foreach ($r in $results) { [Console]::Out.WriteLine($reqId + ":" + $r) }
          } catch {
            [Console]::Out.WriteLine($reqId + ":ERR:" + $_.Exception.Message)
          }
          [Console]::Out.WriteLine($reqId + ":END")
          [Console]::Out.Flush()
        } elseif ($cmd -eq "CLEARDUCK") {
          try {
            [WinAudio]::ClearDucking()
          } catch {}
          [Console]::Out.WriteLine($reqId + ":OK")
          [Console]::Out.Flush()
        } elseif ($cmd -match "^CLEAR:(whitelist|blacklist):([^:]*):([^:]*)$") {
          $mode = $Matches[1]
          $whitelistText = Decode-B64Text $Matches[2]
          $blacklistText = Decode-B64Text $Matches[3]
          try {
            [WinAudio]::ClearManagedMutes($mode, $whitelistText, $blacklistText)
          } catch {}
          [Console]::Out.WriteLine($reqId + ":OK")
          [Console]::Out.Flush()
        } elseif ($cmd -match "^MUTE:(\\d+):(true|false)$") {
            $targetPid = [int]$Matches[1]
            $mute = $Matches[2] -eq "true"
            try {
                [WinAudio]::SetMute($targetPid, $mute)
            } catch {}
            [Console]::Out.WriteLine($reqId + ":OK")
            [Console]::Out.Flush()
        } elseif ($cmd -eq "EXIT") {
            break
        }
    }
}
`;

interface AudioSession {
  pid: number;
  processName: string;
  muted: boolean;
  playing: boolean;
  ducked: boolean;
}

interface PendingRequest {
  resolve: (lines: string[]) => void;
  lines: string[];
  timer: NodeJS.Timeout;
  cmd: string;
}

interface WorkerState {
  proc: ChildProcessWithoutNullStreams;
  buffer: string;
  ready: boolean;
  pending: Map<number, PendingRequest>;
  nextId: number;
}

export class FocusAudioManager {
  private config: FocusAudioConfig;
  private configPath: string;
  private timer: NodeJS.Timeout | null = null;
  private mutedByUs: Set<number> = new Set();
  private mutedProcessNames: Set<string> = new Set();
  private whitelistCache: Set<string> = new Set();
  private blacklistCache: Set<string> = new Set();
  private worker: WorkerState | null = null;
  private workerScriptPath: string;
  private legacyWorkerScriptPath: string;
  private workerReady = false;
  private workerReadyCallbacks: Array<() => void> = [];
  private workerQueue: Promise<unknown> = Promise.resolve();
  private tickInFlight = false;
  // Cache the last successful session enumeration so a transient worker
  // timeout/restart doesn't blank the Active Audio Apps UI list.
  private lastSessions: AudioSession[] = [];
  private lastFocusedPid = 0;
  private duckRuleCache: FocusAudioDuckRule[] = [];

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'focusAudio.json');
    this.workerScriptPath = path.join(os.tmpdir(), `WinUtils-audioWorker-${process.pid}.ps1`);
    this.legacyWorkerScriptPath = path.join(os.tmpdir(), 'WinUtils-audioWorker.ps1');
    this.config = this._loadConfig();
    this._updateCaches();
    this._writeWorkerScript();
  }

  private _writeWorkerScript(): void {
    let wrotePrimary = false;
    try {
      fs.writeFileSync(this.workerScriptPath, WORKER_PS1, 'utf8');
      wrotePrimary = true;
    } catch { /* ignore */ }

    // Keep legacy filename in sync as well so manual diagnostics and any
    // lingering external references use the current worker script.
    try {
      fs.writeFileSync(this.legacyWorkerScriptPath, WORKER_PS1, 'utf8');
    } catch { /* ignore */ }

    if (!wrotePrimary) {
      this.workerScriptPath = this.legacyWorkerScriptPath;
    }
  }

  private _debugLog(msg: string): void {
    if (!process.env.WINUTILS_FOCUS_AUDIO_DEBUG) return;
    try {
      const logPath = path.join(os.tmpdir(), 'WinUtils-focusAudio-debug.log');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch { /* ignore */ }
  }

  private _startWorker(): void {
    if (this.worker) return;

    this._debugLog(`Starting worker: ${this.workerScriptPath}`);
    const proc = spawn('powershell.exe', [
      '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', this.workerScriptPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this._debugLog(`Worker spawned, pid=${proc.pid}`);

    const state: WorkerState = {
      proc,
      buffer: '',
      ready: false,
      pending: new Map<number, PendingRequest>(),
      nextId: 1,
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      state.buffer += chunk.toString('utf8');
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trimEnd();
        this._debugLog(`STDOUT: ${line}`);
        if (!state.ready) {
          if (line === 'READY') {
            state.ready = true;
            this.workerReady = true;
            this._flushWorkerReadyCallbacks();
          }
          continue;
        }

        // All post-READY lines are tagged with the request id: "<id>:<rest>".
        // Untagged lines are stale junk from a worker restart and are dropped.
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const idStr = line.slice(0, colon);
        const rest = line.slice(colon + 1);
        const id = parseInt(idStr, 10);
        if (!Number.isFinite(id)) continue;

        const req = state.pending.get(id);
        if (!req) continue; // request already timed out / was abandoned

        if (rest === 'END' || rest === 'OK') {
          clearTimeout(req.timer);
          state.pending.delete(id);
          req.resolve(req.lines);
        } else {
          req.lines.push(rest);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      this._debugLog(`STDERR: ${chunk.toString('utf8').trimEnd()}`);
    });

    proc.on('exit', (code, signal) => {
      this._debugLog(`Worker exited code=${code} signal=${signal}`);
      // Drain pending requests so callers don't hang forever after a crash.
      for (const [, req] of state.pending) {
        clearTimeout(req.timer);
        req.resolve([]);
      }
      state.pending.clear();

      if (this.worker === state) {
        this.worker = null;
        this.workerReady = false;
        this._flushWorkerReadyCallbacks();
        if (this.timer) {
          setTimeout(() => {
            if (this.timer && !this.worker) this._startWorker();
          }, 3000);
        }
      }
    });

    this.worker = state;
  }

  private _flushWorkerReadyCallbacks(): void {
    const callbacks = this.workerReadyCallbacks.splice(0);
    for (const callback of callbacks) callback();
  }

  private _workerReady(): Promise<void> {
    if (this.workerReady && this.worker) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this._debugLog('Worker READY timeout');
        this._killWorker('ready timeout');
        finish();
      }, 8000);
      this.workerReadyCallbacks.push(finish);
      if (!this.worker) this._startWorker();
    });
  }

  private async _workerSend(cmd: string, timeoutMs = 4000): Promise<string[]> {
    const run = (): Promise<string[]> => this._workerSendNow(cmd, timeoutMs);
    const result = this.workerQueue.then(run, run);
    this.workerQueue = result.catch(() => undefined);
    return result;
  }

  private _killWorker(reason: string): void {
    const worker = this.worker;
    this._debugLog(`Killing worker: ${reason}`);

    if (worker) {
      for (const [, req] of worker.pending) {
        clearTimeout(req.timer);
        req.resolve([]);
      }
      worker.pending.clear();
      try { worker.proc.kill(); } catch { /* ignore */ }
    }

    this.worker = null;
    this.workerReady = false;
    this._flushWorkerReadyCallbacks();
  }

  private async _workerSendNow(cmd: string, timeoutMs = 4000): Promise<string[]> {
    await this._workerReady();
    if (!this.worker || !this.workerReady) return [];
    const w = this.worker!;
    return new Promise((resolve) => {
      const id = w.nextId++;
      const req: PendingRequest = {
        resolve,
        lines: [],
        cmd,
        timer: setTimeout(() => {
          if (!w.pending.has(id)) return;
          this._debugLog(`workerSend TIMEOUT id=${id} after ${timeoutMs}ms cmd=${cmd}`);
          w.pending.delete(id);
          resolve([]);
          // A timeout means the PowerShell process may still be blocked inside
          // the COM call. Restart it so later commands are not queued behind
          // a worker that Node has already abandoned.
          this._killWorker(`timeout id=${id} cmd=${cmd}`);
        }, timeoutMs),
      };
      w.pending.set(id, req);
      try {
        w.proc.stdin.write(`${id}:${cmd}\n`);
      } catch (err) {
        this._debugLog(`workerSend stdin write error: ${(err as Error)?.message}`);
        clearTimeout(req.timer);
        w.pending.delete(id);
        resolve([]);
      }
    });
  }

  private _loadConfig(): FocusAudioConfig {
    const defaults: FocusAudioConfig = {
      enabled: false,
      mode: 'whitelist',
      whitelist: ['Spotify.exe', 'Discord.exe'],
      blacklist: [],
      duckingEnabled: false,
      duckRules: [],
    };
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = { ...defaults, ...JSON.parse(raw) } as FocusAudioConfig;
        parsed.duckingEnabled = Boolean(parsed.duckingEnabled);
        parsed.duckRules = this._normalizeDuckRules(parsed.duckRules);
        return parsed;
      }
    } catch { /* fall through */ }
    return defaults;
  }

  private _normalizeDuckRules(rules: unknown): FocusAudioDuckRule[] {
    if (!Array.isArray(rules)) return [];
    const normalized: FocusAudioDuckRule[] = [];

    for (const entry of rules) {
      if (!entry || typeof entry !== 'object') continue;
      const rule = entry as Partial<FocusAudioDuckRule>;
      const triggerApps = Array.isArray(rule.triggerApps) ? rule.triggerApps.filter((name) => typeof name === 'string' && name.trim()) : [];
      const targetApps = Array.isArray(rule.targetApps) ? rule.targetApps.filter((name) => typeof name === 'string' && name.trim()) : [];
      const percent = Number(rule.duckPercent);

      normalized.push({
        id: typeof rule.id === 'string' && rule.id ? rule.id : `duck-${normalized.length + 1}-${Date.now()}`,
        enabled: rule.enabled !== false,
        triggerApps,
        targetApps,
        duckPercent: Number.isFinite(percent) ? Math.max(0, Math.min(95, Math.round(percent))) : 60,
      });
    }

    return normalized;
  }

  private _saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  getConfig(): FocusAudioConfig {
    return {
      ...this.config,
      whitelist: [...this.config.whitelist],
      blacklist: [...this.config.blacklist],
      duckRules: this.config.duckRules.map((rule) => ({ ...rule, triggerApps: [...rule.triggerApps], targetApps: [...rule.targetApps] })),
    };
  }

  getCachedActiveAudioApps(): string[] {
    return [...new Set(this.lastSessions.map((s) => s.processName).filter(Boolean))];
  }

  getCachedPlayingApps(): string[] {
    return [...new Set(this.lastSessions.filter((s) => s.playing).map((s) => s.processName).filter(Boolean))];
  }

  getCachedDuckedApps(): string[] {
    return [...new Set(this.lastSessions.filter((s) => s.ducked).map((s) => s.processName).filter(Boolean))];
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this._saveConfig();
    if (!enabled) {
      void this._unmuteAll();
    }
    if (this._isActive()) void this._tick();
  }

  setDuckingEnabled(enabled: boolean): void {
    this.config.duckingEnabled = enabled;
    this._saveConfig();
    if (!enabled) {
      void this._clearDucking();
    } else if (this._isActive()) {
      void this._tick();
    }
  }

  setDuckRules(rules: FocusAudioDuckRule[]): void {
    this.config.duckRules = this._normalizeDuckRules(rules);
    this._saveConfig();
    this._updateCaches();
    // Rules that no longer apply must hand volume back before the next pulse.
    void this._clearDucking().then(() => {
      if (this._isActive()) void this._tick();
    });
  }

  setMode(mode: 'whitelist' | 'blacklist'): void {
    void this._unmuteAll();
    this.config.mode = mode;
    this._saveConfig();
    if (this.config.enabled) void this._tick();
  }

  setWhitelist(list: string[]): void {
    void this._unmuteAll();
    this.config.whitelist = list;
    this._saveConfig();
    this._updateCaches();
    if (this.config.enabled) void this._tick();
  }

  setBlacklist(list: string[]): void {
    void this._unmuteAll();
    this.config.blacklist = list;
    this._saveConfig();
    this._updateCaches();
    if (this.config.enabled) void this._tick();
  }

  // Normalize a process identifier so list entries with or without ".exe"
  // match the bare names returned by Process.GetProcessById(...).ProcessName.
  // Examples: "Helldivers2.exe" -> "helldivers2", "aces" -> "aces".
  private _normalizeName(raw: string): string {
    let n = raw.trim().toLowerCase();
    if (n.endsWith('.exe')) n = n.slice(0, -4);
    return n;
  }

  private _updateCaches(): void {
    this.whitelistCache.clear();
    this.blacklistCache.clear();
    for (const name of this.config.whitelist) {
      const norm = this._normalizeName(name);
      if (norm) this.whitelistCache.add(norm);
    }
    for (const name of this.config.blacklist) {
      const norm = this._normalizeName(name);
      if (norm) this.blacklistCache.add(norm);
    }
    this.duckRuleCache = this.config.duckRules.filter(
      (rule) => rule.enabled
        && rule.triggerApps.some((name) => this._normalizeName(name))
        && rule.targetApps.some((name) => this._normalizeName(name)),
    );
  }

  private _isActive(): boolean {
    return this.config.enabled || (this.config.duckingEnabled && this.duckRuleCache.length > 0);
  }

  private _encodeDuckRules(): string {
    if (!this.config.duckingEnabled) return '';
    const lines = this.duckRuleCache.map((rule) => {
      const triggers = rule.triggerApps.map((name) => this._normalizeName(name)).filter(Boolean).join(',');
      const targets = rule.targetApps.map((name) => this._normalizeName(name)).filter(Boolean).join(',');
      const percent = Math.max(0, Math.min(95, Math.round(rule.duckPercent)));
      return `${triggers}|${targets}|${percent}`;
    });
    return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
  }

  private _encodeNameList(list: string[]): string {
    const normalized = list
      .map((name) => this._normalizeName(name))
      .filter(Boolean)
      .join('\n');
    return Buffer.from(normalized, 'utf8').toString('base64');
  }

  private _rulesCommand(command: 'APPLY' | 'CLEAR'): string {
    const base = `${command}:${this.config.mode}:${this._encodeNameList(this.config.whitelist)}:${this._encodeNameList(this.config.blacklist)}`;
    if (command === 'CLEAR') return base;
    return `${base}:${this._encodeDuckRules()}:${this.config.enabled ? 'true' : 'false'}`;
  }

  async refreshActiveAudioApps(): Promise<string[]> {
    try {
      // Use a longer timeout here so the UI list doesn't blank out under
      // momentary worker stalls (e.g. while a game is loading and stalls COM).
      const lines = await this._workerSend('LIST', 8000);
      const parsed = this._parseLines(lines);
      if (parsed.sessions.length > 0) {
        this.lastSessions = parsed.sessions;
        this.lastFocusedPid = parsed.focusedPid;
      }
      const source = parsed.sessions.length > 0 ? parsed.sessions : this.lastSessions;
      return [...new Set(source.map((s) => s.processName).filter(Boolean))];
    } catch {
      return [...new Set(this.lastSessions.map((s) => s.processName).filter(Boolean))];
    }
  }

  private _parseLines(lines: string[]): { focusedPid: number; sessions: AudioSession[] } {
    let focusedPid = 0;
    const sessions: AudioSession[] = [];

    for (const line of lines) {
      if (line.startsWith('FOCUSED:')) {
        focusedPid = parseInt(line.slice('FOCUSED:'.length), 10);
      } else if (line.startsWith('SESSION:')) {
        const parts = line.slice('SESSION:'.length).split('|');
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const processName = parts[1] || '';
          const muted = parts[2] === '1';
          const playing = parts[3] === '1';
          const ducked = parts[4] === '1';
          if (pid > 0 && processName) {
            sessions.push({ pid, processName, muted, playing, ducked });
          }
        }
      }
    }

    return { focusedPid, sessions };
  }

  private _shouldMuteProcess(processName: string, isFocused: boolean): boolean {
    const nameLower = this._normalizeName(processName);
    if (this.config.mode === 'whitelist') {
      return !this.whitelistCache.has(nameLower) && !isFocused;
    } else {
      return this.blacklistCache.has(nameLower) && !isFocused;
    }
  }

  private async _unmuteAll(): Promise<void> {
    try {
      await this._workerSend(this._rulesCommand('CLEAR'), 5000);
    } catch { /* ignore */ }
  }

  private async _clearDucking(): Promise<void> {
    try {
      await this._workerSend('CLEARDUCK', 5000);
    } catch { /* ignore */ }
  }

  async tick(): Promise<void> {
    if (!this._isActive()) return;
    await this._tick();
  }

  private async _tick(): Promise<void> {
    if (!this._isActive() || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const lines = await this._workerSend(this._rulesCommand('APPLY'), 5000);
      const { focusedPid, sessions } = this._parseLines(lines);

      // If LIST timed out or returned nothing, skip this tick entirely
      // (don't make decisions on stale/empty data).
      if (sessions.length === 0) {
        return;
      }
      this.lastSessions = sessions;
      this.lastFocusedPid = focusedPid;
    } catch (err) {
      this._debugLog(`tick error: ${(err as Error)?.message}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  startPolling(): void {
    if (this.timer) return;
    // Start the worker eagerly so Add-Type compilation happens before first tick
    this._startWorker();
    if (this._isActive()) void this._tick();
    this.timer = setInterval(() => {
      if (this._isActive() && !this.tickInFlight) void this._tick();
    }, 1000);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this._clearDucking()
      .then(() => this._unmuteAll())
      .then(() => {
        this._killWorker('stop polling');
      });
  }
}
