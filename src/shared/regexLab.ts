export interface RegexRenamerExport {
  id: string;
  pattern: string;
  flags: string;
  replacement: string;
  sampleText: string;
  createdAt: string;
}

export interface RegexTestInput { pattern: string; flags: string; sampleText: string }
export interface RegexMatchResult {
  error: string | null;
  matches: Array<{ value: string; index: number; groups: string[] }>;
}
