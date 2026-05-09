export type FocusAudioMode = 'whitelist' | 'blacklist';

export interface FocusAudioConfig {
  enabled: boolean;
  mode: FocusAudioMode;
  whitelist: string[];
  blacklist: string[];
}

export interface FocusAudioState extends FocusAudioConfig {
  activeAudioApps: string[];
}
