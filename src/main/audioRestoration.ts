// Shared with the embedded Windows worker and exercised with fake audio sessions.
// Keep compatible with Windows PowerShell's .NET Framework C# compiler.
export const AUDIO_RESTORATION_CSHARP = String.raw`
public sealed class AudioRestorationState {
    readonly Func<bool> getMute;
    readonly Action<bool> setMute;
    readonly Func<float> getVolume;
    readonly Action<float> setVolume;
    readonly Action release;
    readonly Action<AudioRestorationState> persist;
    bool? originalMute;
    bool? appliedMute;
    float? originalVolume;
    float? appliedVolume;
    bool released;

    public AudioRestorationState(Func<bool> getMute, Action<bool> setMute,
        Func<float> getVolume, Action<float> setVolume, Action release) {
        this.getMute = getMute; this.setMute = setMute;
        this.getVolume = getVolume; this.setVolume = setVolume;
        this.release = release;
    }

    public AudioRestorationState(Func<bool> getMute, Action<bool> setMute,
        Func<float> getVolume, Action<float> setVolume, Action release, Action<AudioRestorationState> persist)
        : this(getMute, setMute, getVolume, setVolume, release) {
        this.persist = persist;
    }

    public bool HasMute { get { return originalMute.HasValue; } }
    public bool HasVolume { get { return originalVolume.HasValue; } }
    public bool HasChanges { get { return HasMute || HasVolume; } }

    public string Snapshot() {
        return String.Join("|", new string[] {
            originalMute.HasValue ? (originalMute.Value ? "1" : "0") : "-",
            appliedMute.HasValue ? (appliedMute.Value ? "1" : "0") : "-",
            originalVolume.HasValue ? originalVolume.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture) : "-",
            appliedVolume.HasValue ? appliedVolume.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture) : "-" });
    }

    public void Import(string snapshot) {
        string[] parts = snapshot.Split('|');
        if (parts.Length != 4) throw new InvalidOperationException("Invalid audio recovery state.");
        bool? mute = ParseMute(parts[0]), applied = ParseMute(parts[1]);
        float? volume = ParseVolume(parts[2]), target = ParseVolume(parts[3]);
        if (mute.HasValue != applied.HasValue || volume.HasValue != target.HasValue)
            throw new InvalidOperationException("Incomplete audio recovery state.");
        originalMute = mute; appliedMute = applied; originalVolume = volume; appliedVolume = target;
    }
    static bool? ParseMute(string value) {
        if (value == "-") return null;
        if (value != "0" && value != "1") throw new InvalidOperationException("Invalid audio mute baseline.");
        return value == "1";
    }
    static float? ParseVolume(string value) {
        if (value == "-") return null;
        float result;
        if (!float.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out result)
            || float.IsNaN(result) || float.IsInfinity(result) || result < 0 || result > 1)
            throw new InvalidOperationException("Invalid audio volume baseline.");
        return result;
    }
    void Save(string previous) {
        if (persist == null || previous == Snapshot()) return;
        try { persist(this); } catch { Import(previous); throw; }
    }

    public void Mute() {
        bool current = getMute();
        // A mute that predates WinUtils belongs to the user.
        if (current) return;
        string previous = Snapshot();
        if (!originalMute.HasValue) originalMute = current;
        appliedMute = true;
        Save(previous); // Publish recovery intent before changing Windows audio.
        setMute(true);
    }

    public void RestoreMute() {
        if (!originalMute.HasValue) return;
        // Do not undo a later change made in the Windows mixer.
        if (getMute() == appliedMute.Value) setMute(originalMute.Value);
        string previous = Snapshot();
        originalMute = null; appliedMute = null;
        Save(previous);
    }

    public void Duck(float factor) {
        float current = getVolume();
        string previous = Snapshot();
        if (!originalVolume.HasValue || (appliedVolume.HasValue && Math.Abs(current - appliedVolume.Value) > 0.0001f)) {
            originalVolume = current;
        }
        float target = Math.Max(0.0f, Math.Min(1.0f, originalVolume.Value * factor));
        appliedVolume = target;
        Save(previous);
        if (Math.Abs(current - target) > 0.0001f) setVolume(target);
    }

    public void RestoreVolume() {
        if (!originalVolume.HasValue) return;
        if (Math.Abs(getVolume() - appliedVolume.Value) <= 0.0001f) setVolume(originalVolume.Value);
        string previous = Snapshot();
        originalVolume = null; appliedVolume = null;
        Save(previous);
    }

    // Explicit changes through WinUtils become the baseline for subsequent automation.
    public void ForgetMute() { string previous = Snapshot(); originalMute = null; appliedMute = null; Save(previous); }
    public void ForgetVolume() { string previous = Snapshot(); originalVolume = null; appliedVolume = null; Save(previous); }

    public void Release() {
        if (released) return;
        release(); released = true;
    }
}
`;
