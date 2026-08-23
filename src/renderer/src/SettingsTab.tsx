import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { AppSettings, AppTheme } from '../../shared/settings';
import type { AppUpdateInfo, UpdateState } from '../../shared/updater';

interface SettingsTabProps {
  settings: AppSettings | null;
  busy: boolean;
  onToggleLaunchAtLogin: (value: boolean) => void;
  onToggleStartMinimized: (value: boolean) => void;
  onToggleMinimizeToTray: (value: boolean) => void;
  onToggleCloseToTray: (value: boolean) => void;
  onThemeChange: (value: AppTheme) => void;
}

const themeOptions: Array<{ value: AppTheme; label: string; description: string }> = [
  {
    value: 'winutils-blue',
    label: 'WinUtils Ocean',
    description: 'Original WinUtils cool-blue desktop style.',
  },
  {
    value: 'sable-night',
    label: 'Sable Tactical',
    description: 'Dark tactical palette inspired by your Discord web app.',
  },
  {
    value: 'sable-ember',
    label: 'Sable Ember',
    description: 'Brighter orange-accent variant of the Sable style.',
  },
];

export function SettingsTab({
  settings,
  busy,
  onToggleLaunchAtLogin,
  onToggleStartMinimized,
  onToggleMinimizeToTray,
  onToggleCloseToTray,
  onThemeChange,
}: SettingsTabProps): ReactElement {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogBusy, setChangelogBusy] = useState(false);
  const [changelogError, setChangelogError] = useState<string | null>(null);
  const [latestRelease, setLatestRelease] = useState<AppUpdateInfo | null>(null);
  const [releaseHistory, setReleaseHistory] = useState<AppUpdateInfo[] | null>(null);
  const [showAllChangelogs, setShowAllChangelogs] = useState(false);

  useEffect(() => {
    let mounted = true;

    void window.winUtils.updates.getState().then((state) => {
      if (mounted) setUpdateState(state);
    });

    const unsubscribe = window.winUtils.updates.onState((state) => setUpdateState(state));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const runUpdateAction = async (action: () => Promise<UpdateState | void>): Promise<void> => {
    setUpdateBusy(true);
    try {
      const nextState = await action();
      if (nextState) setUpdateState(nextState);
    } catch (error) {
      setUpdateState((state) => state ? { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) } : state);
    } finally {
      setUpdateBusy(false);
    }
  };

  const loadChangelog = async (includeHistory: boolean): Promise<void> => {
    setChangelogError(null);
    if (includeHistory && releaseHistory) return;
    if (!includeHistory && (latestRelease || updateState?.update?.releaseNotes)) return;

    setChangelogBusy(true);
    try {
      if (includeHistory) {
        setReleaseHistory(await window.winUtils.updates.getReleaseHistory());
      } else {
        setLatestRelease(await window.winUtils.updates.getLatestRelease());
      }
    } catch (error) {
      setChangelogError(error instanceof Error ? error.message : String(error));
    } finally {
      setChangelogBusy(false);
    }
  };

  const toggleChangelog = async (): Promise<void> => {
    const nextOpen = !changelogOpen;
    setChangelogOpen(nextOpen);
    if (nextOpen) {
      await loadChangelog(showAllChangelogs);
    }
  };

  const toggleChangelogScope = async (): Promise<void> => {
    const nextShowAll = !showAllChangelogs;
    setShowAllChangelogs(nextShowAll);
    if (changelogOpen) {
      await loadChangelog(nextShowAll);
    }
  };

  if (!settings) {
    return <div className="empty-state">Loading settings...</div>;
  }

  const updateStatus = updateState ? formatUpdateStatus(updateState) : 'Loading update status...';
  const updateBadge = updateState ? formatUpdateBadge(updateState) : 'Loading';
  const updateBadgeTone = updateState ? getUpdateBadgeTone(updateState) : 'info';
  const updateDisabled = updateBusy || updateState?.status === 'checking' || updateState?.status === 'downloading';
  const updatePercent = Math.max(0, Math.min(100, updateState?.progress?.percent ?? 0));
  const changelogRelease = updateState?.update ?? latestRelease;
  const changelogReleases = showAllChangelogs ? releaseHistory ?? [] : changelogRelease ? [changelogRelease] : [];

  return (
    <div className="settings-layout module-shell module-shell--settings">
      <div className="content-header">
        <div>
          <p className="section-kicker">Settings</p>
          <h2>App behavior</h2>
        </div>
      </div>

      <div className="settings-card">
        <p className="section-kicker">Display and startup behavior</p>
        <div className="settings-row settings-row--stack" title="Choose the app-wide visual theme.">
          <div>
            <strong>Theme</strong>
            <p>{themeOptions.find((option) => option.value === settings.theme)?.description ?? 'Choose the app-wide visual theme.'}</p>
          </div>
          <select
            className="macro-select settings-theme-select"
            value={settings.theme}
            disabled={busy}
            onChange={(event) => onThemeChange(event.target.value as AppTheme)}
            title="Choose the app-wide visual theme."
          >
            {themeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <label className="settings-row" title="Automatically open WinUtils when you sign into Windows.">
          <div>
            <strong>Launch at Windows login</strong>
            <p>Automatically open WinUtils when you sign into Windows.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            disabled={busy}
            onChange={(event) => onToggleLaunchAtLogin(event.target.checked)}
            title="Automatically open WinUtils when you sign into Windows."
          />
        </label>

        <label className="settings-row" title="Start WinUtils in the tray when it launches from Windows startup.">
          <div>
            <strong>Start minimized</strong>
            <p>When launched from startup, start in the system tray instead of focused.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.startMinimized}
            disabled={busy}
            onChange={(event) => onToggleStartMinimized(event.target.checked)}
            title="Start WinUtils in the tray when it launches from Windows startup."
          />
        </label>

        <label className="settings-row" title="Send WinUtils to the system tray when minimized instead of leaving it on the taskbar.">
          <div>
            <strong>Minimize to tray</strong>
            <p>Hide to system tray when minimized instead of showing in the taskbar.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.minimizeToTray}
            disabled={busy}
            onChange={(event) => onToggleMinimizeToTray(event.target.checked)}
            title="Send WinUtils to the system tray when minimized instead of leaving it on the taskbar."
          />
        </label>

        <label className="settings-row" title="Keep WinUtils running in the tray when the window close button is pressed.">
          <div>
            <strong>Close to tray</strong>
            <p>Keep running in the system tray when the window is closed.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.closeToTray}
            disabled={busy}
            onChange={(event) => onToggleCloseToTray(event.target.checked)}
            title="Keep WinUtils running in the tray when the window close button is pressed."
          />
        </label>
      </div>

      <div className="settings-card settings-card--updates">
        <p className="section-kicker">Updates and release notes</p>
        <div className="settings-update-header">
          <div>
            <strong>Updates</strong>
            <p>{updateStatus}</p>
          </div>
          <span className={`status-pill settings-update-badge status-pill--${updateBadgeTone}`} title="Current updater state.">
            {updateBadge}
          </span>
        </div>

        {updateState?.progress ? (
          <div className="settings-update-progress" aria-label="Update download progress">
            <span style={{ width: `${updatePercent}%` }} />
          </div>
        ) : null}

        {updateState?.error ? <div className="error-banner">{updateState.error}</div> : null}

        <div className="settings-update-actions">
          <button
            className="ghost-button"
            type="button"
            disabled={!updateState?.canCheck || updateDisabled}
            onClick={() => void runUpdateAction(() => window.winUtils.updates.check())}
            title="Check GitHub Releases for a newer WinUtils version."
          >
            {updateState?.status === 'checking' ? 'Checking...' : 'Check Now'}
          </button>

          {updateState?.canDownload ? (
            <button
              className="toggle-button"
              type="button"
              disabled={updateDisabled}
              onClick={() => void runUpdateAction(() => window.winUtils.updates.download())}
              title={updateState.installMode === 'portable' ? 'Open the release download page for the portable EXE.' : 'Download the available WinUtils update.'}
            >
              {updateState.installMode === 'portable' ? 'Open Download' : updateState.status === 'downloading' ? 'Downloading...' : 'Download Update'}
            </button>
          ) : null}

          {updateState?.canInstall ? (
            <button className="toggle-button" type="button" disabled={updateBusy} onClick={() => void runUpdateAction(() => window.winUtils.updates.install())} title="Install the downloaded update and restart WinUtils.">
              Install and Restart
            </button>
          ) : null}

          <button
            className="ghost-button"
            type="button"
            disabled={changelogBusy}
            onClick={() => void toggleChangelog()}
            title="Show the latest WinUtils release notes inside the app."
          >
            {changelogBusy ? 'Loading...' : changelogOpen ? 'Hide Changelog' : 'Changelog'}
          </button>

          <button className="ghost-button" type="button" onClick={() => void window.winUtils.updates.openReleasePage()} title="Open the WinUtils GitHub Releases page in your browser.">
            Releases
          </button>
        </div>

        {changelogOpen ? (
          <div className="settings-changelog">
            <div className="settings-changelog-header">
              <div>
                <strong>{showAllChangelogs ? 'All release changelogs' : formatReleaseTitle(changelogRelease)}</strong>
                <p>{showAllChangelogs ? formatReleaseHistoryMeta(releaseHistory, updateState?.currentVersion) : formatReleaseMeta(changelogRelease, updateState?.currentVersion)}</p>
              </div>
              <button
                className="ghost-button ghost-button--sm"
                type="button"
                disabled={changelogBusy}
                onClick={() => void toggleChangelogScope()}
                title={showAllChangelogs ? 'Only show the latest release notes.' : 'Load and show all previous release notes.'}
              >
                {showAllChangelogs ? 'Latest Only' : 'Show Previous Changes'}
              </button>
            </div>
            {changelogBusy ? <div className="empty-state">Loading changelog...</div> : null}
            {changelogError ? <div className="error-banner">{changelogError}</div> : null}
            {!changelogBusy && !changelogError ? (
              changelogReleases.length > 0 ? (
                <div className="settings-changelog-list">
                  {changelogReleases.map((release) => (
                    <section className="settings-changelog-release" key={`${release.version}-${release.releaseDate ?? ''}`}>
                      {showAllChangelogs ? (
                        <div className="settings-changelog-release-header">
                          <strong>{formatReleaseTitle(release)}</strong>
                          <p>{formatReleaseMeta(release, updateState?.currentVersion)}</p>
                        </div>
                      ) : null}
                      {release.releaseNotes?.trim() ? (
                        <MarkdownContent markdown={release.releaseNotes} />
                      ) : (
                        <div className="empty-state">No changelog text was published for this release.</div>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No changelog text was published for this release.</div>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatUpdateStatus(state: UpdateState): string {
  if (state.installMode === 'development') return `WinUtils ${state.currentVersion}. Update checks run in packaged builds.`;
  if (state.status === 'checking') return 'Checking GitHub releases for a newer version...';
  if (state.status === 'downloading') return `Downloading WinUtils ${state.update?.version ?? ''} (${Math.round(state.progress?.percent ?? 0)}%).`;
  if (state.status === 'downloaded') return `WinUtils ${state.update?.version} is ready to install.`;
  if (state.status === 'available') {
    return state.installMode === 'portable'
      ? `WinUtils ${state.update?.version} is available. Portable builds download the new EXE instead of self-installing.`
      : `WinUtils ${state.update?.version} is available.`;
  }
  if (state.status === 'not-available') return `WinUtils ${state.currentVersion} is up to date.`;
  if (state.status === 'error') return 'Update check failed.';
  return `WinUtils ${state.currentVersion}.`;
}

function formatUpdateBadge(state: UpdateState): string {
  if (state.installMode === 'development') return 'Dev build';
  if (state.status === 'checking') return 'Checking';
  if (state.status === 'downloading') return 'Downloading';
  if (state.status === 'downloaded') return 'Ready to install';
  if (state.status === 'available') return 'Update available';
  if (state.status === 'not-available') return 'Up to date';
  if (state.status === 'error') return 'Update failed';
  return 'Idle';
}

function getUpdateBadgeTone(state: UpdateState): 'enabled' | 'disabled' | 'info' {
  if (state.status === 'not-available' || state.status === 'downloaded') return 'enabled';
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'available') return 'info';
  return 'disabled';
}

function formatReleaseTitle(release: AppUpdateInfo | null): string {
  if (!release) return 'Latest release changelog';
  return release.releaseName?.trim() || `WinUtils ${release.version}`;
}

function formatReleaseMeta(release: AppUpdateInfo | null, currentVersion: string | undefined): string {
  if (!release) return 'Fetches the latest GitHub release notes without opening a browser.';

  const published = release.releaseDate ? `Published ${new Date(release.releaseDate).toLocaleDateString()}` : 'Release notes';
  const current = currentVersion ? `Current version ${currentVersion}` : 'Current version unknown';
  return `WinUtils ${release.version} - ${published} - ${current}`;
}

function formatReleaseHistoryMeta(releases: AppUpdateInfo[] | null, currentVersion: string | undefined): string {
  const current = currentVersion ? `Current version ${currentVersion}` : 'Current version unknown';
  if (!releases) return `Loads every published GitHub release. ${current}.`;
  if (releases.length === 0) return `No published releases found. ${current}.`;
  return `${releases.length} published release${releases.length === 1 ? '' : 's'} loaded. ${current}.`;
}

function MarkdownContent({ markdown }: { markdown: string }): ReactElement {
  return <div className="settings-changelog-markdown">{renderMarkdownBlocks(markdown)}</div>;
}

function renderMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    const key = `md-${blocks.length}`;

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={key}><code>{codeLines.join('\n')}</code></pre>);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push(renderMarkdownHeading(Math.min(heading[1].length, 4), heading[2], key));
      index += 1;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push(<hr key={key} />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test((lines[index] ?? '').trim())) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={key}>{renderInlineMarkdown(quoteLines.join(' '), key)}</blockquote>);
      continue;
    }

    const unordered = trimmed.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? '').trim();
        const item = orderedList ? current.match(/^\s*\d+[.)]\s+(.+)$/) : current.match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(<li key={`${key}-item-${items.length}`}>{renderInlineMarkdown(item[1], `${key}-item-${items.length}`)}</li>);
        index += 1;
      }
      blocks.push(orderedList ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isMarkdownBlockStart(lines[index] ?? '')) {
      const paragraphLine = (lines[index] ?? '').trim();
      if (!paragraphLine) break;
      paragraphLines.push(paragraphLine);
      index += 1;
    }
    blocks.push(<p key={key}>{renderInlineMarkdown(paragraphLines.join(' '), key)}</p>);
  }

  return blocks;
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed
    || trimmed.startsWith('```')
    || /^(#{1,4})\s+/.test(trimmed)
    || /^---+$/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^\s*[-*+]\s+/.test(trimmed)
    || /^\s*\d+[.)]\s+/.test(trimmed);
}

function renderMarkdownHeading(level: number, text: string, key: string): ReactElement {
  const content = renderInlineMarkdown(text, key);
  if (level === 1) return <h3 key={key}>{content}</h3>;
  if (level === 2) return <h4 key={key}>{content}</h4>;
  return <h5 key={key}>{content}</h5>;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"]*")?\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-inline-${nodes.length}`;
    const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1), key)}</em>);
    } else if (link) {
      nodes.push(<span className="settings-markdown-link" key={key} title={link[2]}>{renderInlineMarkdown(link[1], key)}</span>);
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length ? nodes : [text];
}
