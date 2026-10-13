using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Runtime.InteropServices;

internal static partial class Program
{
    private readonly record struct TimelineKey(ushort Key, ushort Scan, bool Extended);
    private readonly record struct TimedEvent(long TimeUs, string Kind, TimelineKey Key = default, bool Up = false,
        int Button = 0, int X = 0, int Y = 0, int Delta = 0, bool Horizontal = false);
    private sealed record Timeline(TimedEvent[] Events, double Speed, bool PreserveTiming, string? Displays);

    private static Timeline ParseTimeline(JsonElement value, ref int count)
    {
        if (Integer(value, "version", 1, 1) != 1) throw new ArgumentException("Unknown timeline version.");
        double speed = Number(value, "speed", 0.1, 10);
        var policy = value.GetProperty("timing").GetString();
        if (policy is not ("preserve-timing" or "preserve-schedule")) throw new ArgumentException("Invalid timeline timing policy.");
        var events = value.GetProperty("events");
        if (events.ValueKind != JsonValueKind.Array || events.GetArrayLength() > 10000) throw new ArgumentException("Recording event budget exceeded.");
        var result = new List<TimedEvent>(events.GetArrayLength());
        var keys = new HashSet<TimelineKey>(); var buttons = new HashSet<int>();
        long previous = 0;
        foreach (var item in events.EnumerateArray())
        {
            if (++count > 10000) throw new ArgumentException("Macro action budget exceeded.");
            long time = Integer(item, "timeUs", 0, 600000000);
            if (time < previous) throw new ArgumentException("Recording events are out of order.");
            previous = time;
            var kind = item.GetProperty("kind").GetString();
            TimedEvent entry;
            switch (kind)
            {
                case "key":
                    var key = new TimelineKey((ushort)Integer(item, "key", 1, 254), (ushort)Integer(item, "scan", 0, 65535), item.GetProperty("extended").GetBoolean());
                    bool up = item.GetProperty("up").GetBoolean();
                    if (up && !keys.Remove(key)) throw new ArgumentException("Recording contains an unmatched key release.");
                    if (!up) keys.Add(key);
                    entry = new(time, "key", Key: key, Up: up); break;
                case "button":
                    int button = Integer(item, "button", 0, 4); bool buttonUp = item.GetProperty("up").GetBoolean();
                    if (buttonUp && !buttons.Remove(button)) throw new ArgumentException("Recording contains an unmatched button release.");
                    if (!buttonUp) buttons.Add(button);
                    entry = new(time, "button", Button: button, Up: buttonUp); break;
                case "move": entry = new(time, "move", X: Integer(item, "x", -1000000, 1000000), Y: Integer(item, "y", -1000000, 1000000)); break;
                case "wheel": entry = new(time, "wheel", Delta: Integer(item, "delta", -32768, 32767), Horizontal: item.GetProperty("horizontal").GetBoolean()); break;
                default: throw new ArgumentException("Unknown recorded input.");
            }
            result.Add(entry);
        }
        if (keys.Count != 0 || buttons.Count != 0) throw new ArgumentException("Recording has unreleased input.");
        string? displays = value.GetProperty("metadata").TryGetProperty("displays", out var savedDisplays) ? savedDisplays.GetString() : null;
        if (displays?.Length > 2048) throw new ArgumentException("Invalid recorded display layout.");
        return new(result.ToArray(), speed, policy == "preserve-timing", displays);
    }
    private static void PlayTimeline(Timeline timeline, Run run, PrecisionTimer timer)
    {
        Input.SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (timeline.Displays != null && timeline.Events.Any(e => e.Kind == "move") && timeline.Displays != Input.DisplaySignature())
            throw new ArgumentException("The monitor layout changed. Record mouse movement again before playback.");
        double start = Stopwatch.GetTimestamp();
        foreach (var entry in timeline.Events)
        {
            run.Cancellation.Token.ThrowIfCancellationRequested();
            if (++run.Actions > run.Limit) throw new ArgumentException("Macro exceeded the 100,000 action execution safety limit.");
            double target = start + entry.TimeUs * Stopwatch.Frequency / 1000000.0 / timeline.Speed;
            timer.Until(target, run.Cancellation.Token);
            // Recorded holds retain their spacing when the OS wakes late. The
            // schedule policy instead retains the original absolute deadlines.
            if (timeline.PreserveTiming) start += Math.Max(0, Stopwatch.GetTimestamp() - target);
            switch (entry.Kind)
            {
                case "key": Input.RecordedKey(entry.Key, entry.Up, run); break;
                case "button": Input.RecordedButton(entry.Button, entry.Up, run); break;
                case "move": if (!Input.SetCursorPos(entry.X, entry.Y)) throw new Win32Exception(); break;
                case "wheel": Input.RecordedWheel(entry.Delta, entry.Horizontal); break;
            }
        }
    }
    private static partial class Input
    {
        [StructLayout(LayoutKind.Sequential)] private struct MonitorRect { public int Left, Top, Right, Bottom; }
        private delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref MonitorRect bounds, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback, IntPtr data);
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        public static string DisplaySignature()
        {
            var bounds = new List<string>();
            MonitorProc callback = (IntPtr monitor, IntPtr dc, ref MonitorRect rect, IntPtr data) => { bounds.Add($"{rect.Left},{rect.Top},{rect.Right},{rect.Bottom}"); return true; };
            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) throw new Win32Exception();
            return string.Join(";", bounds.Order(StringComparer.Ordinal));
        }
        public static void RecordedKey(TimelineKey key, bool up, Run run)
        {
            if (!up && !run.RecordedKeys.Contains(key)) run.RecordedKeys.Add(key);
            SendOne(new Event { Type = 1, Data = new Union { Key = new Key {
                Vk = key.Scan == 0 ? key.Key : (ushort)0, Scan = key.Scan,
                Flags = (key.Scan == 0 ? 0u : 8u) | (up ? 2u : 0u) | (key.Extended ? 1u : 0u)
            } } });
            if (up) run.RecordedKeys.Remove(key);
        }
        public static void RecordedButton(int button, bool up, Run run)
        {
            uint flags = button switch { 0 => up ? 4u : 2u, 1 => up ? 16u : 8u, 2 => up ? 64u : 32u, _ => up ? 256u : 128u };
            if (!up) run.RecordedButtons.Add(button);
            SendOne(new Event { Data = new Union { Mouse = new MouseEvent { Flags = flags, Data = button >= 3 ? (uint)(button - 2) : 0 } } });
            if (up) run.RecordedButtons.Remove(button);
        }
        public static void RecordedWheel(int delta, bool horizontal) => SendOne(new Event {
            Data = new Union { Mouse = new MouseEvent { Flags = horizontal ? 4096u : 2048u, Data = unchecked((uint)delta) } }
        });
    }
}
