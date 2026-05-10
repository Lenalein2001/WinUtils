import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  PlayitAccountStatus,
  PlayitInstallResult,
  PlayitPortType,
  PlayitState,
  PlayitToolStatus,
  PlayitTunnel,
  PlayitTunnelInput,
  PlayitTunnelType,
  PlayitTunnelUpdateInput,
} from '../shared/playit';

const execFile = promisify(execFileCallback);

const PLAYIT_API_BASE = 'https://api.playit.gg';
const PLAYIT_WINGET_PACKAGE_ID = 'DevelopedMethods.playit';
const PLAYIT_COMMAND_NAMES = ['playit', 'playit-cli', 'playit-windows-x86_64'];
const PLAYIT_WINDOWS_INSTALLER_URL = 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64-signed.msi';
const PLAYIT_AGENT_LOG_NAME = 'winutils-agent.log';
const PLAYIT_TUNNEL_TYPES: readonly PlayitTunnelType[] = [
  'minecraft-java',
  'minecraft-bedrock',
  'valheim',
  'terraria',
  'starbound',
  'rust',
  '7days',
  'unturned',
  'https',
  'hytale',
  'project-zomboid',
  'vintage-story',
];

type ApiResult<T> =
  | { status: 'success'; data: T }
  | { status: 'fail'; data: unknown }
  | { status: 'error'; data: unknown };

type PlayitClaimSetupStatus = 'WaitingForUserVisit' | 'WaitingForUser' | 'UserAccepted' | 'UserRejected';

class PlayitApiError extends Error {
  constructor(
    readonly apiStatus: 'fail' | 'error',
    readonly data: unknown,
  ) {
    super(`Playit API rejected the request: ${JSON.stringify(data)}`);
  }
}

interface PlayitRunData {
  agent_id?: string;
  account_status?: string;
  agent_type?: string;
  account_features?: { regional_tunnels?: boolean };
  permissions?: { account_status?: string };
  tunnels?: PlayitApiTunnel[];
  notices?: Array<{ message?: string }>;
}

interface PlayitApiTunnel {
  id?: string;
  name?: string | null;
  user_enabled?: boolean;
  offline_reasons?: unknown[] | null;
  tunnel_type?: string | null;
  proto?: PlayitPortType;
  port_type?: PlayitPortType;
  port_count?: number;
  local_ip?: string;
  local_port?: number;
  agent_config?: { fields?: Array<{ name?: string; value?: string }> };
  origin?: {
    type?: string;
    details?: {
      config_data?: { fields?: Array<{ name?: string; value?: string }> };
    };
  };
  connect_addresses?: Array<{ value?: { address?: string } }>;
  assigned_domain?: string;
  custom_domain?: string | null;
  display_address?: string;
  disabled?: unknown;
  disabled_reason?: string | null;
  port?: { from?: number; to?: number };
}

interface PlayitTunnelsList {
  tunnels?: PlayitApiTunnel[];
}

export class PlayitManager {
  async getState(): Promise<PlayitState> {
    const tool = await this.getToolStatus();

    if (!tool.configured) {
      return { tool, account: null, tunnels: [], error: null };
    }

    try {
      const secret = await this.readSecret();
      const [runData, tunnelList] = await Promise.all([
        this.callPlayitApi<PlayitRunData>('/v1/agents/rundata', secret, {}),
        this.callPlayitApi<PlayitTunnelsList>('/v1/tunnels/list', secret, {}),
      ]);
      return {
        tool,
        account: this.mapAccount(runData),
        tunnels: this.mapTunnels(tunnelList.tunnels ?? runData.tunnels ?? []),
        error: null,
      };
    } catch (error) {
      return {
        tool,
        account: null,
        tunnels: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async installWithWinget(): Promise<PlayitInstallResult> {
    const winget = await this.findCommand('winget');
    if (!winget) {
      return {
        ok: false,
        output: 'Winget is not available on this machine.',
        state: await this.getState(),
      };
    }

    try {
      const { stdout, stderr } = await execFile(
        winget,
        ['install', '--id', PLAYIT_WINGET_PACKAGE_ID, '--exact', '--accept-package-agreements', '--accept-source-agreements'],
        { encoding: 'utf8', timeout: 10 * 60 * 1000, windowsHide: false },
      );

      return {
        ok: true,
        output: this.summarizeWingetInstall(`${stdout ?? ''}${stderr ?? ''}`, true),
        state: await this.getState(),
      };
    } catch (error) {
      return {
        ok: false,
        output: this.summarizeWingetInstall(this.commandErrorMessage(error), false),
        state: await this.getState(),
      };
    }
  }

  async installFromDownload(): Promise<PlayitInstallResult> {
    const installerPath = path.join(tmpdir(), 'WinUtils', 'playit-windows-x86_64-signed.msi');

    try {
      await mkdir(path.dirname(installerPath), { recursive: true });

      const response = await fetch(PLAYIT_WINDOWS_INSTALLER_URL, {
        headers: { 'User-Agent': 'WinUtils' },
      });

      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}.`);
      }

      const installer = Buffer.from(await response.arrayBuffer());
      await writeFile(installerPath, installer);

      await execFile('msiexec.exe', ['/i', installerPath, '/passive', '/norestart'], {
        encoding: 'utf8',
        timeout: 10 * 60 * 1000,
        windowsHide: false,
      });

      await unlink(installerPath).catch(() => undefined);

      return {
        ok: true,
        output: 'Playit agent downloaded and installed successfully.',
        state: await this.getState(),
      };
    } catch (error) {
      await unlink(installerPath).catch(() => undefined);

      return {
        ok: false,
        output: this.summarizeDownloadedInstall(this.commandErrorMessage(error)),
        state: await this.getState(),
      };
    }
  }

  async startAgentClaim(): Promise<import('../shared/playit').PlayitAgentClaimStart> {
    const claimCode = randomBytes(5).toString('hex');
    await this.callPlayitPublicApi<PlayitClaimSetupStatus>('/claim/setup', {
      code: claimCode,
      agent_type: 'self-managed',
      version: 'WinUtils Playit module',
    });

    return {
      claimCode,
      claimUrl: `https://playit.gg/claim/${claimCode}`,
    };
  }

  async completeAgentClaim(claimCode: string): Promise<PlayitInstallResult> {
    const code = claimCode.trim();
    if (!/^[a-fA-F0-9]{10}$/.test(code)) {
      return {
        ok: false,
        output: 'The Playit claim code is invalid. Open a new claim page and try again.',
        state: await this.getState(),
      };
    }

    try {
      await this.waitForClaimApproval(code);
      const exchanged = await this.exchangeClaim(code);
      await this.writeSecret(exchanged.secret_key);
      await this.startAgent();

      return {
        ok: true,
        output: 'Playit agent claimed successfully.',
        state: await this.getState(),
      };
    } catch (error) {
      return {
        ok: false,
        output: this.summarizeClaimError(error),
        state: await this.getState(),
      };
    }
  }

  async createTunnel(input: PlayitTunnelInput): Promise<PlayitState> {
    this.validateTunnelInput(input);

    const secret = await this.readSecret();
    const runData = await this.callPlayitApi<PlayitRunData>('/v1/agents/rundata', secret, {});
    const agentId = runData.agent_id;

    if (!agentId) {
      throw new Error('Playit did not return an agent id. Open Playit once and make sure the agent is claimed.');
    }

    await this.callPlayitApi<{ id: string }>('/v1/tunnels/create', secret, {
      name: input.name.trim(),
      protocol: {
        type: 'tunnel-type',
        details: input.tunnelType,
      },
      origin: {
        type: 'agent',
        data: {
          agent_id: agentId,
          config: {},
        },
      },
      endpoint: {
        type: 'region',
        details: { region: 'global', port: null },
      },
      enabled: true,
      firewall_id: null,
    });

    return this.getState();
  }

  async getTunnelSetupUrl(): Promise<string> {
    await this.startAgent();

    const secret = await this.readSecret();
    const runData = await this.callPlayitApi<PlayitRunData>('/agents/rundata', secret, {});
    const agentId = runData.agent_id;

    if (!agentId) {
      return 'https://playit.gg/account/setup/new-tunnel';
    }

    return `https://playit.gg/account/setup/new-tunnel?agent_id=${encodeURIComponent(agentId)}`;
  }

  async updateTunnel(input: PlayitTunnelUpdateInput): Promise<PlayitState> {
    this.validateTunnelUpdateInput(input);

    const secret = await this.readSecret();
    const [runData, tunnelList] = await Promise.all([
      this.callPlayitApi<PlayitRunData>('/v1/agents/rundata', secret, {}),
      this.callPlayitApi<PlayitTunnelsList>('/v1/tunnels/list', secret, {}),
    ]);
    const agentId = runData.agent_id;
    const tunnel = (tunnelList.tunnels ?? runData.tunnels ?? []).find((candidate) => candidate.id === input.id);

    if (!agentId) {
      throw new Error('Playit did not return an agent id. Open Playit once and make sure the agent is claimed.');
    }

    if (!tunnel?.id) {
      throw new Error('Playit tunnel was not found. Refresh the tunnel list and try again.');
    }

    const current = this.mapTunnels([tunnel])[0];
    const configChanged = current.localIp !== input.localIp.trim() || current.localPort !== input.localPort;
    const enabledChanged = current.enabled !== input.enabled;

    if (configChanged) {
      await this.callPlayitApi<void>('/v1/tunnels/config', secret, {
        tunnel_id: input.id,
        new_agent_id: null,
        new_config: this.buildTunnelConfig(tunnel, input.localIp.trim(), input.localPort),
      });
    }

    if (enabledChanged) {
      await this.callPlayitApi<void>('/tunnels/enable', secret, {
        tunnel_id: input.id,
        enabled: input.enabled,
      });
    }

    return this.getState();
  }

  async deleteTunnel(id: string): Promise<PlayitState> {
    if (!id.trim()) throw new Error('Tunnel id is required.');

    const secret = await this.readSecret();
    await this.callPlayitApi<void>('/tunnels/delete', secret, { tunnel_id: id });
    return this.getState();
  }

  async startAgent(): Promise<PlayitState> {
    const commandPath = await this.findPlayitCommand();
    if (!commandPath) {
      throw new Error('Playit is not installed or is not available on PATH.');
    }

    if (await this.isPlayitOnline()) {
      return this.getState();
    }

    if (await this.isPlayitRunning()) {
      await this.stopPlayitProcesses();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const logPath = this.getAgentLogPath();
    await mkdir(path.dirname(logPath), { recursive: true });
    await unlink(logPath).catch(() => undefined);

    const child = spawn(commandPath, ['--log_path', logPath, 'start'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    await this.waitForPlayitOnline(20_000);

    const connection = await this.getPlayitConnectionStatus();
    if (!connection.online) {
      const detail = connection.lastLogLine ? ` Last Playit log: ${connection.lastLogLine}` : '';
      throw new Error(`Playit started, but it did not come online.${detail}`);
    }

    return this.getState();
  }

  private async getToolStatus(): Promise<PlayitToolStatus> {
    const [commandPath, wingetPath, running, connection] = await Promise.all([
      this.findPlayitCommand(),
      this.findCommand('winget'),
      this.isPlayitRunning(),
      this.getPlayitConnectionStatus(),
    ]);

    const configPath = this.getConfigPath();
    const configured = configPath ? await this.hasSecret(configPath) : false;
    const [version, wingetPackageInstalled] = await Promise.all([
      commandPath ? this.getPlayitVersion(commandPath) : Promise.resolve<string | null>(null),
      wingetPath ? this.isWingetPackageInstalled(wingetPath) : Promise.resolve(false),
    ]);

    return {
      installed: Boolean(commandPath) || wingetPackageInstalled,
      commandPath,
      version,
      configured,
      configPath,
      running,
      online: running && connection.online,
      logPath: connection.logPath,
      lastLogLine: connection.lastLogLine,
      wingetAvailable: Boolean(wingetPath),
      wingetPackageInstalled,
      wingetPackageId: PLAYIT_WINGET_PACKAGE_ID,
    };
  }

  private async findPlayitCommand(): Promise<string | null> {
    for (const command of PLAYIT_COMMAND_NAMES) {
      const found = await this.findCommand(command);
      if (found) return found;
    }

    for (const candidate of this.commonPlayitPaths()) {
      if (existsSync(candidate)) return candidate;
    }

    return null;
  }

  private async findCommand(command: string): Promise<string | null> {
    try {
      const { stdout } = await execFile('where.exe', [command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const first = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      return first ?? null;
    } catch {
      return null;
    }
  }

  private commonPlayitPaths(): string[] {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

    return [
      path.join(localAppData, 'Microsoft', 'WindowsApps', 'playit.exe'),
      path.join(localAppData, 'playit_gg', 'bin', 'playit.exe'),
      path.join(localAppData, 'Programs', 'playit', 'playit.exe'),
      path.join(localAppData, 'Programs', 'playit.gg', 'playit.exe'),
      path.join(programFiles, 'playit_gg', 'bin', 'playit.exe'),
      path.join(programFiles, 'playit', 'playit.exe'),
      path.join(programFiles, 'playit.gg', 'playit.exe'),
      path.join(programFilesX86, 'playit_gg', 'bin', 'playit.exe'),
      path.join(programFilesX86, 'playit', 'playit.exe'),
      path.join(programFilesX86, 'playit.gg', 'playit.exe'),
    ];
  }

  private getConfigPath(): string | null {
    const defaultConfigPath = this.getDefaultConfigPath();
    const candidates = [
      defaultConfigPath,
      path.join(process.cwd(), 'playit.toml'),
    ];

    return candidates.find((candidate) => existsSync(candidate)) ?? defaultConfigPath;
  }

  private getDefaultConfigPath(): string {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'playit_gg', 'playit.toml');
  }

  private async hasSecret(configPath: string): Promise<boolean> {
    try {
      await this.readSecretFromPath(configPath);
      return true;
    } catch {
      return false;
    }
  }

  private async readSecret(): Promise<string> {
    const configPath = this.getConfigPath();
    if (!configPath || !existsSync(configPath)) {
      throw new Error('Playit is not configured yet. Start Playit once and claim the agent in your browser.');
    }

    return this.readSecretFromPath(configPath);
  }

  private async readSecretFromPath(configPath: string): Promise<string> {
    const raw = await readFile(configPath, 'utf8');
    const trimmed = raw.trim();

    if (/^[a-fA-F0-9]+$/.test(trimmed)) return trimmed;

    const match = raw.match(/secret_key\s*=\s*["']?([a-fA-F0-9]+)["']?/);
    if (!match) {
      throw new Error('Playit config exists, but no valid agent secret was found.');
    }

    return match[1];
  }

  private async getPlayitVersion(commandPath: string): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFile(commandPath, ['version'], { encoding: 'utf8', timeout: 7000, windowsHide: true });
      return `${stdout ?? ''}${stderr ?? ''}`.trim() || null;
    } catch {
      return null;
    }
  }

  private async isWingetPackageInstalled(wingetPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFile(
        wingetPath,
        ['list', '--id', PLAYIT_WINGET_PACKAGE_ID, '--exact', '--accept-source-agreements'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true },
      );
      return String(stdout ?? '').toLowerCase().includes(PLAYIT_WINGET_PACKAGE_ID.toLowerCase());
    } catch {
      return false;
    }
  }

  private async isPlayitRunning(): Promise<boolean> {
    try {
      const { stdout } = await execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 7000, windowsHide: true });
      return String(stdout ?? '').split(/\r?\n/).some((line) => /^"?playit/i.test(line.trim()));
    } catch {
      return false;
    }
  }

  private async isPlayitOnline(): Promise<boolean> {
    if (!(await this.isPlayitRunning())) return false;
    return (await this.getPlayitConnectionStatus()).online;
  }

  private async getPlayitConnectionStatus(): Promise<{ online: boolean; logPath: string; lastLogLine: string | null }> {
    const logPath = this.getAgentLogPath();

    try {
      const [logStats, raw] = await Promise.all([stat(logPath), readFile(logPath, 'utf8')]);
      const age = Date.now() - logStats.mtimeMs;
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const recentLines = lines.slice(-80);
      const lastLogLine = lines.at(-1) ?? null;
      const online = age < 45_000 && recentLines.some((line) => /agent registered|tunnel running|udp session details received/i.test(line));

      return { online, logPath, lastLogLine };
    } catch {
      return { online: false, logPath, lastLogLine: null };
    }
  }

  private getAgentLogPath(): string {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'playit_gg', PLAYIT_AGENT_LOG_NAME);
  }

  private async waitForPlayitOnline(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.getPlayitConnectionStatus();
      if (status.online) return;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  private async stopPlayitProcesses(): Promise<void> {
    try {
      await execFile('taskkill.exe', ['/IM', 'playit.exe', '/F'], { encoding: 'utf8', timeout: 7000, windowsHide: true });
    } catch {
      // It may already be stopped.
    }
  }

  private async callPlayitApi<T>(route: string, secret: string, body: unknown): Promise<T> {
    const response = await fetch(`${PLAYIT_API_BASE}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Agent-Key ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      if (route.includes('/tunnels/create') && response.status === 400) {
        throw new Error('Playit rejected tunnel creation. Choose a Playit-supported tunnel type or manage the tunnel on Playit, then refresh WinUtils.');
      }

      if (route.includes('/tunnels/config') && response.status === 400) {
        throw new Error('Playit rejected the tunnel config change. Check that the local port matches the selected Playit tunnel type.');
      }

      throw new Error(`Playit API request failed with HTTP ${response.status}.`);
    }

    const parsed = JSON.parse(text) as ApiResult<T>;
    if (parsed.status === 'success') return parsed.data;

    throw new PlayitApiError(parsed.status, parsed.data);
  }

  private async callPlayitPublicApi<T>(route: string, body: unknown): Promise<T> {
    const response = await fetch(`${PLAYIT_API_BASE}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Playit API request failed with HTTP ${response.status}.`);
    }

    const parsed = JSON.parse(text) as ApiResult<T>;
    if (parsed.status === 'success') return parsed.data;

    throw new PlayitApiError(parsed.status, parsed.data);
  }

  private async waitForClaimApproval(claimCode: string): Promise<void> {
    const deadline = Date.now() + 2 * 60 * 1000;

    while (Date.now() < deadline) {
      const status = await this.callPlayitPublicApi<PlayitClaimSetupStatus>('/claim/setup', {
        code: claimCode,
        agent_type: 'self-managed',
        version: 'WinUtils Playit module',
      });

      if (status === 'UserAccepted') return;
      if (status === 'UserRejected') throw new Error('Playit claim was rejected.');

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error('Timed out waiting for Playit claim approval.');
  }

  private async exchangeClaim(claimCode: string): Promise<{ secret_key: string }> {
    const deadline = Date.now() + 30 * 1000;

    while (Date.now() < deadline) {
      try {
        return await this.callPlayitPublicApi<{ secret_key: string }>('/claim/exchange', { code: claimCode });
      } catch (error) {
        if (!this.isClaimPendingError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    throw new Error('Timed out while finalizing the Playit claim.');
  }

  private async writeSecret(secret: string): Promise<void> {
    const trimmed = secret.trim();
    if (!/^[a-fA-F0-9]+$/.test(trimmed)) throw new Error('Playit returned an invalid agent secret.');

    const configPath = this.getDefaultConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `secret_key = "${trimmed}"\n`, 'utf8');
  }

  private mapAccount(data: PlayitRunData): PlayitAccountStatus {
    return {
      agentId: data.agent_id ?? null,
      status: data.permissions?.account_status ?? data.account_status ?? data.agent_type ?? null,
      regionalTunnels: data.account_features?.regional_tunnels ?? null,
      notices: (data.notices ?? []).map((notice) => notice.message).filter((message): message is string => Boolean(message)),
    };
  }

  private mapTunnels(tunnels: PlayitApiTunnel[]): PlayitTunnel[] {
    return tunnels.map((tunnel) => {
      const localIp = this.getTunnelConfigValue(tunnel, 'local_ip') ?? tunnel.local_ip ?? '127.0.0.1';
      const localPort = this.getTunnelLocalPort(tunnel);
      const portFrom = tunnel.port?.from;
      const portTo = tunnel.port?.to;
      const derivedPortCount = portFrom && portTo && portTo > portFrom ? portTo - portFrom : 1;
      const portRange = portFrom && portTo && portTo > portFrom + 1 ? `${portFrom}-${portTo - 1}` : portFrom ? String(portFrom) : '';
      const domain = tunnel.custom_domain ?? tunnel.assigned_domain ?? tunnel.display_address ?? this.getTunnelConnectAddress(tunnel) ?? '';

      return {
        id: tunnel.id ?? crypto.randomUUID(),
        name: tunnel.name ?? 'Unnamed tunnel',
        portType: tunnel.proto ?? tunnel.port_type ?? 'tcp',
        portCount: Number(tunnel.port_count ?? derivedPortCount),
        localIp,
        localPort,
        publicAddress: domain && portRange ? `${domain}:${portRange}` : domain,
        enabled: tunnel.user_enabled ?? (!tunnel.disabled && !tunnel.disabled_reason),
        disabledReason: tunnel.disabled_reason ?? (tunnel.disabled ? 'disabled' : null),
      };
    });
  }

  private buildTunnelConfig(tunnel: PlayitApiTunnel, localIp: string, localPort: number): { fields: Array<{ name: string; value: string }> } {
    const existingFields = this.getTunnelConfigFields(tunnel);
    const fieldMap = new Map<string, string>();

    for (const field of existingFields) {
      if (field.name && typeof field.value === 'string') fieldMap.set(field.name, field.value);
    }

    fieldMap.set('local_ip', localIp);
    if (tunnel.tunnel_type === 'https') {
      fieldMap.set('http_port', String(localPort));
    } else {
      fieldMap.set('local_port', String(localPort));
    }

    return {
      fields: Array.from(fieldMap.entries()).map(([name, value]) => ({ name, value })),
    };
  }

  private getTunnelLocalPort(tunnel: PlayitApiTunnel): number {
    const configPort = tunnel.tunnel_type === 'https'
      ? this.getTunnelConfigValue(tunnel, 'http_port')
      : this.getTunnelConfigValue(tunnel, 'local_port');

    const localPort = Number(configPort ?? tunnel.local_port ?? this.getPortFromAddress(tunnel.display_address ?? this.getTunnelConnectAddress(tunnel) ?? undefined) ?? 0);
    return Number.isFinite(localPort) ? localPort : 0;
  }

  private getTunnelConfigValue(tunnel: PlayitApiTunnel, name: string): string | null {
    return this.getTunnelConfigFields(tunnel).find((field) => field.name === name)?.value ?? null;
  }

  private getTunnelConfigFields(tunnel: PlayitApiTunnel): Array<{ name?: string; value?: string }> {
    return tunnel.agent_config?.fields ?? tunnel.origin?.details?.config_data?.fields ?? [];
  }

  private getPortFromAddress(address: string | undefined): number | null {
    const port = address?.match(/:(\d+)$/)?.[1];
    if (!port) return null;

    const parsed = Number(port);
    return Number.isInteger(parsed) ? parsed : null;
  }

  private getTunnelConnectAddress(tunnel: PlayitApiTunnel): string | null {
    return tunnel.connect_addresses?.find((entry) => entry.value?.address)?.value?.address ?? null;
  }

  private validateTunnelInput(input: PlayitTunnelInput): void {
    if (!input.name.trim()) throw new Error('Tunnel name is required.');
    if (!PLAYIT_TUNNEL_TYPES.includes(input.tunnelType)) {
      throw new Error('Playit tunnel type is not supported.');
    }
  }

  private validateTunnelUpdateInput(input: PlayitTunnelUpdateInput): void {
    if (!input.id.trim()) throw new Error('Tunnel id is required.');
    if (!input.localIp.trim()) throw new Error('Local IP is required.');
    if (!Number.isInteger(input.localPort) || input.localPort < 1 || input.localPort > 65535) {
      throw new Error('Local port must be between 1 and 65535.');
    }
  }

  private commandErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
      const maybe = error as { message?: string; stdout?: string; stderr?: string };
      return `${maybe.stdout ?? ''}${maybe.stderr ?? ''}${maybe.message ? `\n${maybe.message}` : ''}`.trim();
    }

    return String(error);
  }

  private summarizeWingetInstall(output: string, ok: boolean): string {
    const normalized = output.toLowerCase();

    if (ok) {
      if (/already installed|bereits installiert|no applicable update/.test(normalized)) {
        return 'Playit is already installed.';
      }

      return 'Playit installed successfully.';
    }

    if (/cancelled|abgebrochen/.test(normalized)) {
      return 'Playit installation was cancelled.';
    }

    if (/no package found|keine.*paket|not found/.test(normalized)) {
      return 'Winget could not find the Playit package.';
    }

    return 'Winget could not install Playit. Open the download page or try the install again.';
  }

  private summarizeDownloadedInstall(output: string): string {
    const normalized = output.toLowerCase();

    if (/cancelled|abgebrochen|1602/.test(normalized)) {
      return 'Playit agent installation was cancelled.';
    }

    if (/http|download/.test(normalized)) {
      return 'WinUtils could not download the Playit agent installer.';
    }

    return 'WinUtils could not install the downloaded Playit agent.';
  }

  private summarizeClaimError(error: unknown): string {
    if (error instanceof PlayitApiError) {
      const details = JSON.stringify(error.data);
      if (/UserRejected/.test(details)) return 'Playit claim was rejected.';
      if (/CodeExpired|CodeNotFound/.test(details)) return 'The Playit claim expired. Open a new claim page and try again.';
      if (/NotAccepted|WaitingForUser|NotSetup/.test(details)) return 'The Playit claim has not been approved yet.';
    }

    if (error instanceof Error) return error.message;
    return String(error);
  }

  private isClaimPendingError(error: unknown): boolean {
    if (!(error instanceof PlayitApiError)) return false;
    return /NotAccepted|NotSetup|WaitingForUser/.test(JSON.stringify(error.data));
  }
}
