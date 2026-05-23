import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocusAudioConfig, FocusAudioState } from '../../shared/focusAudio';

export function FocusAudioTab(): ReactElement {
  const [state, setState] = useState<FocusAudioState | null>(null);
  const [activeApps, setActiveApps] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newWhitelistEntry, setNewWhitelistEntry] = useState('');
  const [newBlacklistEntry, setNewBlacklistEntry] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadState = useCallback(async () => {
    try {
      const s = await window.winUtils.focusAudio.getState();
      setState(s);
      setActiveApps(s.activeAudioApps);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshActiveApps = useCallback(async () => {
    setRefreshing(true);
    try {
      const apps = await window.winUtils.focusAudio.getActiveApps();
      setActiveApps(apps);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
    // Refresh state and active audio apps every 3 seconds
    pollRef.current = setInterval(() => {
      void window.winUtils.focusAudio.getState().then((s) => {
        setState(s);
        setActiveApps(s.activeAudioApps);
      }).catch(() => undefined);
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadState]);

  const applyConfig = (config: FocusAudioConfig) => {
    setState((prev) => (prev ? { ...prev, ...config } : null));
  };

  const handleToggleEnabled = async () => {
    if (!state) return;
    const config = await window.winUtils.focusAudio.setEnabled(!state.enabled);
    applyConfig(config);
  };

  const handleSetMode = async (mode: 'whitelist' | 'blacklist') => {
    if (!state || state.mode === mode) return;
    const config = await window.winUtils.focusAudio.setMode(mode);
    applyConfig(config);
  };

  const handleAddToWhitelist = async (name: string) => {
    if (!state || !name.trim()) return;
    const trimmed = name.trim();
    if (state.whitelist.includes(trimmed)) return;
    const config = await window.winUtils.focusAudio.setWhitelist([...state.whitelist, trimmed]);
    applyConfig(config);
  };

  const handleRemoveFromWhitelist = async (name: string) => {
    if (!state) return;
    const config = await window.winUtils.focusAudio.setWhitelist(state.whitelist.filter((w) => w !== name));
    applyConfig(config);
  };

  const handleAddToBlacklist = async (name: string) => {
    if (!state || !name.trim()) return;
    const trimmed = name.trim();
    if (state.blacklist.includes(trimmed)) return;
    const config = await window.winUtils.focusAudio.setBlacklist([...state.blacklist, trimmed]);
    applyConfig(config);
  };

  const handleRemoveFromBlacklist = async (name: string) => {
    if (!state) return;
    const config = await window.winUtils.focusAudio.setBlacklist(state.blacklist.filter((b) => b !== name));
    applyConfig(config);
  };

  const handleAddFromActiveToList = async (appName: string, list: 'whitelist' | 'blacklist') => {
    if (!state) return;
    if (list === 'whitelist') {
      await handleAddToWhitelist(appName);
    } else {
      await handleAddToBlacklist(appName);
    }
  };

  if (loading) {
    return (
      <div className="focus-audio-tab">
        <div className="fa-loading">Loading Focus Audio…</div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="focus-audio-tab">
        <div className="fa-loading">Failed to load Focus Audio state.</div>
      </div>
    );
  }

  return (
    <div className="focus-audio-tab">
      {/* Header */}
      <div className="fa-header">
        <div className="fa-title-block">
          <h2 className="fa-title">Focus Audio</h2>
          <p className="fa-subtitle">
            Automatically mute apps based on which window is focused.
          </p>
        </div>
        <button
          className={`fa-enable-btn ${state.enabled ? 'fa-enable-btn--on' : 'fa-enable-btn--off'}`}
          onClick={() => void handleToggleEnabled()}
          title="Turn Focus Audio automatic muting on or off."
        >
          {state.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      {/* Mode selector */}
      <div className="fa-section">
        <div className="fa-section-label">Muting Mode</div>
        <div className="fa-mode-row">
          <button
            className={`fa-mode-btn ${state.mode === 'whitelist' ? 'fa-mode-btn--active' : ''}`}
            onClick={() => void handleSetMode('whitelist')}
            title="Mute background audio apps unless they are focused or listed in the whitelist."
          >
            <span className="fa-mode-icon">✓</span>
            <span className="fa-mode-text">
              <strong>Whitelist</strong>
              <small>Mute everything except listed apps (always play)</small>
            </span>
          </button>
          <button
            className={`fa-mode-btn ${state.mode === 'blacklist' ? 'fa-mode-btn--active' : ''}`}
            onClick={() => void handleSetMode('blacklist')}
            title="Only mute blacklisted apps when they are not the focused window."
          >
            <span className="fa-mode-icon">✗</span>
            <span className="fa-mode-text">
              <strong>Blacklist</strong>
              <small>Only mute listed apps when they're not focused</small>
            </span>
          </button>
        </div>
      </div>

      <div className="fa-columns">
        {/* Active Audio Apps */}
        <div className="fa-card">
          <div className="fa-card-header">
            <span>Active Audio Apps</span>
            <button className="fa-refresh-btn" onClick={() => void refreshActiveApps()} disabled={refreshing} title="Refresh the list of apps that currently have Windows audio sessions.">
              {refreshing ? '…' : '↻ Refresh'}
            </button>
          </div>
          {activeApps.length === 0 ? (
            <div className="fa-empty">No apps with active audio sessions.</div>
          ) : (
            <ul className="fa-app-list">
              {activeApps.map((app) => (
                <li key={app} className="fa-app-item">
                  <span className="fa-app-name">{app}</span>
                  <div className="fa-app-actions">
                    <button
                      className="fa-add-btn"
                      title="Add this app to the whitelist so it stays audible while Focus Audio is enabled."
                      onClick={() => void handleAddFromActiveToList(app, 'whitelist')}
                      disabled={state.whitelist.includes(app)}
                    >
                      + WL
                    </button>
                    <button
                      className="fa-add-btn fa-add-btn--bl"
                      title="Add this app to the blacklist so it is muted when it is not focused."
                      onClick={() => void handleAddFromActiveToList(app, 'blacklist')}
                      disabled={state.blacklist.includes(app)}
                    >
                      + BL
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Whitelist */}
        <div className="fa-card">
          <div className="fa-card-header">
            <span>Whitelist <small>(always play)</small></span>
          </div>
          <div className="fa-add-row">
            <input
              className="fa-input"
              placeholder="e.g. Spotify.exe"
              value={newWhitelistEntry}
              title="Type an executable name to keep audible, for example Spotify.exe."
              onChange={(e) => setNewWhitelistEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleAddToWhitelist(newWhitelistEntry);
                  setNewWhitelistEntry('');
                }
              }}
            />
            <button
              className="fa-add-btn"
              title="Add this executable name to the whitelist."
              onClick={() => {
                void handleAddToWhitelist(newWhitelistEntry);
                setNewWhitelistEntry('');
              }}
            >
              Add
            </button>
          </div>
          {state.whitelist.length === 0 ? (
            <div className="fa-empty">No entries. Add an app to keep it always audible.</div>
          ) : (
            <ul className="fa-app-list">
              {state.whitelist.map((name) => (
                <li key={name} className="fa-app-item">
                  <span className="fa-app-name">{name}</span>
                  <button className="fa-remove-btn" onClick={() => void handleRemoveFromWhitelist(name)} title="Remove this app from the whitelist.">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Blacklist */}
        <div className="fa-card">
          <div className="fa-card-header">
            <span>Blacklist <small>(mute when unfocused)</small></span>
          </div>
          <div className="fa-add-row">
            <input
              className="fa-input"
              placeholder="e.g. Cyberpunk2077.exe"
              value={newBlacklistEntry}
              title="Type an executable name to mute while unfocused, for example Cyberpunk2077.exe."
              onChange={(e) => setNewBlacklistEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleAddToBlacklist(newBlacklistEntry);
                  setNewBlacklistEntry('');
                }
              }}
            />
            <button
              className="fa-add-btn"
              title="Add this executable name to the blacklist."
              onClick={() => {
                void handleAddToBlacklist(newBlacklistEntry);
                setNewBlacklistEntry('');
              }}
            >
              Add
            </button>
          </div>
          {state.blacklist.length === 0 ? (
            <div className="fa-empty">No entries. Add an app to mute it when you switch away.</div>
          ) : (
            <ul className="fa-app-list">
              {state.blacklist.map((name) => (
                <li key={name} className="fa-app-item">
                  <span className="fa-app-name">{name}</span>
                  <button className="fa-remove-btn" onClick={() => void handleRemoveFromBlacklist(name)} title="Remove this app from the blacklist.">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Mode description banner */}
      <div className={`fa-mode-banner ${state.enabled ? 'fa-mode-banner--active' : 'fa-mode-banner--inactive'}`}>
        {!state.enabled && (
          <span>Focus Audio is <strong>disabled</strong>. Toggle it on above to start automatic muting.</span>
        )}
        {state.enabled && state.mode === 'whitelist' && (
          <span>
            <strong>Whitelist mode:</strong> All audio apps are muted except those in the whitelist, or when they're the focused window.
          </span>
        )}
        {state.enabled && state.mode === 'blacklist' && (
          <span>
            <strong>Blacklist mode:</strong> Only blacklisted apps are muted, and only when they're not the focused window.
          </span>
        )}
      </div>
    </div>
  );
}
