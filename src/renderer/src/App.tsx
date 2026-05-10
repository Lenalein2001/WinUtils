import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { StartupEntry } from '../../shared/startup';
import type { AppSettings } from '../../shared/settings';
import { FocusAudioTab } from './FocusAudioTab';
import { MacrosTab } from './MacrosTab';
import { PlayitTab } from './PlayitTab';
import { SettingsTab } from './SettingsTab';

const modules = [
  {
    id: 'startup-apps',
    label: 'Startup Apps',
    overview: 'startup entries with cache-backed disable and restore',
    compact: 'startup restore',
  },
  {
    id: 'macros',
    label: 'Macros',
    overview: 'process-aware macro profiles and recorded actions',
    compact: 'macro profiles',
  },
  {
    id: 'focus-audio',
    label: 'Focus Audio',
    overview: 'focus-based audio muting with whitelist and blacklist rules',
    compact: 'focus audio rules',
  },
  {
    id: 'playit',
    label: 'Playit Tunnels',
    overview: 'Playit.gg tunnel setup for forwarding local ports without router changes',
    compact: 'Playit tunnels',
  },
  {
    id: 'settings',
    label: 'Settings',
    overview: 'launch, tray, and window behavior settings',
    compact: 'launch and tray settings',
  },
] as const;

type ActiveTab = (typeof modules)[number]['id'];

function joinFeatureList(features: readonly string[], finalJoin = 'and'): string {
  if (features.length === 0) return '';
  if (features.length === 1) return features[0];
  if (features.length === 2) return `${features[0]} and ${features[1]}`;

  return `${features.slice(0, -1).join(', ')}, ${finalJoin} ${features[features.length - 1]}`;
}

const heroDescription = `Manage ${joinFeatureList(modules.map((module) => module.overview))}.`;
const sidebarDescription = `Manage ${joinFeatureList(modules.map((module) => module.compact), 'plus')}.`;

function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<ActiveTab>('startup-apps');
  const [entries, setEntries] = useState<StartupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newExecutablePath, setNewExecutablePath] = useState('');
  const [newArguments, setNewArguments] = useState('');
  const [newScope, setNewScope] = useState<'current-user' | 'all-users'>('current-user');
  const [addingEntry, setAddingEntry] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editExecutablePath, setEditExecutablePath] = useState('');
  const [editArguments, setEditArguments] = useState('');
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const enabledCount = useMemo(() => entries.filter((entry) => entry.state === 'enabled').length, [entries]);
  const disabledCount = useMemo(() => entries.filter((entry) => entry.state === 'disabled').length, [entries]);

  const loadEntries = async () => {
    setLoading(true);
    setError(null);

    try {
      const startupApi = window.winUtils?.startupApps;

      if (!startupApi) {
        throw new Error('WinUtils bridge is unavailable. Please restart the app.');
      }

      setEntries(await startupApi.list());
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to load startup apps.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadEntries();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await window.winUtils.settings.get();
        setAppSettings(settings);
      } catch {
        // Keep UI usable even if settings read fails.
      }
    })();
  }, []);

  const updateSettings = async (patch: Partial<AppSettings>) => {
    setSettingsBusy(true);
    setError(null);
    try {
      const settings = await window.winUtils.settings.update(patch);
      setAppSettings(settings);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to update app settings.');
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleToggle = async (entry: StartupEntry) => {
    setBusyId(entry.id);
    setError(null);

    try {
      const updatedEntries =
        entry.state === 'enabled'
          ? await window.winUtils.startupApps.disable(entry.id)
          : await window.winUtils.startupApps.enable(entry.id);

      setEntries(updatedEntries);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to update the selected startup app.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (entry: StartupEntry) => {
    setBusyId(entry.id);
    setError(null);

    try {
      const updatedEntries =
        entry.state === 'enabled'
          ? await window.winUtils.startupApps.disable(entry.id)
          : await window.winUtils.startupApps.delete(entry.id);

      setEntries(updatedEntries);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to delete the selected startup app.');
    } finally {
      setBusyId(null);
    }
  };

  const handleAddEntry = async () => {
    setAddingEntry(true);
    setError(null);

    try {
      const updatedEntries = await window.winUtils.startupApps.add({
        name: newName,
        executablePath: newExecutablePath,
        arguments: newArguments,
        scope: newScope,
      });
      setEntries(updatedEntries);
      setNewName('');
      setNewExecutablePath('');
      setNewArguments('');
      setNewScope('current-user');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to add the startup entry.');
    } finally {
      setAddingEntry(false);
    }
  };

  const handlePickExecutable = async () => {
    setError(null);
    try {
      const pickedPath = await window.winUtils.startupApps.pickExecutable();
      if (pickedPath) {
        setNewExecutablePath(pickedPath);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to open file picker.');
    }
  };

  const startEditingEntry = (entry: StartupEntry) => {
    setEditingEntryId(entry.id);
    setEditExecutablePath(entry.executablePath);
    setEditArguments(entry.arguments);
  };

  const cancelEditingEntry = () => {
    setEditingEntryId(null);
    setEditExecutablePath('');
    setEditArguments('');
  };

  const saveEditingEntry = async (entry: StartupEntry) => {
    setSavingEditId(entry.id);
    setError(null);
    try {
      const updatedEntries = await window.winUtils.startupApps.update({
        id: entry.id,
        executablePath: editExecutablePath,
        arguments: editArguments,
      });
      setEntries(updatedEntries);
      cancelEditingEntry();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to update this startup entry.');
    } finally {
      setSavingEditId(null);
    }
  };

  return (
    <div className="app-shell">
      <div className="app-backdrop" />
      <header className="hero-card">
        <div>
          <p className="eyebrow">Windows Power Tools</p>
          <h1>WinUtils</h1>
          <p className="hero-copy">{heroDescription}</p>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <span>Enabled</span>
            <strong>{enabledCount}</strong>
          </div>
          <div className="metric-card metric-card--dim">
            <span>Cached Off</span>
            <strong>{disabledCount}</strong>
          </div>
        </div>
      </header>

      <main className="main-grid">
        <aside className="sidebar-card">
          <p className="sidebar-label">Modules</p>
          <div className="sidebar-modules">
            {modules.map((module) => (
              <button
                key={module.id}
                className={`tab-button ${activeTab === module.id ? 'tab-button--active' : ''}`}
                type="button"
                onClick={() => setActiveTab(module.id)}
              >
                {module.label}
              </button>
            ))}
          </div>
          <div className="sidebar-note">{sidebarDescription}</div>
        </aside>

        {activeTab === 'macros' ? (
          <section className="content-card content-card--macros">
            <MacrosTab />
          </section>
        ) : null}

        {activeTab === 'focus-audio' ? (
          <section className="content-card content-card--focus-audio">
            <FocusAudioTab />
          </section>
        ) : null}

        {activeTab === 'playit' ? (
          <section className="content-card content-card--playit">
            <PlayitTab />
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section className="content-card content-card--settings">
            <SettingsTab
              settings={appSettings}
              busy={settingsBusy}
              onToggleLaunchAtLogin={(value) => void updateSettings({ launchAtLogin: value })}
              onToggleStartMinimized={(value) => void updateSettings({ startMinimized: value })}
              onToggleMinimizeToTray={(value) => void updateSettings({ minimizeToTray: value })}
              onToggleCloseToTray={(value) => void updateSettings({ closeToTray: value })}
            />
          </section>
        ) : null}

        <section className="content-card" style={activeTab !== 'startup-apps' ? { display: 'none' } : undefined}>
          <div className="content-header">
            <div>
              <p className="section-kicker">Startup Apps</p>
              <h2>Autostart entries across Windows</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => void loadEntries()} disabled={loading || busyId !== null}>
              Refresh
            </button>
          </div>

          <div className="startup-add-card">
            <h3>Quick Add</h3>
            <div className="startup-add-grid">
              <input
                className="macro-input"
                placeholder="Name (example: Discord)"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
              <input
                className="macro-input"
                placeholder="Executable path (example: C:\\Program Files\\App\\app.exe)"
                value={newExecutablePath}
                onChange={(event) => setNewExecutablePath(event.target.value)}
              />
              <button
                className="ghost-button startup-browse-button"
                type="button"
                onClick={() => void handlePickExecutable()}
              >
                Browse...
              </button>
              <input
                className="macro-input"
                placeholder="Arguments (optional)"
                value={newArguments}
                onChange={(event) => setNewArguments(event.target.value)}
              />
              <select
                className="macro-select"
                value={newScope}
                onChange={(event) => setNewScope(event.target.value as 'current-user' | 'all-users')}
              >
                <option value="current-user">Current User</option>
                <option value="all-users">All Users (Admin)</option>
              </select>
            </div>
            <div className="startup-add-submit">
              <button
                className="ghost-button"
                type="button"
                onClick={() => void handleAddEntry()}
                disabled={addingEntry || !newName.trim() || !newExecutablePath.trim()}
              >
                {addingEntry ? 'Adding...' : 'Add to Startup'}
              </button>
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="table-wrap">
            <div className="table-head table-row">
              <span>Name</span>
              <span>Source</span>
              <span>Scope</span>
              <span>Path / Arguments / Location</span>
              <span>Status</span>
              <span>Action</span>
            </div>

            {loading ? <div className="empty-state">Scanning Windows startup locations...</div> : null}

            {!loading && entries.length === 0 ? (
              <div className="empty-state">No startup entries were found on this machine.</div>
            ) : null}

            {!loading
              ? entries.map((entry) => (
                  <div className="table-row entry-row" key={entry.id}>
                    <div>
                      <strong>{entry.name}</strong>
                      {entry.disabledAt ? <p className="inline-note">Cached {new Date(entry.disabledAt).toLocaleString()}</p> : null}
                    </div>
                    <span>{entry.source === 'registry' ? 'Registry' : 'Startup Folder'}</span>
                    <span>{entry.scope === 'current-user' ? 'Current User' : 'All Users'}</span>
                    <div>
                      {editingEntryId === entry.id ? (
                        <div className="startup-entry-edit-fields">
                          <input
                            className="macro-input"
                            value={editExecutablePath}
                            onChange={(event) => setEditExecutablePath(event.target.value)}
                            placeholder="Executable path"
                          />
                          <input
                            className="macro-input"
                            value={editArguments}
                            onChange={(event) => setEditArguments(event.target.value)}
                            placeholder="Arguments"
                          />
                        </div>
                      ) : (
                        <>
                          <code>{entry.executablePath}</code>
                          {entry.arguments ? <p className="inline-note">Args: {entry.arguments}</p> : null}
                        </>
                      )}
                      <p className="inline-note">{entry.location}</p>
                      {entry.notes ? <p className="inline-note">{entry.notes}</p> : null}
                    </div>
                    <span className={`status-pill status-pill--${entry.state}`}>{entry.state}</span>
                    <div className="startup-action-stack">
                      <button
                        className={`toggle-button ${entry.state === 'disabled' ? 'toggle-button--restore' : ''}`}
                        type="button"
                        onClick={() => void handleToggle(entry)}
                        disabled={!entry.canToggle || busyId === entry.id}
                      >
                        {busyId === entry.id ? 'Working...' : entry.state === 'enabled' ? 'Disable' : 'Re-enable'}
                      </button>

                      <button
                        className="micro-button micro-button--danger"
                        type="button"
                        onClick={() => void handleDelete(entry)}
                        disabled={!entry.canToggle || busyId === entry.id}
                      >
                        Delete
                      </button>

                      {entry.source === 'registry' ? (
                        editingEntryId === entry.id ? (
                          <div className="startup-inline-actions">
                            <button
                              className="micro-button"
                              type="button"
                              onClick={() => void saveEditingEntry(entry)}
                              disabled={savingEditId === entry.id || !editExecutablePath.trim()}
                            >
                              {savingEditId === entry.id ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              className="micro-button micro-button--danger"
                              type="button"
                              onClick={cancelEditingEntry}
                              disabled={savingEditId === entry.id}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="micro-button"
                            type="button"
                            onClick={() => startEditingEntry(entry)}
                          >
                            Edit Path/Args
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                ))
              : null}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
