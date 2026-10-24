using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static partial class Program
{
    private sealed class Recorder : IDisposable
    {
        private Session? session;
        public void Command(string operation, JsonElement data, string id)
        {
            switch (operation)
            {
                case "record-start":
                    if (session != null) throw new ArgumentException("Save or discard the current recording first.");
                    if (Runs.Count != 0) throw new ArgumentException("Stop playback before recording.");
                    session = new Session(data); Interlocked.Exchange(ref recordingSession, 1);
                    try { session.Start(); } catch { session.Dispose(); session = null; Interlocked.Exchange(ref recordingSession, 0); throw; }
                    Reply("OK", id, session.Json(false)); break;
                case "record-status": Reply("OK", id, session?.Json(false) ?? "{\"phase\":\"idle\",\"eventCount\":0,\"dropped\":0,\"elapsedMs\":0,\"countdownMs\":0,\"error\":null,\"draft\":null}"); break;
                case "record-stop":
                    if (session == null) throw new ArgumentException("No recording is active.");
                    session.Stop(); Reply("OK", id, session.Json(true)); break;
                case "record-discard": session?.Dispose(); session = null; Interlocked.Exchange(ref recordingSession, 0); Reply("OK", id, ""); break;
                default: throw new ArgumentException("Unknown recording operation.");
            }
        }
        public void Dispose() { session?.Dispose(); session = null; }

        private sealed class Session : IDisposable
        {
            private const int Capacity = 9000;
            private readonly TimedEvent[] events = new TimedEvent[10000];
            private readonly long[] ticks = new long[10000];
            private readonly TimelineKey?[] held = new TimelineKey?[255];
            private readonly bool[] buttons = new bool[5];
            private readonly HashSet<string> exclusions;
            private readonly bool keyboard, mouse, movement;
            private readonly uint ownerPid;
            private readonly double countdown;
            private readonly Thread thread;
            private readonly ManualResetEventSlim ready = new();
            private readonly HookProc keyboardProc, mouseProc;
            private uint threadId, allowedPid, classifiedPid;
            private long classifiedAt;
            private int count, dropped, repaired, excluded, stopped;
            private long began, captureAfter, ended;
            private string? error;
            private string layout = "";
            private string displays = "";
            public Session(JsonElement data)
            {
                keyboard = data.GetProperty("keyboard").GetBoolean(); mouse = data.GetProperty("mouse").GetBoolean(); movement = data.GetProperty("movement").GetBoolean();
                if (!keyboard && !mouse) throw new ArgumentException("Choose keyboard or mouse recording.");
                ownerPid = (uint)Integer(data, "ownerPid", 1, int.MaxValue);
                countdown = Integer(data, "countdownSeconds", 0, 10);
                var list = data.GetProperty("excludedProcesses");
                if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > 100) throw new ArgumentException("Invalid recording exclusions.");
                exclusions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var item in list.EnumerateArray())
                {
                    var name = item.GetString() ?? "";
                    if (name.Length is 0 or > 128 || name.Contains('\0')) throw new ArgumentException("Invalid excluded process.");
                    exclusions.Add(name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name);
                }
                keyboardProc = KeyCallback; mouseProc = MouseCallback;
                thread = new Thread(Loop) { Name = "WinUtils input recording", IsBackground = false };
            }
            public void Start()
            {
                thread.Start();
                if (!ready.Wait(5000)) throw new InvalidOperationException("Recorder did not start.");
                if (error != null) throw new InvalidOperationException(error);
            }
            private void Loop()
            {
                IntPtr keyHook = IntPtr.Zero, mouseHook = IntPtr.Zero; UIntPtr timer = UIntPtr.Zero;
                try
                {
                    threadId = GetCurrentThreadId(); PeekMessageW(out _, IntPtr.Zero, 0, 0, 0);
                    SetThreadDpiAwarenessContext(new IntPtr(-4));
                    displays = Input.DisplaySignature();
                    began = Stopwatch.GetTimestamp(); captureAfter = began + (long)(countdown * Stopwatch.Frequency);
                    var module = GetModuleHandleW(null);
                    // Keyboard hook also implements native F8 stop for mouse-only recordings.
                    keyHook = SetWindowsHookExW(13, keyboardProc, module, 0);
                    if (keyHook == IntPtr.Zero) throw new Win32Exception();
                    if (mouse) { mouseHook = SetWindowsHookExW(14, mouseProc, module, 0); if (mouseHook == IntPtr.Zero) throw new Win32Exception(); }
                    ClassifyForeground(); timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 50, IntPtr.Zero);
                    if (timer == UIntPtr.Zero) throw new Win32Exception();
                    ready.Set();
                    while (Volatile.Read(ref stopped) == 0)
                    {
                        int result = GetMessageW(out var msg, IntPtr.Zero, 0, 0);
                        if (result == -1) throw new Win32Exception();
                        if (result == 0) break;
                        if (msg.Message == 0x113)
                        {
                            ClassifyForeground();
                            if ((Stopwatch.GetTimestamp() - captureAfter) / (double)Stopwatch.Frequency > 300) RequestStop();
                        }
                        else { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
                    }
                }
                catch (Exception failure) { error = failure.Message; }
                finally
                {
                    Interlocked.Exchange(ref stopped, 1); ended = Stopwatch.GetTimestamp();
                    if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
                    if (keyHook != IntPtr.Zero && !UnhookWindowsHookEx(keyHook)) error = "Keyboard recording hook cleanup failed.";
                    if (mouseHook != IntPtr.Zero && !UnhookWindowsHookEx(mouseHook)) error = "Mouse recording hook cleanup failed.";
                    // Complete captured pairs without injecting any input.
                    for (int k = 1; k < held.Length; k++) if (held[k] is TimelineKey key) { Append(new(0, "key", Key: key, Up: true), ended, true); repaired++; }
                    for (int b = 0; b < buttons.Length; b++) if (buttons[b]) { Append(new(0, "button", Button: b, Up: true), ended, true); repaired++; }
                    ready.Set();
                }
            }
            private void ClassifyForeground()
            {
                uint tid = GetWindowThreadProcessId(GetForegroundWindow(), out uint pid);
                if (pid == 0 || pid == ownerPid || pid == Environment.ProcessId) { allowedPid = 0; classifiedPid = 0; return; }
                long now = Stopwatch.GetTimestamp();
                if (pid == classifiedPid && now - classifiedAt < Stopwatch.Frequency) return;
                classifiedPid = pid; classifiedAt = now;
                allowedPid = 0;
                try
                {
                    using var process = Process.GetProcessById((int)pid);
                    if (exclusions.Contains(process.ProcessName)) return;
                    layout = GetKeyboardLayout(tid).ToInt64().ToString("x"); allowedPid = pid;
                }
                catch { /* Unknown or inaccessible foreground processes fail closed. */ }
            }
            private bool Eligible(long now)
            {
                if (now < captureAfter || Volatile.Read(ref stopped) != 0) return false;
                GetWindowThreadProcessId(GetForegroundWindow(), out uint pid);
                if (pid == 0 || pid != allowedPid) { excluded++; return false; }
                return true;
            }
            private IntPtr KeyCallback(int code, UIntPtr message, IntPtr pointer)
            {
                long now = Stopwatch.GetTimestamp();
                try
                {
                    if (code >= 0)
                    {
                        var data = Marshal.PtrToStructure<KeyboardData>(pointer);
                        if ((data.Flags & 0x12) == 0 && data.Key is > 0 and < 255)
                        {
                            bool up = (data.Flags & 0x80) != 0;
                            if (data.Key == 0x77) { if (!up) RequestStop(); }
                            else if (keyboard && Volatile.Read(ref stopped) == 0)
                            {
                                bool eligible = Eligible(now);
                                if (up && held[data.Key] is TimelineKey previous)
                                { if (Append(new(0, "key", Key: previous, Up: true), now)) held[data.Key] = null; }
                                else if (!up && eligible)
                                {
                                    var key = new TimelineKey((ushort)data.Key, (ushort)data.Scan, (data.Flags & 1) != 0);
                                    if (Append(new(0, "key", Key: key), now)) held[data.Key] = key;
                                }
                            }
                        }
                    }
                }
                catch { error = "Input recording failed."; RequestStop(); }
                return CallNextHookEx(IntPtr.Zero, code, message, pointer);
            }
            private IntPtr MouseCallback(int code, UIntPtr message, IntPtr pointer)
            {
                long now = Stopwatch.GetTimestamp();
                try
                {
                    if (code >= 0 && Volatile.Read(ref stopped) == 0)
                    {
                        // Movement is opt-in; do not classify foreground input for ignored moves.
                        if ((uint)message == 0x200 && !movement) return CallNextHookEx(IntPtr.Zero, code, message, pointer);
                        var data = Marshal.PtrToStructure<MouseData>(pointer);
                        if ((data.Flags & 3) == 0)
                        {
                            uint msg = (uint)message; bool eligible = Eligible(now);
                            int button = msg is 0x201 or 0x202 ? 0 : msg is 0x204 or 0x205 ? 1 : msg is 0x207 or 0x208 ? 2 : msg is 0x20b or 0x20c ? ((data.Data >> 16) == 1 ? 3 : 4) : -1;
                            if (button >= 0)
                            {
                                bool up = msg is 0x202 or 0x205 or 0x208 or 0x20c;
                                if (up && buttons[button]) { if (Append(new(0, "button", Button: button, Up: true), now)) buttons[button] = false; }
                                else if (!up && eligible && Append(new(0, "button", Button: button), now)) buttons[button] = true;
                            }
                            else if (eligible && msg == 0x200 && movement) Append(new(0, "move", X: data.X, Y: data.Y), now);
                            else if (eligible && msg is 0x20a or 0x20e) Append(new(0, "wheel", Delta: (short)(data.Data >> 16), Horizontal: msg == 0x20e), now);
                        }
                    }
                }
                catch { error = "Mouse recording failed."; RequestStop(); }
                return CallNextHookEx(IntPtr.Zero, code, message, pointer);
            }
            private bool Append(TimedEvent value, long timestamp, bool cleanup = false)
            {
                if (count >= (cleanup ? events.Length : Capacity)) { dropped++; RequestStop(); return false; }
                events[count] = value; ticks[count] = timestamp; Volatile.Write(ref count, count + 1); return true;
            }
            private void RequestStop()
            {
                Interlocked.Exchange(ref stopped, 1);
                if (threadId != 0) PostThreadMessageW(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero);
            }
            public void Stop()
            {
                RequestStop();
                if (thread.IsAlive && !thread.Join(5000)) throw new InvalidOperationException("Recorder cleanup timed out.");
            }
            public string Json(bool includeDraft)
            {
                int length = Volatile.Read(ref count); long now = ended == 0 ? Stopwatch.GetTimestamp() : ended;
                using var stream = new MemoryStream(); using (var writer = new Utf8JsonWriter(stream))
                {
                    writer.WriteStartObject(); writer.WriteString("phase", Volatile.Read(ref stopped) != 0 ? "ready" : now < captureAfter ? "countdown" : "recording");
                    writer.WriteNumber("eventCount", length); writer.WriteNumber("dropped", dropped);
                    writer.WriteNumber("elapsedMs", Math.Max(0, (now - captureAfter) * 1000.0 / Stopwatch.Frequency));
                    writer.WriteNumber("countdownMs", Math.Max(0, (captureAfter - now) * 1000.0 / Stopwatch.Frequency));
                    if (error == null) writer.WriteNull("error"); else writer.WriteString("error", error);
                    writer.WritePropertyName("draft");
                    if (!includeDraft) writer.WriteNullValue();
                    else
                    {
                        writer.WriteStartObject(); writer.WriteNumber("version", 1); writer.WriteNumber("speed", 1); writer.WriteString("timing", "preserve-timing");
                        writer.WriteStartObject("metadata"); writer.WriteString("backend", "windows-hooks"); writer.WriteNumber("frequency", Stopwatch.Frequency); writer.WriteString("layout", layout); writer.WriteString("displays", displays);
                        writer.WriteNumber("dropped", dropped); writer.WriteNumber("repaired", repaired); writer.WriteNumber("excluded", excluded); writer.WriteEndObject();
                        writer.WriteStartArray("events");
                        long first = length == 0 ? 0 : ticks[0];
                        for (int i = 0; i < length; i++)
                        {
                            var entry = events[i]; writer.WriteStartObject(); writer.WriteNumber("timeUs", (long)Math.Round((ticks[i] - first) * 1000000.0 / Stopwatch.Frequency)); writer.WriteString("kind", entry.Kind);
                            switch (entry.Kind)
                            {
                                case "key": writer.WriteNumber("key", entry.Key.Key); writer.WriteNumber("scan", entry.Key.Scan); writer.WriteBoolean("extended", entry.Key.Extended); writer.WriteBoolean("up", entry.Up); break;
                                case "button": writer.WriteNumber("button", entry.Button); writer.WriteBoolean("up", entry.Up); break;
                                case "move": writer.WriteNumber("x", entry.X); writer.WriteNumber("y", entry.Y); break;
                                case "wheel": writer.WriteNumber("delta", entry.Delta); writer.WriteBoolean("horizontal", entry.Horizontal); break;
                            }
                            writer.WriteEndObject();
                        }
                        writer.WriteEndArray(); writer.WriteEndObject();
                    }
                    writer.WriteEndObject();
                }
                return Encoding.UTF8.GetString(stream.ToArray());
            }
            public void Dispose() { Stop(); ready.Dispose(); }
        }
        private delegate IntPtr HookProc(int code, UIntPtr message, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] private struct KeyboardData { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct MouseData { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct NativeMessage { public IntPtr Window; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookExW(int kind, HookProc callback, IntPtr module, uint thread);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, UIntPtr message, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetMessageW(out NativeMessage message, IntPtr window, uint min, uint max);
        [DllImport("user32.dll")] private static extern bool PeekMessageW(out NativeMessage message, IntPtr window, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern bool TranslateMessage(ref NativeMessage message);
        [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref NativeMessage message);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessageW(uint thread, uint message, UIntPtr wp, IntPtr lp);
        [DllImport("user32.dll", SetLastError = true)] private static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint milliseconds, IntPtr callback);
        [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr window, UIntPtr id);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint thread);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string? name);
    }
}
