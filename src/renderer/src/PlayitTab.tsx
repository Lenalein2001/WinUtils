import { useEffect, useState, type ReactElement } from 'react';
import type { PlayitAgentClaimStart, PlayitState, PlayitTunnelType } from '../../shared/playit';

const playitTunnelTypes: Array<{ value: PlayitTunnelType; label: string }> = [
  { value: 'minecraft-java', label: 'Minecraft Java' },
  { value: 'minecraft-bedrock', label: 'Minecraft Bedrock' },
  { value: 'valheim', label: 'Valheim' },
  { value: 'terraria', label: 'Terraria' },
  { value: 'starbound', label: 'Starbound' },
  { value: 'rust', label: 'Rust' },
  { value: '7days', label: '7 Days to Die' },
  { value: 'unturned', label: 'Unturned' },
  { value: 'https', label: 'HTTPS' },
  { value: 'hytale', label: 'Hytale' },
  { value: 'project-zomboid', label: 'Project Zomboid' },
  { value: 'vintage-story', label: 'Vintage Story' },
];

const initialState = {
  name: 'Game Server',
  tunnelType: 'minecraft-java' as PlayitTunnelType,
};

export function PlayitTab(): ReactElement {
  const [state, setState] = useState<PlayitState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<PlayitAgentClaimStart | null>(null);
  const [form, setForm] = useState(initialState);
  const [editingTunnelId, setEditingTunnelId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ localIp: '127.0.0.1', localPort: '25565' });

  const loadState = async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      setState(await window.winUtils.playit.getState());
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to load Playit state.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadState();
  }, []);

  const runAction = async (label: string, action: () => Promise<PlayitState | void>, success?: string): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);

    try {
      const nextState = await action();
      if (nextState) setState(nextState);
      if (success) setMessage(success);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : `Unable to ${label}.`);
    } finally {
      setBusy(null);
    }
  };

  const handleInstall = async (): Promise<void> => {
    await runAction('install Playit', async () => {
      const result = await window.winUtils.playit.installWithWinget();
      setMessage(result.output || (result.ok ? 'Playit installed successfully.' : 'Playit install did not complete.'));
      return result.state;
    });
  };

  const handleDownloadInstall = async (): Promise<void> => {
    await runAction('download Playit', async () => {
      const result = await window.winUtils.playit.installFromDownload();
      setMessage(result.output || (result.ok ? 'Playit agent installed successfully.' : 'Playit agent install did not complete.'));
      return result.state;
    });
  };

  const handleCreateTunnel = async (): Promise<void> => {
    await runAction(
      'create tunnel',
      () => window.winUtils.playit.createTunnel({
        name: form.name,
        tunnelType: form.tunnelType,
      }),
      'Tunnel created. If the agent is running, Playit will begin forwarding traffic shortly.',
    );
  };

  const handleStartAgent = async (): Promise<void> => {
    await runAction('start Playit', () => window.winUtils.playit.startAgent(), 'Playit agent is online.');
  };

  const handleStartClaim = async (): Promise<void> => {
    await runAction('open claim page', async () => {
      const nextClaim = await window.winUtils.playit.startAgentClaim();
      setClaim(nextClaim);
      setMessage('Playit claim page opened. Approve the agent in your browser, then finish the claim here.');
    });
  };

  const handleCompleteClaim = async (): Promise<void> => {
    if (!claim) {
      setError('Open a Playit claim page first.');
      return;
    }

    await runAction('finish claim', async () => {
      const result = await window.winUtils.playit.completeAgentClaim(claim.claimCode);
      setMessage(result.output || (result.ok ? 'Playit agent claimed successfully.' : 'Playit claim did not complete.'));
      if (result.ok) setClaim(null);
      return result.state;
    });
  };

  const handleToggleTunnel = async (id: string, localIp: string, localPort: number, enabled: boolean): Promise<void> => {
    await runAction(
      enabled ? 'disable tunnel' : 'enable tunnel',
      () => window.winUtils.playit.updateTunnel({ id, localIp, localPort, enabled: !enabled }),
      enabled ? 'Tunnel disabled.' : 'Tunnel enabled.',
    );
  };

  const handleStartTunnelEdit = (id: string, localIp: string, localPort: number): void => {
    setEditingTunnelId(id);
    setEditForm({ localIp, localPort: String(localPort || '') });
  };

  const handleSaveTunnelEdit = async (id: string, enabled: boolean): Promise<void> => {
    const localPort = Number(editForm.localPort);

    await runAction(
      'save tunnel',
      async () => {
        const nextState = await window.winUtils.playit.updateTunnel({ id, localIp: editForm.localIp, localPort, enabled });
        setEditingTunnelId(null);
        return nextState;
      },
      'Tunnel target updated.',
    );
  };

  const handleDeleteTunnel = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Delete tunnel "${name}"?`)) return;

    await runAction('delete tunnel', () => window.winUtils.playit.deleteTunnel(id), 'Tunnel deleted.');
  };

  const handleCopy = async (value: string): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setMessage('Public address copied.');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to copy the public address.');
    }
  };

  const tool = state?.tool;
  const needsInstall = tool ? !tool.installed : false;
  const commandMissing = tool ? tool.installed && !tool.commandPath : false;
  const needsSetup = tool ? tool.installed && !tool.configured : false;
  const ready = Boolean(tool?.installed && tool.configured);
  const agentOnline = Boolean(tool?.online);
  const forwardingState = agentOnline ? 'Online' : tool?.running ? 'Needs restart' : 'Stopped';

  return (
    <div className="playit-layout">
      <div className="playit-header">
        <div>
          <p className="section-kicker">Playit Tunnels</p>
          <h2>Forward ports without router changes</h2>
          <p className="playit-subtitle">
            Create Playit.gg tunnels that point a public address at a local port on this PC.
          </p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void loadState()} disabled={loading || busy !== null} title="Recheck Playit installation, agent state, account status, and tunnels.">
          {loading ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {state?.error ? <div className="error-banner">{state.error}</div> : null}
      {message ? <div className="playit-message">{message}</div> : null}
      {busy === 'install Playit' || busy === 'download Playit' || busy === 'finish claim' ? (
        <div className="playit-install-progress" role="status" aria-live="polite">
          <div className="playit-progress-bar"><span /></div>
          <strong>
            {busy === 'install Playit'
              ? 'Installing Playit with Winget...'
              : busy === 'download Playit'
                ? 'Downloading and installing Playit agent...'
                : 'Waiting for Playit claim approval...'}
          </strong>
        </div>
      ) : null}

      <div className="playit-status-grid">
        <div className="playit-status-card">
          <span>Playit Agent</span>
          <strong>{tool?.installed ? 'Installed' : 'Missing'}</strong>
          <p>{tool?.commandPath ?? 'No Playit command was found on PATH or common install locations.'}</p>
        </div>
        <div className="playit-status-card">
          <span>Agent Setup</span>
          <strong>{tool?.configured ? 'Claimed' : 'Needs setup'}</strong>
          <p>{tool?.configPath ?? 'No Playit config path detected.'}</p>
        </div>
        <div className="playit-status-card">
          <span>Forwarding Process</span>
          <strong>{forwardingState}</strong>
          <p>{state?.account?.agentId ? `Agent ${state.account.agentId}` : tool?.lastLogLine ?? 'Start Playit when you want tunnels to accept traffic.'}</p>
        </div>
      </div>

      {loading ? <div className="empty-state">Checking Playit, Winget, config, and tunnel state...</div> : null}

      {!loading && needsInstall ? (
        <div className="playit-card playit-card--setup">
          <div>
            <h3>Install Playit</h3>
            <p>
              WinUtils needs the Playit agent installed locally before it can create tunnels. Use Winget or let WinUtils download the official signed agent installer.
            </p>
          </div>
          <div className="playit-actions">
            <button className="toggle-button" type="button" onClick={() => void handleInstall()} disabled={!tool?.wingetAvailable || busy !== null} title="Install the Playit agent using Winget if Winget is available on this PC.">
              {busy === 'install Playit' ? 'Installing...' : `Install with Winget`}
            </button>
            <button className="ghost-button" type="button" onClick={() => void handleDownloadInstall()} disabled={busy !== null} title="Download and run the official signed Playit agent installer directly.">
              {busy === 'download Playit' ? 'Installing...' : 'Download Agent'}
            </button>
          </div>
          {!tool?.wingetAvailable ? <p className="inline-note">Winget is not available, so only direct agent download is enabled.</p> : null}
        </div>
      ) : null}

      {!loading && commandMissing ? (
        <div className="playit-card playit-card--setup">
          <div>
            <h3>Playit command not found</h3>
            <p>
              Playit appears to be installed, but WinUtils cannot find a runnable agent command. Download the agent installer to repair the install, then refresh this module.
            </p>
          </div>
          <div className="playit-actions">
            <button className="ghost-button" type="button" onClick={() => void handleDownloadInstall()} disabled={busy !== null} title="Download and run the official signed Playit agent installer to repair the local command.">
              {busy === 'download Playit' ? 'Installing...' : 'Download Agent'}
            </button>
          </div>
        </div>
      ) : null}

      {!loading && needsSetup ? (
        <div className="playit-card playit-card--setup">
          <div>
            <h3>Claim the Playit agent</h3>
            <p>
              Playit is installed, but no local agent key was found. Open the claim page, approve the agent in your browser, then finish the claim here.
            </p>
          </div>
          <div className="playit-actions">
            <button className="toggle-button" type="button" onClick={() => void handleStartClaim()} disabled={busy !== null || !tool?.installed} title="Open Playit's browser claim flow for this local agent.">
              {busy === 'open claim page' ? 'Opening...' : 'Open Claim Page'}
            </button>
            <button className="ghost-button" type="button" onClick={() => void handleCompleteClaim()} disabled={busy !== null || !claim} title="Finish claiming the agent after approving it in the browser.">
              {busy === 'finish claim' ? 'Finishing...' : 'Finish Claim'}
            </button>
            <button className="ghost-button" type="button" onClick={() => void window.winUtils.playit.openAccountPage()} title="Open the Playit account and agent page in your browser.">
              Open Agent Page
            </button>
          </div>
          {claim ? <p className="inline-note">Claim code: {claim.claimCode}</p> : null}
        </div>
      ) : null}

      {ready ? (
        <>
          <div className="playit-card">
            <div className="playit-card-header">
              <div>
                <h3>Create tunnel</h3>
                <p>Choose one of the Playit tunnel types supported by this self-managed agent.</p>
              </div>
              {agentOnline ? <span className="status-pill status-pill--enabled">Agent online</span> : <span className="status-pill status-pill--disabled">Agent offline</span>}
            </div>
            <div className="playit-form-grid">
              <label>
                <span>Name</span>
                <input className="macro-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} title="Name shown for this Playit tunnel." />
              </label>
              <label>
                <span>Playit Type</span>
                <select className="macro-select" value={form.tunnelType} onChange={(event) => setForm({ ...form, tunnelType: event.target.value as PlayitTunnelType })} title="Choose the Playit-supported tunnel template for the local service you want to expose.">
                  {playitTunnelTypes.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="playit-actions playit-actions--end">
              {!agentOnline ? (
                <button className="toggle-button" type="button" onClick={() => void handleStartAgent()} disabled={busy !== null} title="Start or restart the local Playit agent so tunnels can forward traffic.">
                  {busy === 'start Playit' ? 'Starting...' : tool?.running ? 'Restart Playit' : 'Start Playit'}
                </button>
              ) : null}
              <button className="toggle-button" type="button" onClick={() => void handleCreateTunnel()} disabled={busy !== null || !agentOnline} title="Create a new tunnel for the selected Playit type. The agent must be online first.">
                {busy === 'create tunnel' ? 'Creating...' : 'Create Tunnel'}
              </button>
              <button className="ghost-button" type="button" onClick={() => void window.winUtils.playit.openAccountPage()} title="Open Playit's web dashboard for managing this agent and its tunnels.">
                Manage on Playit
              </button>
            </div>
          </div>

          <div className="playit-card">
            <div className="playit-card-header">
              <div>
                <h3>Current tunnels</h3>
                <p>{state?.account?.status ? `Account status: ${state.account.status}` : 'Tunnels configured for this Playit agent.'}</p>
              </div>
            </div>
            {state?.tunnels.length ? (
              <div className="playit-tunnel-list">
                {state.tunnels.map((tunnel) => (
                  <div className="playit-tunnel-row" key={tunnel.id}>
                    <div>
                      <strong>{tunnel.name}</strong>
                      {editingTunnelId === tunnel.id ? (
                        <div className="playit-edit-fields">
                          <input
                            className="macro-input"
                            value={editForm.localIp}
                            onChange={(event) => setEditForm({ ...editForm, localIp: event.target.value })}
                            aria-label="Local IP"
                            title="Local IP address the tunnel should forward to, usually 127.0.0.1 for this PC."
                          />
                          <input
                            className="macro-input"
                            type="number"
                            min="1"
                            max="65535"
                            value={editForm.localPort}
                            onChange={(event) => setEditForm({ ...editForm, localPort: event.target.value })}
                            aria-label="Local port"
                            title="Local TCP or UDP port the tunnel should forward to."
                          />
                        </div>
                      ) : (
                        <p>{tunnel.portType.toUpperCase()} - {tunnel.localIp}:{tunnel.localPort}</p>
                      )}
                    </div>
                    <code title="Public Playit address users connect to.">{tunnel.publicAddress || 'Allocation pending'}</code>
                    <span className={`status-pill status-pill--${tunnel.enabled ? 'enabled' : 'disabled'}`} title={tunnel.enabled ? 'This tunnel is enabled in Playit.' : 'This tunnel is disabled and will not accept traffic.'}>
                      {tunnel.enabled ? 'enabled' : tunnel.disabledReason ?? 'disabled'}
                    </span>
                    <div className="playit-row-actions">
                      <button className="micro-button" type="button" onClick={() => void handleCopy(tunnel.publicAddress)} disabled={!tunnel.publicAddress} title="Copy the public Playit address to the clipboard.">
                        Copy
                      </button>
                      {editingTunnelId === tunnel.id ? (
                        <>
                          <button className="micro-button" type="button" onClick={() => void handleSaveTunnelEdit(tunnel.id, tunnel.enabled)} disabled={busy !== null} title="Save the local IP and port for this tunnel.">
                            Save
                          </button>
                          <button className="micro-button" type="button" onClick={() => setEditingTunnelId(null)} disabled={busy !== null} title="Cancel editing this tunnel target.">
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="micro-button" type="button" onClick={() => handleStartTunnelEdit(tunnel.id, tunnel.localIp, tunnel.localPort)} disabled={busy !== null} title="Edit the local IP and port this tunnel forwards to.">
                          Edit
                        </button>
                      )}
                      <button
                        className="micro-button"
                        type="button"
                        onClick={() => void handleToggleTunnel(tunnel.id, tunnel.localIp, tunnel.localPort, tunnel.enabled)}
                        disabled={busy !== null}
                        title={tunnel.enabled ? 'Disable this tunnel in Playit.' : 'Enable this tunnel in Playit.'}
                      >
                        {tunnel.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="micro-button micro-button--danger" type="button" onClick={() => void handleDeleteTunnel(tunnel.id, tunnel.name)} disabled={busy !== null} title="Delete this tunnel from Playit.">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No Playit tunnels are registered for this agent yet.</div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
