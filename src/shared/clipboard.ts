export type ClipboardEntryType = 'text' | 'image' | 'files';

export type ClipboardCategory = 'plain-text' | 'url' | 'email' | 'code' | 'file-path' | 'image';

export type ClipboardOcrStatus = 'none' | 'pending' | 'complete' | 'error' | 'unsupported';

export type ClipboardFilter = ClipboardCategory | 'all' | 'pinned';

export type ClipboardClearMode = 'all' | 'unpinned';

export interface ClipboardImageInfo {
  width: number;
  height: number;
  fileName: string;
  thumbnailDataUrl?: string;
}

export interface ClipboardEntry {
  id: string;
  type: ClipboardEntryType;
  categories: ClipboardCategory[];
  preview: string;
  text?: string;
  filePaths?: string[];
  image?: ClipboardImageInfo;
  ocrText?: string;
  ocrStatus: ClipboardOcrStatus;
  ocrError?: string;
  hash: string;
  pinned: boolean;
  copiedAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  sizeBytes?: number;
}

export interface ClipboardSettings {
  monitoring: boolean;
  captureImages: boolean;
  imageOcr: boolean;
  quickAccessHotkey: string;
  maxEntries: number;
}

export interface ClipboardQuery {
  search?: string;
  filter?: ClipboardFilter;
  type?: ClipboardEntryType | 'all';
  limit?: number;
}

export interface ClipboardState {
  entries: ClipboardEntry[];
  total: number;
  pinnedCount: number;
  textCount: number;
  imageCount: number;
  fileCount: number;
  settings: ClipboardSettings;
  quickAccessRegistered: boolean;
  registeredQuickAccessHotkey: string | null;
  registeredQuickAccessHotkeys: string[];
  quickAccessRegistrationError: string | null;
  lastQuickAccessAt: string | null;
  availableCategories: ClipboardCategory[];
}