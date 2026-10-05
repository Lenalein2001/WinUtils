// Shared with the embedded Windows worker and exercised with fake audio sessions.
// Keep compatible with Windows PowerShell's .NET Framework C# compiler.
export const AUDIO_RESTORATION_CSHARP = String.raw`
public sealed class AudioRestorationState {
    readonly Func<bool> getMute;
    readonly Action<bool> setMute;
    readonly Func<float> getVolume;
    readonly Action<float> setVolume;
    readonly Action release;
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

    public bool HasMute { get { return originalMute.HasValue; } }
    public bool HasVolume { get { return originalVolume.HasValue; } }
    public bool HasChanges { get { return HasMute || HasVolume; } }

    public void Mute() {
        bool current = getMute();
        // A mute that predates WinUtils belongs to the user.
        if (current) return;
        if (!originalMute.HasValue) originalMute = current;
        appliedMute = true;
        setMute(true);
    }

    public void RestoreMute() {
        if (!originalMute.HasValue) return;
        // Do not undo a later change made in the Windows mixer.
        if (getMute() == appliedMute.Value) setMute(originalMute.Value);
        originalMute = null; appliedMute = null;
    }

    public void Duck(float factor) {
        float current = getVolume();
        if (!originalVolume.HasValue || (appliedVolume.HasValue && Math.Abs(current - appliedVolume.Value) > 0.0001f)) {
            originalVolume = current;
        }
        float target = Math.Max(0.0f, Math.Min(1.0f, originalVolume.Value * factor));
        appliedVolume = target;
        if (Math.Abs(current - target) > 0.0001f) setVolume(target);
    }

    public void RestoreVolume() {
        if (!originalVolume.HasValue) return;
        if (Math.Abs(getVolume() - appliedVolume.Value) <= 0.0001f) setVolume(originalVolume.Value);
        originalVolume = null; appliedVolume = null;
    }

    // Explicit changes through WinUtils become the baseline for subsequent automation.
    public void ForgetMute() { originalMute = null; appliedMute = null; }
    public void ForgetVolume() { originalVolume = null; appliedVolume = null; }

    public void Release() {
        if (released) return;
        release(); released = true;
    }
}
`;
