export type ExplorerContextActionId = 'copy-path' | 'hash-sha256' | 'open-terminal';
export type ExplorerContextTarget = 'files' | 'folders';

export interface ExplorerContextEntry {
  actionId: ExplorerContextActionId;
  label: string;
  description: string;
  targets: ExplorerContextTarget[];
  enabled: boolean;
}

export interface ExplorerContextMenuState {
  installed: boolean;
  entries: ExplorerContextEntry[];
  executablePath: string;
  error: string | null;
}

export interface ExplorerContextMenuUpdate {
  entries: Array<Pick<ExplorerContextEntry, 'actionId' | 'enabled'>>;
}
