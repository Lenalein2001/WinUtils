export type FocusAudioMode = 'whitelist' | 'blacklist';

/** Lowers `targetApps` volume while any of `triggerApps` is actively rendering audio. */
export interface FocusAudioDuckRule {
  id: string;
  enabled: boolean;
  triggerApps: string[];
  targetApps: string[];
  duckPercent: number;
}

export interface FocusAudioConfig {
  enabled: boolean;
  mode: FocusAudioMode;
  whitelist: string[];
  blacklist: string[];
  duckingEnabled: boolean;
  duckRules: FocusAudioDuckRule[];
}

export interface FocusAudioState extends FocusAudioConfig {
  activeAudioApps: string[];
  playingApps: string[];
  duckedApps: string[];
}
