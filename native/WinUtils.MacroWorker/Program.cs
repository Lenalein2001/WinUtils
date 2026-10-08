using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

// No code evaluation, shell, hooks or elevation. Only validated input operations
// arrive on private stdio pipes. Queries/cancellation remain responsive while
// the single input thread preserves ordering across macro batches.
internal static partial class Program
{
    private const int MaxFrame = 8 * 1024 * 1024;
    private static readonly object OutputLock = new();
    private static readonly ConcurrentDictionary<string, Run> Runs = new();
    private static readonly BlockingCollection<Request> Queue = new(128);
    private static int shutdown;

    private sealed record Request(string Id, string Operation, string RunId, Instruction[] Actions, JsonElement Data, Binding? Binding = null);
    private sealed record Instruction(string Kind, double Delay = 0, ushort[]? Keys = null, int Mode = 0,
        uint Flags = 0, uint Up = 0, int X = 0, int Y = 0, string? Text = null, int Times = 0, Instruction[]? Actions = null);
    private sealed class Run : IDisposable
    {
        public readonly CancellationTokenSource Cancellation = new();
        public readonly List<ushort> Keys = new();
        public readonly HashSet<uint> MouseUps = new();
        public int Actions;
        public int Limit = 100_000;
        public void Cancel() { try { Cancellation.Cancel(); } catch (ObjectDisposedException) { } }
        public void Dispose() => Cancellation.Dispose();
    }
    private sealed class Stopped : Exception { }

    public static int Main()
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        using var timer = new PrecisionTimer();
        var thread = new Thread(() => ExecuteQueue(timer)) { Name = "WinUtils macro input", IsBackground = false };
        thread.Start();
        using var hotkeys = new HotkeyLoop();
        bool cleanupFailed = false;
        Write("READY");
        try
        {
            string? line;
            while ((line = ReadBoundedLine()) != null)
            {
                if (line == "__WINUTILS_EXIT__") break;
                if (line.StartsWith("CANCEL ", StringComparison.Ordinal))
                {
                    if (Runs.TryGetValue(line[7..], out var cancel)) cancel.Cancel();
                    continue;
                }
                var space = line.IndexOf(' ');
                if (space <= 0) continue;
                var id = line[..space];
                try
                {
                    using var document = JsonDocument.Parse(Convert.FromBase64String(line[(space + 1)..]), new JsonDocumentOptions { MaxDepth = 32 });
                    var data = document.RootElement;
                    var operation = data.GetProperty("op").GetString() ?? "";
                    if (operation == "hotkeys") { hotkeys.Configure(data, id); continue; }
                    if (operation == "cancel-fast")
                    {
                        hotkeys.SuspendFast(id);
                        continue;
                    }
                    var runId = data.TryGetProperty("runId", out var owner) ? owner.GetString() ?? "" : "";
                    if (runId.Length > 128) throw new ArgumentException("Invalid macro owner.");
                    if (operation == "keys")
                    {
                        Reply("OK", id, Input.ArePressed(ParseKeys(data.GetProperty("keys"))) ? "true" : "false");
                        continue;
                    }
                    if (operation == "foreground") { Reply("OK", id, Input.Foreground()); continue; }
                    var count = 0;
                    var instructions = operation == "run" ? ParseInstructions(data.GetProperty("actions"), 0, ref count) : Array.Empty<Instruction>();
                    if (operation is not ("run" or "release" or "measure")) throw new ArgumentException("Unknown macro operation.");
                    if (runId.Length == 0) throw new ArgumentException("Missing macro owner.");
                    if (Runs.Count >= 128 && !Runs.ContainsKey(runId)) throw new ArgumentException("Too many pending macros.");
                    Runs.GetOrAdd(runId, _ => new Run());
                    if (!Queue.TryAdd(new Request(id, operation, runId, instructions, operation is "run" or "measure" ? data.Clone() : default)))
                        throw new ArgumentException("Macro input queue is full.");
                }
                catch (Exception error) { Reply("ERR", id, error.Message); }
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); }
        finally
        {
            hotkeys.Dispose();
            Interlocked.Exchange(ref shutdown, 1);
            foreach (var run in Runs.Values) run.Cancel();
            Queue.CompleteAdding();
            thread.Join();
            foreach (var run in Runs.Values)
            {
                try { Input.Release(run); }
                catch (Exception error) { cleanupFailed = true; Console.Error.WriteLine("Input cleanup failed: " + error.Message); }
                run.Dispose();
            }
        }
        return cleanupFailed ? 1 : 0;
    }

    private static string? ReadBoundedLine()
    {
        var buffer = new StringBuilder();
        int ch;
        while ((ch = Console.In.Read()) != -1)
        {
            if (ch == '\n') return buffer.ToString().TrimEnd('\r');
            if (buffer.Length >= MaxFrame) throw new ArgumentException("Macro request exceeds the input budget.");
            buffer.Append((char)ch);
        }
        return buffer.Length > 0 ? buffer.ToString() : null;
    }

    private static void ExecuteQueue(PrecisionTimer timer)
    {
        foreach (var request in Queue.GetConsumingEnumerable())
        {
            if (request.Id.Length > 0) Write("BEGIN " + request.Id);
            if (request.Operation == "barrier")
            {
                try
                {
                    // Retry cleanup owners retained after a failed fast run.
                    // Earlier queued fast runs have finished before this barrier.
                    foreach (var pair in Runs.Where(p => p.Key.StartsWith("hotkey-", StringComparison.Ordinal)))
                    {
                        Input.Release(pair.Value);
                        if (Runs.TryRemove(pair.Key, out var removed)) removed.Dispose();
                    }
                    Reply("OK", request.Id, "");
                }
                catch (Exception error) { Reply("ERR", request.Id, "Input cleanup failed: " + error.Message); }
                continue;
            }
            if (!Runs.TryGetValue(request.RunId, out var run)) { Reply("ERR", request.Id, "Macro owner is unavailable."); continue; }
            try
            {
                if (request.Operation == "release")
                {
                    Input.Release(run);
                    if (Runs.TryRemove(request.RunId, out var removed)) removed.Dispose();
                    Reply("OK", request.Id, "");
                    continue;
                }
                if (Volatile.Read(ref shutdown) != 0) throw new OperationCanceledException();
                run.Cancellation.Token.ThrowIfCancellationRequested();
                if (request.Binding != null) Write("FAST_START " + Encode(request.Binding.Hotkey) + " " + request.RunId + " " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (request.Operation == "measure") Reply("OK", request.Id, Measure(request.Data, run, timer));
                else
                {
                    if (request.Binding == null && request.Data.TryGetProperty("maxActions", out _)) run.Limit = Integer(request.Data, "maxActions", 0, 100_000);
                    Execute(request.Actions, run, timer);
                    if (request.Binding == null) Reply("OK", request.Id, run.Actions.ToString(CultureInfo.InvariantCulture));
                }
            }
            catch (Exception error)
            {
                try { Input.Release(run); }
                catch (Exception releaseError) { Reply("ERR", request.Id, "Input cleanup failed: " + releaseError.Message); continue; }
                if (request.Binding == null) Reply(error is OperationCanceledException ? "CANCELED" : error is Stopped ? "STOPPED" : "ERR", request.Id, error.Message);
                else if (error is not (Stopped or OperationCanceledException)) Write("FAST_ERROR " + Encode(request.Binding.Hotkey) + " " + Encode(error.Message));
            }
            finally
            {
                if (request.Binding != null)
                {
                    bool released = false;
                    try { Input.Release(run); released = true; }
                    catch (Exception error) { Write("FAST_ERROR " + Encode(request.Binding.Hotkey) + " " + Encode(error.Message)); }
                    if (released && Runs.TryRemove(request.RunId, out var removed)) removed.Dispose();
                    request.Binding.FastRunId = null;
                    Interlocked.Exchange(ref request.Binding.Running, 0);
                    Write("FAST_END " + Encode(request.Binding.Hotkey) + " " + request.RunId + " " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                }
            }
        }
    }

    private static void Execute(Instruction[] instructions, Run run, PrecisionTimer timer)
    {
        foreach (var instruction in instructions)
        {
            run.Cancellation.Token.ThrowIfCancellationRequested();
            if (++run.Actions > run.Limit) throw new ArgumentException("Macro exceeded the 100,000 action execution safety limit.");
            switch (instruction.Kind)
            {
                case "delay": timer.Delay(instruction.Delay, run.Cancellation.Token); break;
                case "keyboard": Input.Keyboard(instruction.Keys!, instruction.Mode, instruction.Delay, run, timer); break;
                case "mouse": Input.Mouse(instruction.Flags, instruction.Up, instruction.Mode, run, timer); break;
                case "move": if (!Input.SetCursorPos(instruction.X, instruction.Y)) throw new Win32Exception(); break;
                case "text": Input.Text(instruction.Text!, run, timer); break;
                case "stop": throw new Stopped();
                case "repeat":
                    // Keep each explicit delay intact, including fractional waits;
                    // input dispatch time must not silently shorten that delay.
                    for (int i = 0; i < instruction.Times; i++) Execute(instruction.Actions!, run, timer);
                    break;
            }
        }
    }

    private static Instruction[] ParseInstructions(JsonElement array, int depth, ref int count)
    {
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > 10_000 || depth > 8) throw new ArgumentException("Invalid macro action budget.");
        var result = new List<Instruction>();
        foreach (var item in array.EnumerateArray())
        {
            if (++count > 10_000) throw new ArgumentException("Macro action budget exceeded.");
            var kind = item.GetProperty("kind").GetString();
            result.Add(kind switch
            {
                "delay" => new("delay", Delay: Number(item, "ms", 0, 600_000)),
                "keyboard" => new("keyboard", Delay: item.TryGetProperty("holdMs", out _) ? Number(item, "holdMs", 0, 600_000) : 16, Keys: ParseKeys(item.GetProperty("keys")), Mode: Integer(item, "mode", 0, 2)),
                "mouse" => MouseInstruction(item),
                "move" => new("move", X: Integer(item, "x", -1_000_000, 1_000_000), Y: Integer(item, "y", -1_000_000, 1_000_000)),
                "text" => new("text", Text: Text(item)),
                "repeat" => new("repeat", Times: Integer(item, "times", 0, 10_000), Actions: ParseInstructions(item.GetProperty("actions"), depth + 1, ref count)),
                "stop" => new("stop"),
                _ => throw new ArgumentException("Unknown input instruction.")
            });
        }
        return result.ToArray();
    }
    private static Instruction MouseInstruction(JsonElement item)
    {
        var down = (uint)Integer(item, "down", 0, 32);
        var up = (uint)Integer(item, "up", 0, 64);
        if (!((down == 2 && up == 4) || (down == 8 && up == 16) || (down == 32 && up == 64))) throw new ArgumentException("Invalid mouse flags.");
        return new("mouse", Flags: down, Up: up, Mode: Integer(item, "mode", 0, 3));
    }
    private static string Text(JsonElement item)
    {
        var text = item.GetProperty("text").GetString() ?? "";
        if (text.Length > 500_000 || text.Contains('\0')) throw new ArgumentException("Invalid macro text.");
        return text;
    }
    private static ushort[] ParseKeys(JsonElement array)
    {
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > 16) throw new ArgumentException("Invalid key combination.");
        return array.EnumerateArray().Select(k => { var value = k.GetInt32(); return value is > 0 and <= 254 ? (ushort)value : throw new ArgumentException("Invalid key."); }).Distinct().ToArray();
    }
    private static double Number(JsonElement item, string key, double min, double max)
    {
        var value = item.GetProperty(key).GetDouble();
        return double.IsFinite(value) && value >= min && value <= max ? value : throw new ArgumentException("Invalid " + key + ".");
    }
    private static int Integer(JsonElement item, string key, int min, int max)
    {
        var value = Number(item, key, min, max);
        return value == Math.Truncate(value) ? (int)value : throw new ArgumentException("Invalid " + key + ".");
    }
    private static string Measure(JsonElement data, Run run, PrecisionTimer timer)
    {
        var delay = Number(data, "ms", 0.001, 1000);
        var count = Integer(data, "iterations", 1, 1000);
        var measurements = new double[count];
        using var process = Process.GetCurrentProcess();
        var cpu = process.TotalProcessorTime;
        for (int i = 0; i < count; i++)
        {
            var start = Stopwatch.GetTimestamp(); timer.Delay(delay, run.Cancellation.Token);
            measurements[i] = (Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency;
        }
        // Manual serialization avoids reflection and keeps the AOT protocol small.
        process.Refresh();
        return "{\"samplesMs\":[" + string.Join(",", measurements.Select(v => v.ToString("R", CultureInfo.InvariantCulture)))
            + "],\"cpuMs\":" + (process.TotalProcessorTime - cpu).TotalMilliseconds.ToString("R", CultureInfo.InvariantCulture) + "}";
    }
    private static void Reply(string status, string id, string message) => Write(status + " " + id + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(message)));
    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    private static void Write(string line) { lock (OutputLock) { Console.WriteLine(line); Console.Out.Flush(); } }

    private sealed class PrecisionTimer : IDisposable
    {
        private readonly IntPtr handle;
        public PrecisionTimer()
        {
            handle = CreateWaitableTimerExW(IntPtr.Zero, null, 2, 0x00100002); // synchronize + modify state
            if (handle == IntPtr.Zero) handle = CreateWaitableTimerExW(IntPtr.Zero, null, 0, 0x00100002);
            if (handle == IntPtr.Zero) throw new Win32Exception();
        }
        public void Delay(double milliseconds, CancellationToken token) => Until(Stopwatch.GetTimestamp() + milliseconds * Stopwatch.Frequency / 1000.0, token);
        public void Until(double deadline, CancellationToken token)
        {
            // Sleeping most of the interval avoids sustained full-core spinning.
            // Wake ahead of the deadline to absorb the observed Windows timer
            // wakeup granularity. Only the final fraction uses a precision tail.
            IntPtr[]? handles = null;
            while (true)
            {
                token.ThrowIfCancellationRequested();
                var remainingMs = (deadline - Stopwatch.GetTimestamp()) * 1000.0 / Stopwatch.Frequency;
                if (remainingMs <= 0) return;
                if (remainingMs > 0.65)
                {
                    handles ??= new[] { token.WaitHandle.SafeWaitHandle.DangerousGetHandle(), handle };
                    long due = -Math.Max(1, (long)((remainingMs - 0.6) * 10_000));
                    if (!SetWaitableTimer(handle, ref due, 0, IntPtr.Zero, IntPtr.Zero, false)) throw new Win32Exception();
                    var result = WaitForMultipleObjects(2, handles, false, uint.MaxValue);
                    if (result == 0) token.ThrowIfCancellationRequested();
                    if (result == uint.MaxValue) throw new Win32Exception();
                }
                else Thread.SpinWait(8);
            }
        }
        public void Dispose() => CloseHandle(handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWaitableTimerExW(IntPtr attributes, string? name, uint flags, uint access);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetWaitableTimer(IntPtr timer, ref long due, int period, IntPtr callback, IntPtr argument, bool resume);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }

    private static class Input
    {
        [StructLayout(LayoutKind.Sequential)] private struct Event { public uint Type; public Union Data; }
        [StructLayout(LayoutKind.Explicit)] private struct Union { [FieldOffset(0)] public Key Key; [FieldOffset(0)] public MouseEvent Mouse; }
        [StructLayout(LayoutKind.Sequential)] private struct Key { public ushort Vk, Scan; public uint Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct MouseEvent { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
        private static Event KeyEvent(ushort key, bool up)
        {
            uint scan = MapVirtualKeyW(key, 4);
            bool extended = (scan & 0xff00) != 0 || key is >= 0x21 and <= 0x28 or 0x2d or 0x2e or 0x5b or 0x5c or 0x6f;
            return new Event { Type = 1, Data = new Union { Key = new Key { Vk = scan == 0 ? key : (ushort)0, Scan = (ushort)(scan & 0xff), Flags = (scan == 0 ? 0u : 8u) | (up ? 2u : 0u) | (extended ? 1u : 0u) } } };
        }
        private static void Send(Event[] events)
        {
            if (events.Length == 0) return;
            var sent = SendInput((uint)events.Length, events, Marshal.SizeOf<Event>());
            if (sent != events.Length) throw new InvalidOperationException("Windows refused macro input. Check target elevation and input restrictions.");
        }
        private static void KeyDown(ushort[] keys, Run run)
        {
            // Remember ownership before SendInput: a partial accepted batch still
            // requires cleanup. Release attempts include every requested key.
            foreach (var key in keys) if (!run.Keys.Contains(key)) run.Keys.Add(key);
            Send(keys.Select(k => KeyEvent(k, false)).ToArray());
        }
        private static void KeyUp(ushort[] keys, Run run)
        {
            Send(keys.Reverse().Select(k => KeyEvent(k, true)).ToArray());
            foreach (var key in keys) run.Keys.Remove(key);
        }
        public static void Keyboard(ushort[] keys, int mode, double holdMs, Run run, PrecisionTimer timer)
        {
            if (mode == 2) { KeyUp(keys, run); return; }
            KeyDown(keys, run);
            if (mode == 0) { timer.Delay(holdMs, run.Cancellation.Token); KeyUp(keys, run); }
        }
        private static void MouseSend(uint flags) => Send(new[] { new Event { Data = new Union { Mouse = new MouseEvent { Flags = flags } } } });
        public static void Mouse(uint down, uint up, int mode, Run run, PrecisionTimer timer)
        {
            if (mode == 2) { MouseSend(up); run.MouseUps.Remove(up); return; }
            run.MouseUps.Add(up); MouseSend(down);
            if (mode == 1) return;
            MouseSend(up); run.MouseUps.Remove(up);
            if (mode == 3) { timer.Delay(50, run.Cancellation.Token); Mouse(down, up, 0, run, timer); }
        }
        public static void Text(string text, Run run, PrecisionTimer timer)
        {
            foreach (var ch in text)
            {
                run.Cancellation.Token.ThrowIfCancellationRequested();
                Send(new[] { new Event { Type = 1, Data = new Union { Key = new Key { Scan = ch, Flags = 4 } } }, new Event { Type = 1, Data = new Union { Key = new Key { Scan = ch, Flags = 6 } } } });
                timer.Delay(1, run.Cancellation.Token);
            }
        }
        public static void Release(Run run)
        {
            var errors = new List<Exception>();
            foreach (var key in run.Keys.ToArray().Reverse())
                try { Send(new[] { KeyEvent(key, true) }); run.Keys.Remove(key); } catch (Exception error) { errors.Add(error); }
            foreach (var up in run.MouseUps.ToArray())
                try { MouseSend(up); run.MouseUps.Remove(up); } catch (Exception error) { errors.Add(error); }
            if (errors.Count > 0) throw new AggregateException("Some macro input could not be released.", errors);
        }
        public static bool ArePressed(ushort[] keys) => keys.Length > 0 && keys.All(key => (GetAsyncKeyState(key) & 0x8000) != 0);
        public static string Foreground()
        {
            var hwnd = GetForegroundWindow(); GetWindowThreadProcessId(hwnd, out var pid);
            string name = "";
            if (pid != 0) try { using var process = Process.GetProcessById((int)pid); name = process.ProcessName; } catch { }
            var title = new StringBuilder(32768); GetWindowTextW(hwnd, title, title.Capacity);
            return name + "\t" + title;
        }
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Event[] events, int size);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern uint MapVirtualKeyW(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int size);
    }
}
