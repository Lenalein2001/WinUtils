using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;

internal static partial class Program
{
    private sealed class Binding
    {
        public required string Slot, Hotkey, Chord;
        public required int[][] Groups;
        public uint Modifiers, Key, SuppressPid;
        public bool ReleaseOnly, TrackRelease, Registered, Active, Contaminated, Armed;
        public int Id, Running;
        public Instruction[]? Plan;
        public string? FastRunId;
        public HashSet<int> Baseline = new();
    }

    private sealed class HotkeyLoop : IDisposable
    {
        private readonly ConcurrentQueue<Action> changes = new();
        private readonly Dictionary<string, Binding> bindings = new();
        private readonly Thread thread;
        private readonly ManualResetEventSlim started = new();
        private readonly bool[] keys = new bool[255];
        private int[] observedKeys = Array.Empty<int>();
        private uint threadId;
        private int nextId, disposed;
        private bool fastEnabled;
        public HotkeyLoop()
        {
            thread = new Thread(Loop) { Name = "WinUtils macro hotkeys", IsBackground = false };
            thread.Start();
            if (!started.Wait(5000)) throw new InvalidOperationException("Native hotkey loop did not start.");
        }
        public void Configure(JsonElement data, string id)
        {
            var items = data.GetProperty("bindings");
            if (items.GetArrayLength() > 256) throw new ArgumentException("Hotkey binding budget exceeded.");
            var definitions = items.EnumerateArray().Select(Parse).ToArray();
            var enabled = data.GetProperty("fastEnabled").GetBoolean();
            if (definitions.Select(b => b.Slot).Distinct().Count() != definitions.Length) throw new ArgumentException("Duplicate hotkey slot.");
            Post(() =>
            {
                try { Replace(definitions); fastEnabled = enabled; if (!enabled) CancelFast(); Reply("OK", id, Diagnostics()); }
                catch (Exception error) { Reply("ERR", id, error.Message); }
            });
        }
        public void CancelFast()
        {
            // Run ownership survives binding replacement until cleanup finishes.
            foreach (var pair in Runs) if (pair.Key.StartsWith("hotkey-", StringComparison.Ordinal)) pair.Value.Cancel();
        }
        public void SuspendFast(string id) => Post(() =>
        {
            fastEnabled = false;
            CancelFast();
            if (!Queue.TryAdd(new Request(id, "barrier", "", Array.Empty<Instruction>(), default))) Reply("ERR", id, "Macro input queue is full.");
        });
        private void Post(Action action)
        {
            changes.Enqueue(action);
            if (!PostThreadMessageW(threadId, 0x8001, UIntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        }
        private void Loop()
        {
            threadId = GetCurrentThreadId();
            PeekMessageW(out _, IntPtr.Zero, 0, 0, 0); // Create the thread's Windows message queue.
            started.Set();
            try
            {
                while (Volatile.Read(ref disposed) == 0)
                {
                    while (changes.TryDequeue(out var change)) change();
                    while (PeekMessageW(out var message, IntPtr.Zero, 0, 0, 1))
                    {
                        if (message.Message != 0x0312) continue;
                        var binding = bindings.Values.FirstOrDefault(b => b.Registered && b.Id == (int)message.WParam);
                        if (binding != null && !binding.Active) Activate(binding);
                    }
                    bool polling = bindings.Values.Any(b => !b.Registered || b.TrackRelease);
                    if (polling) Poll();
                    MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, polling ? 20u : uint.MaxValue, 0x04ff, 4);
                }
            }
            finally { foreach (var binding in bindings.Values) Remove(binding); }
        }
        private void Replace(Binding[] definitions)
        {
            var desired = definitions.ToDictionary(b => b.Slot);
            foreach (var slot in bindings.Keys.ToArray())
            {
                var previous = bindings[slot];
                if (desired.TryGetValue(slot, out var next) && previous.Chord == next.Chord
                    && previous.TrackRelease == next.TrackRelease && previous.ReleaseOnly == next.ReleaseOnly && previous.SuppressPid == next.SuppressPid)
                {
                    // Prepared programs update without creating an OS registration gap.
                    previous.Plan = next.Plan;
                    if (!previous.Registered && previous.Key != 0)
                    {
                        previous.Registered = RegisterHotKey(IntPtr.Zero, previous.Id, previous.Modifiers | 0x4000, previous.Key);
                        if (previous.Registered) previous.Armed = true;
                    }
                    desired.Remove(slot);
                    continue;
                }
                Remove(previous); bindings.Remove(slot);
            }
            foreach (var binding in desired.Values)
            {
                do { nextId = nextId % 0xbfff + 1; } while (bindings.Values.Any(b => b.Id == nextId));
                binding.Id = nextId;
                binding.Registered = binding.Key != 0 && RegisterHotKey(IntPtr.Zero, binding.Id, binding.Modifiers | 0x4000, binding.Key);
                // Polling fallbacks start disarmed: a key held during a profile
                // switch cannot accidentally execute the newly selected macro.
                binding.Armed = binding.Registered;
                bindings.Add(binding.Slot, binding);
            }
            observedKeys = bindings.Values.Any(b => b.ReleaseOnly) ? Enumerable.Range(1, 254).ToArray()
                : bindings.Values.Where(b => !b.Registered || b.TrackRelease).SelectMany(b => b.Groups.SelectMany(g => g))
                    .Concat(new[] { 0x10, 0x11, 0x12, 0x5b, 0x5c }).Distinct().ToArray();
            Array.Clear(keys);
        }
        private void Remove(Binding binding)
        {
            if (binding.FastRunId != null && Runs.TryGetValue(binding.FastRunId, out var run)) run.Cancel();
            if (binding.Registered) UnregisterHotKey(IntPtr.Zero, binding.Id);
            if (binding.Active && binding.TrackRelease) Write("HOTKEY_UP " + Encode(binding.Hotkey));
        }
        private void Activate(Binding binding)
        {
            Input.GetWindowThreadProcessId(Input.GetForegroundWindow(), out var pid);
            if (binding.SuppressPid != 0 && pid == binding.SuppressPid) return;
            binding.Active = binding.TrackRelease;
            if (binding.Plan == null) { Write("HOTKEY_DOWN " + Encode(binding.Hotkey)); return; }
            if (!fastEnabled) return;
            if (Interlocked.Exchange(ref binding.Running, 1) != 0) return;
            var runId = "hotkey-" + Guid.NewGuid().ToString("N");
            binding.FastRunId = runId;
            if (Runs.Count >= 128 || !Runs.TryAdd(runId, new Run()) || !Queue.TryAdd(new Request("", "run", runId, binding.Plan, default, binding)))
            {
                if (Runs.TryRemove(runId, out var rejected)) rejected.Dispose();
                binding.FastRunId = null; Interlocked.Exchange(ref binding.Running, 0);
                Write("FAST_ERROR " + Encode(binding.Hotkey) + " " + Encode("Macro input queue is full."));
            }
        }
        private void Poll()
        {
            // One shared snapshot per 20 ms tick, independent of binding count.
            foreach (int key in observedKeys) keys[key] = (Input.GetAsyncKeyState(key) & 0x8000) != 0;
            foreach (var binding in bindings.Values)
            {
                if (binding.Registered && !binding.TrackRelease) continue;
                bool down = binding.Groups.All(group => group.Any(key => keys[key]));
                if (!binding.Registered && binding.Key != 0)
                {
                    uint modifiers = (keys[0x12] ? 1u : 0u) | (keys[0x11] ? 2u : 0u) | (keys[0x10] ? 4u : 0u) | (keys[0x5b] || keys[0x5c] ? 8u : 0u);
                    down &= modifiers == binding.Modifiers;
                }
                if (!binding.Armed)
                {
                    if (!down) binding.Armed = true;
                    continue;
                }
                if (binding.Active)
                {
                    if (down)
                    {
                        if (binding.ReleaseOnly && NonModifiers().Any(key => !binding.Baseline.Contains(key))) binding.Contaminated = true;
                        continue;
                    }
                    binding.Active = false;
                    if (binding.ReleaseOnly && !binding.Contaminated) Activate(binding);
                    if (binding.TrackRelease) Write("HOTKEY_UP " + Encode(binding.Hotkey));
                    continue;
                }
                if (binding.Registered || !down) continue;
                binding.Active = true;
                binding.Contaminated = false;
                if (binding.ReleaseOnly) binding.Baseline = NonModifiers().ToHashSet();
                else { Activate(binding); binding.Active = true; }
            }
        }
        private IEnumerable<int> NonModifiers() => Enumerable.Range(7, 248).Where(key => keys[key] && key is not (0x10 or 0x11 or 0x12 or 0x5b or 0x5c or >= 0xa0 and <= 0xa5));
        private string Diagnostics() => "{\"threadId\":" + threadId + ",\"bindings\":[" + string.Join(",", bindings.Values.Select(b =>
            "{\"hotkey\":\"" + b.Hotkey.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"id\":" + b.Id + ",\"registered\":" + (b.Registered ? "true" : "false") + "}")) + "]}";
        private static Binding Parse(JsonElement item)
        {
            var hotkey = item.GetProperty("hotkey").GetString() ?? "";
            var slot = item.TryGetProperty("slot", out var s) ? s.GetString() ?? "" : hotkey;
            if (hotkey.Length is 0 or > 128 || slot.Length is 0 or > 160 || hotkey.Any(char.IsControl)) throw new ArgumentException("Invalid hotkey.");
            var groups = new List<int[]>();
            uint modifiers = 0, key = 0;
            foreach (var group in item.GetProperty("groups").EnumerateArray())
            {
                if (groups.Count >= 16) throw new ArgumentException("Invalid hotkey chord.");
                int[] values;
                if (group.ValueKind == JsonValueKind.Object)
                {
                    var character = group.GetProperty("char").GetString();
                    if (character?.Length != 1) throw new ArgumentException("Invalid hotkey character.");
                    short chord = VkKeyScanW(character[0]);
                    if (chord == -1) throw new ArgumentException("Hotkey is unavailable on this keyboard layout.");
                    if ((chord & 0x100) != 0) { groups.Add(new[] { 0x10 }); modifiers |= 4; }
                    if ((chord & 0x200) != 0) { groups.Add(new[] { 0x11 }); modifiers |= 2; }
                    if ((chord & 0x400) != 0) { groups.Add(new[] { 0x12 }); modifiers |= 1; }
                    values = new[] { chord & 0xff };
                }
                else values = group.EnumerateArray().Select(v => v.GetInt32()).ToArray();
                if (values.Length is 0 or > 2 || values.Any(v => v is < 1 or > 254)) throw new ArgumentException("Invalid hotkey key.");
                groups.Add(values);
                if (values.Contains(0x10)) modifiers |= 4;
                else if (values.Contains(0x11)) modifiers |= 2;
                else if (values.Contains(0x12)) modifiers |= 1;
                else if (values.Contains(0x5b) || values.Contains(0x5c)) modifiers |= 8;
                else { if (key != 0) throw new ArgumentException("Hotkey must have one main key."); key = (uint)values[0]; }
            }
            if (groups.Count == 0) throw new ArgumentException("Empty hotkey chord.");
            int count = 0;
            var plan = item.TryGetProperty("actions", out var actions) ? ParseInstructions(actions, 0, ref count) : null;
            var track = item.GetProperty("trackRelease").GetBoolean();
            return new Binding { Hotkey = hotkey, Slot = slot, Groups = groups.ToArray(), Modifiers = modifiers, Key = key,
                Chord = string.Join(";", groups.Select(g => string.Join(",", g))), SuppressPid = item.GetProperty("suppressPid").GetUInt32(),
                TrackRelease = track, ReleaseOnly = key == 0 && !track, Plan = plan };
        }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            CancelFast(); PostThreadMessageW(threadId, 0x8001, UIntPtr.Zero, IntPtr.Zero);
            thread.Join(); started.Dispose();
        }
        [StructLayout(LayoutKind.Sequential)] private struct MessageData { public IntPtr Hwnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
        [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessageW(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool PeekMessageW(out MessageData message, IntPtr window, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint milliseconds, uint mask, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern short VkKeyScanW(char character);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    }
}
