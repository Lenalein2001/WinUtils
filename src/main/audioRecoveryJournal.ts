// Compiled by Windows PowerShell alongside the production Core Audio worker.
export const AUDIO_RECOVERY_JOURNAL_CSHARP = String.raw`
public sealed class AudioRecoveryRecord {
    public string Id, Snapshot;
    public int Pid;
    public long Started;
}
public sealed class AudioRecoveryJournal {
    readonly string path;
    readonly Dictionary<string, AudioRecoveryRecord> records = new Dictionary<string, AudioRecoveryRecord>(StringComparer.Ordinal);
    public AudioRecoveryJournal(string path) {
        this.path = path;
        if (!System.IO.File.Exists(path)) return;
        if (new System.IO.FileInfo(path).Length > 2097152) throw new InvalidOperationException("Audio recovery journal is too large; original retained.");
        string[] lines = System.IO.File.ReadAllLines(path, new System.Text.UTF8Encoding(false, true));
        if (lines.Length == 0 || lines[0] != "WinUtilsAudioRecovery:1" || lines.Length > 4097)
            throw new InvalidOperationException("Invalid audio recovery journal; original retained.");
        for (int i = 1; i < lines.Length; i++) {
            string[] parts = lines[i].Split('\t');
            int pid; long started;
            if (parts.Length != 4 || !int.TryParse(parts[1], out pid) || pid <= 0 || !long.TryParse(parts[2], out started) || started <= 0)
                throw new InvalidOperationException("Invalid audio recovery identity; original retained.");
            string id = new System.Text.UTF8Encoding(false, true).GetString(Convert.FromBase64String(parts[0]));
            if (String.IsNullOrEmpty(id) || id.Length > 8192 || records.ContainsKey(id)) throw new InvalidOperationException("Invalid audio session identity; original retained.");
            var state = new AudioRestorationState(null, null, null, null, null);
            state.Import(parts[3]);
            if (!state.HasChanges) throw new InvalidOperationException("Empty audio recovery record; original retained.");
            records.Add(id, new AudioRecoveryRecord { Id = id, Pid = pid, Started = started, Snapshot = parts[3] });
        }
    }
    public List<AudioRecoveryRecord> Pending { get { return new List<AudioRecoveryRecord>(records.Values); } }
    public bool TryGet(string id, out AudioRecoveryRecord record) { return records.TryGetValue(id, out record); }
    public void Save(string id, int pid, long started, AudioRestorationState state) {
        AudioRecoveryRecord previous;
        records.TryGetValue(id, out previous);
        if (state.HasChanges) {
            if (pid <= 0 || started <= 0 || String.IsNullOrEmpty(id) || id.Length > 8192 || (previous == null && records.Count >= 4096))
                throw new InvalidOperationException("Cannot safely record audio recovery identity.");
            records[id] = new AudioRecoveryRecord { Id = id, Pid = pid, Started = started, Snapshot = state.Snapshot() };
        } else records.Remove(id);
        try { Publish(); } catch {
            if (previous == null) records.Remove(id); else records[id] = previous;
            throw;
        }
    }
    public void Remove(string id) {
        AudioRecoveryRecord previous;
        if (!records.TryGetValue(id, out previous)) return;
        records.Remove(id);
        try { Publish(); } catch { records[id] = previous; throw; }
    }
    void Publish() {
        var content = new StringBuilder("WinUtilsAudioRecovery:1\n");
        foreach (var record in records.Values) {
            content.Append(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(record.Id))).Append('\t')
                .Append(record.Pid.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('\t')
                .Append(record.Started.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('\t').Append(record.Snapshot).Append('\n');
        }
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(content.ToString());
        if (bytes.Length > 2097152) throw new InvalidOperationException("Audio recovery journal budget exceeded.");
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            using (var stream = new System.IO.FileStream(temporary, System.IO.FileMode.CreateNew, System.IO.FileAccess.Write, System.IO.FileShare.None)) {
                stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            if (System.IO.File.Exists(path)) System.IO.File.Replace(temporary, path, null);
            else System.IO.File.Move(temporary, path);
        } finally { if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary); }
    }
}
`;
