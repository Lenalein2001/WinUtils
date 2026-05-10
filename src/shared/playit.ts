export type PlayitPortType = 'tcp' | 'udp' | 'both';
export type PlayitTunnelType =
  | 'minecraft-java'
  | 'minecraft-bedrock'
  | 'valheim'
  | 'terraria'
  | 'starbound'
  | 'rust'
  | '7days'
  | 'unturned'
  | 'https'
  | 'hytale'
  | 'project-zomboid'
  | 'vintage-story';

export interface PlayitToolStatus {
  installed: boolean;
  commandPath: string | null;
  version: string | null;
  configured: boolean;
  configPath: string | null;
  running: boolean;
  online: boolean;
  logPath: string | null;
  lastLogLine: string | null;
  wingetAvailable: boolean;
  wingetPackageInstalled: boolean;
  wingetPackageId: string;
}

export interface PlayitAccountStatus {
  agentId: string | null;
  status: string | null;
  regionalTunnels: boolean | null;
  notices: string[];
}

export interface PlayitTunnel {
  id: string;
  name: string;
  portType: PlayitPortType;
  portCount: number;
  localIp: string;
  localPort: number;
  publicAddress: string;
  enabled: boolean;
  disabledReason: string | null;
}

export interface PlayitState {
  tool: PlayitToolStatus;
  account: PlayitAccountStatus | null;
  tunnels: PlayitTunnel[];
  error: string | null;
}

export interface PlayitTunnelInput {
  name: string;
  tunnelType: PlayitTunnelType;
}

export interface PlayitTunnelUpdateInput {
  id: string;
  localIp: string;
  localPort: number;
  enabled: boolean;
}

export interface PlayitAgentClaimStart {
  claimCode: string;
  claimUrl: string;
}

export interface PlayitInstallResult {
  ok: boolean;
  output: string;
  state: PlayitState;
}
