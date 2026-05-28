import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { StartupEntry } from '../../shared/startup';
import type { AppSettings } from '../../shared/settings';
import type { RegexRenamerExport } from '../../shared/regexLab';
import { AlwaysActiveTab } from './AlwaysActiveTab';
import { ClipboardTab } from './ClipboardTab';
import { FocusAudioTab } from './FocusAudioTab';
import { MacrosTab } from './MacrosTab';
import { PlayitTab } from './PlayitTab';
import { RegexLabTab } from './RegexLabTab';
import { RenamerTab } from './RenamerTab';
import { SettingsTab } from './SettingsTab';

const modules = [
  {
    id: 'startup-apps',
    label: 'Startup Apps',
    eyebrow: 'Autostart Control',
    overview: 'startup entries with cache-backed disable and restore',
    compact: 'startup restore',
    hero: 'Review Windows startup entries, disable noisy launches, and restore cached items when you need them again.',
  },
  {
    id: 'macros',
    label: 'Macros',
    eyebrow: 'Automation',
    overview: 'process-aware macro profiles and recorded actions',
    compact: 'macro profiles',
    hero: 'Build profiles, record inputs, and switch macros automatically around the app or game in focus.',
  },
  {
    id: 'focus-audio',
    label: 'Focus Audio',
    eyebrow: 'Audio Focus',
    overview: 'focus-based audio muting with whitelist and blacklist rules',
    compact: 'focus audio rules',
    hero: 'Keep foreground audio clear by muting selected background apps based on focus and process rules.',
  },
  {
    id: 'always-active',
    label: 'Always Active',
    eyebrow: 'Window Focus',
    overview: 'best-effort active-window rules for selected apps',
    compact: 'always-active apps',
    hero: 'Select apps that should keep receiving active-window signals or return to the foreground when Windows focus changes.',
  },
  {
    id: 'playit',
    label: 'Playit Tunnels',
    eyebrow: 'Network Tunnels',
    overview: 'Playit.gg tunnel setup for forwarding local ports without router changes',
    compact: 'Playit tunnels',
    hero: 'Install the Playit agent, claim it, and manage supported tunnels for local services.',
  },
  {
    id: 'renamer',
    label: 'Batch Renamer',
    eyebrow: 'File Workflow',
    overview: 'preview-first bulk file renaming with rules, validation, and undo',
    compact: 'batch rename previews',
    hero: 'Queue files and folders, stack rename rules, preview every target name, and apply reversible batches.',
  },
  {
    id: 'regex-lab',
    label: 'Regex Lab',
    eyebrow: 'Pattern Builder',
    overview: 'visual regex testing and generated patterns for rename rules',
    compact: 'regex pattern building',
    hero: 'Build regular expressions from sample filenames, test matches, and send patterns straight into the renamer.',
  },
  {
    id: 'clipboard',
    label: 'Clipboard',
    eyebrow: 'Clipboard History',
    overview: 'searchable clipboard history with pins, categories, images, and OCR',
    compact: 'clipboard history',
    hero: 'Keep copied text, images, and file paths searchable with pins, smart categories, OCR, and a quick-access hotkey.',
  },
  {
    id: 'settings',
    label: 'Settings',
    eyebrow: 'App Behavior',
    overview: 'launch, tray, and window behavior settings',
    compact: 'launch and tray settings',
    hero: 'Adjust launch behavior, tray handling, and update controls for the desktop app.',
  },
] as const;

type ActiveTab = (typeof modules)[number]['id'];

function joinFeatureList(features: readonly string[], finalJoin = 'and'): string {
  if (features.length === 0) return '';
  if (features.length === 1) return features[0];
  if (features.length === 2) return `${features[0]} and ${features[1]}`;

  return `${features.slice(0, -1).join(', ')}, ${finalJoin} ${features[features.length - 1]}`;
}

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
  const [adminPrompt, setAdminPrompt] = useState<{ message: string } | null>(null);
  const [adminRelaunching, setAdminRelaunching] = useState(false);
  const [renamerRegexImport, setRenamerRegexImport] = useState<RegexRenamerExport | null>(null);

  const activeModule = modules.find((module) => module.id === activeTab) ?? modules[0];
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
    return window.winUtils.clipboard.onOpenRequested(() => {
      setActiveTab('clipboard');
    });
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

  const handleStartupError = (caughtError: unknown, fallback: string): void => {
    const message = getErrorMessage(caughtError, fallback);

    if (/administrator permission is required/i.test(message)) {
      setAdminPrompt({ message });
      return;
    }

    setError(message);
  };

  const handleRestartAsAdmin = async (): Promise<void> => {
    setAdminRelaunching(true);
    setError(null);

    try {
      await window.winUtils.startupApps.restartAsAdmin();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, 'Unable to restart WinUtils as administrator.'));
      setAdminRelaunching(false);
      setAdminPrompt(null);
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
      handleStartupError(caughtError, 'Unable to update the selected startup app.');
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
      handleStartupError(caughtError, 'Unable to delete the selected startup app.');
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
      handleStartupError(caughtError, 'Unable to add the startup entry.');
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
      handleStartupError(caughtError, 'Unable to update this startup entry.');
    } finally {
      setSavingEditId(null);
    }
  };

  return (
    <div className="app-shell">
      <div className="app-backdrop" />
      <header className={`hero-card ${activeTab !== 'startup-apps' ? 'hero-card--module' : ''}`}>
        <div className="hero-main">
          <p className="eyebrow">{activeModule.eyebrow}</p>
          <h1>{activeModule.label}</h1>
          <p className="hero-copy">{activeModule.hero}</p>
        </div>
        {activeTab === 'startup-apps' ? (
          <div className="hero-metrics">
            <div className="metric-card">
              <span>Enabled</span>
              <strong>{enabledCount}</strong>
            </div>
            <div className="metric-card metric-card--dim" title="Startup entries disabled through WinUtils and kept in the cache so they can be restored later.">
              <span>Cached Off</span>
              <strong>{disabledCount}</strong>
            </div>
          </div>
        ) : null}
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
                title={module.hero}
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

        {activeTab === 'always-active' ? (
          <section className="content-card content-card--always-active">
            <AlwaysActiveTab />
          </section>
        ) : null}

        {activeTab === 'playit' ? (
          <section className="content-card content-card--playit">
            <PlayitTab />
          </section>
        ) : null}

        {activeTab === 'renamer' ? (
          <section className="content-card content-card--renamer">
            <RenamerTab importedRegex={renamerRegexImport} />
          </section>
        ) : null}

        {activeTab === 'regex-lab' ? (
          <section className="content-card content-card--regex-lab">
            <RegexLabTab
              onExportToRenamer={(payload) => {
                setRenamerRegexImport(payload);
                setActiveTab('renamer');
              }}
            />
          </section>
        ) : null}

        {activeTab === 'clipboard' ? (
          <section className="content-card content-card--clipboard">
            <ClipboardTab />
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
            <button
              className="ghost-button"
              type="button"
              onClick={() => void loadEntries()}
              disabled={loading || busyId !== null}
              title="Rescan registry Run keys and Startup folders."
            >
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
                title="Display name for the new startup entry."
              />
              <input
                className="macro-input"
                placeholder="Executable path (example: C:\\Program Files\\App\\app.exe)"
                value={newExecutablePath}
                onChange={(event) => setNewExecutablePath(event.target.value)}
                title="Full path to the program that should start with Windows."
              />
              <button
                className="ghost-button startup-browse-button"
                type="button"
                onClick={() => void handlePickExecutable()}
                title="Choose an executable file from disk."
              >
                Browse...
              </button>
              <input
                className="macro-input"
                placeholder="Arguments (optional)"
                value={newArguments}
                onChange={(event) => setNewArguments(event.target.value)}
                title="Optional command-line arguments passed to the program at startup."
              />
              <select
                className="macro-select"
                value={newScope}
                onChange={(event) => setNewScope(event.target.value as 'current-user' | 'all-users')}
                title="Current User starts only for this Windows account. All Users applies machine-wide and may require administrator permission."
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
                title="Create a new Windows startup entry with the name, path, arguments, and scope above."
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
                    <span title={entry.source === 'registry' ? 'Stored in a Windows Run registry key.' : 'Stored as a shortcut in a Startup folder.'}>{entry.source === 'registry' ? 'Registry' : 'Startup Folder'}</span>
                    <span title={entry.scope === 'current-user' ? 'Runs only for the signed-in Windows user.' : 'Runs for all Windows users on this PC and may need administrator permission.'}>{entry.scope === 'current-user' ? 'Current User' : 'All Users'}</span>
                    <div>
                      {editingEntryId === entry.id ? (
                        <div className="startup-entry-edit-fields">
                          <input
                            className="macro-input"
                            value={editExecutablePath}
                            onChange={(event) => setEditExecutablePath(event.target.value)}
                            placeholder="Executable path"
                            title="Update the executable path used by this registry startup entry."
                          />
                          <input
                            className="macro-input"
                            value={editArguments}
                            onChange={(event) => setEditArguments(event.target.value)}
                            placeholder="Arguments"
                            title="Update optional command-line arguments for this startup entry."
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
                    <span className={`status-pill status-pill--${entry.state}`} title={entry.state === 'enabled' ? 'This item is currently active at Windows startup.' : 'This item is disabled and can be restored from the WinUtils cache.'}>{entry.state}</span>
                    <div className="startup-action-stack">
                      <button
                        className={`toggle-button ${entry.state === 'disabled' ? 'toggle-button--restore' : ''}`}
                        type="button"
                        onClick={() => void handleToggle(entry)}
                        disabled={!entry.canToggle || busyId === entry.id}
                        title={entry.state === 'enabled' ? 'Disable this startup entry and cache enough information to restore it later.' : 'Restore this cached startup entry so it starts with Windows again.'}
                      >
                        {busyId === entry.id ? 'Working...' : entry.state === 'enabled' ? 'Disable' : 'Re-enable'}
                      </button>

                      <button
                        className="micro-button micro-button--danger"
                        type="button"
                        onClick={() => void handleDelete(entry)}
                        disabled={!entry.canToggle || busyId === entry.id}
                        title={entry.state === 'enabled' ? 'Disable this active startup entry. Disabled entries are kept in the WinUtils cache.' : 'Delete this disabled startup entry from the WinUtils cache.'}
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
                              title="Save the edited executable path and arguments for this registry startup entry."
                            >
                              {savingEditId === entry.id ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              className="micro-button micro-button--danger"
                              type="button"
                              onClick={cancelEditingEntry}
                              disabled={savingEditId === entry.id}
                              title="Discard the path and argument edits."
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="micro-button"
                            type="button"
                            onClick={() => startEditingEntry(entry)}
                            title="Edit the executable path and command-line arguments for this registry startup entry."
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

      {adminPrompt ? (
        <div className="modal-backdrop" role="presentation">
          <div className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title">
            <div className="admin-dialog-mark" aria-hidden="true">!</div>
            <div className="admin-dialog-body">
              <p className="section-kicker">Elevated permission</p>
              <h2 id="admin-dialog-title">Restart as administrator?</h2>
              <p>{adminPrompt.message}</p>
              <p>WinUtils needs elevated permission for this startup entry. After the restart, repeat the action from Startup Apps.</p>
              <div className="admin-dialog-actions">
                <button className="ghost-button" type="button" disabled={adminRelaunching} onClick={() => setAdminPrompt(null)} title="Keep WinUtils running normally and cancel the administrator restart.">
                  Cancel
                </button>
                <button className="toggle-button" type="button" disabled={adminRelaunching} onClick={() => void handleRestartAsAdmin()} title="Restart WinUtils with administrator permission so all-users startup entries can be changed.">
                  {adminRelaunching ? 'Restarting...' : 'Restart as Administrator'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getErrorMessage(caughtError: unknown, fallback: string): string {
  if (!(caughtError instanceof Error)) {
    return typeof caughtError === 'string' && caughtError.trim() ? caughtError : fallback;
  }

  return caughtError.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}

export default App;
