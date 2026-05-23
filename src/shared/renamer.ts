export type RenamerItemKind = 'file' | 'folder';

export interface RenamerItem {
  id: string;
  path: string;
  directory: string;
  name: string;
  stem: string;
  extension: string;
  kind: RenamerItemKind;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export type RenameRuleType =
  | 'find-replace'
  | 'prefix-suffix'
  | 'case'
  | 'spaces'
  | 'trim'
  | 'clear-name'
  | 'numbering'
  | 'extension';

export interface RenameRuleBase {
  id: string;
  type: RenameRuleType;
  enabled: boolean;
}

export interface FindReplaceRule extends RenameRuleBase {
  type: 'find-replace';
  find: string;
  replace: string;
  useRegex: boolean;
  caseSensitive: boolean;
}

export interface PrefixSuffixRule extends RenameRuleBase {
  type: 'prefix-suffix';
  prefix: string;
  suffix: string;
}

export interface CaseRule extends RenameRuleBase {
  type: 'case';
  mode: 'lower' | 'upper' | 'title';
}

export interface SpacesRule extends RenameRuleBase {
  type: 'spaces';
  mode: 'underscore' | 'hyphen' | 'remove' | 'collapse';
}

export interface TrimRule extends RenameRuleBase {
  type: 'trim';
  start: number;
  end: number;
}

export interface ClearNameRule extends RenameRuleBase {
  type: 'clear-name';
}

export interface NumberingRule extends RenameRuleBase {
  type: 'numbering';
  start: number;
  increment: number;
  padding: number;
  position: 'prefix' | 'suffix';
  separator: string;
}

export interface ExtensionRule extends RenameRuleBase {
  type: 'extension';
  extension: string;
}

export type RenameRule =
  | FindReplaceRule
  | PrefixSuffixRule
  | CaseRule
  | SpacesRule
  | TrimRule
  | ClearNameRule
  | NumberingRule
  | ExtensionRule;

export interface RenamerLoadOptions {
  recursive: boolean;
  includeFolders: boolean;
}

export interface RenamerLoadPathsInput extends RenamerLoadOptions {
  paths: string[];
}

export interface RenamerPreviewInput {
  items: RenamerItem[];
  rules: RenameRule[];
}

export type RenameIssueSeverity = 'warning' | 'error';

export interface RenameIssue {
  severity: RenameIssueSeverity;
  message: string;
}

export type RenamePreviewStatus = 'unchanged' | 'ready' | 'warning' | 'error';

export interface RenamePreviewRow {
  id: string;
  path: string;
  directory: string;
  kind: RenamerItemKind;
  originalName: string;
  targetName: string;
  targetPath: string;
  status: RenamePreviewStatus;
  issues: RenameIssue[];
}

export interface RenamePreviewCounts {
  total: number;
  changed: number;
  unchanged: number;
  warnings: number;
  errors: number;
  conflicts: number;
}

export interface RenamePreview {
  rows: RenamePreviewRow[];
  counts: RenamePreviewCounts;
}

export interface RenameTransactionOperation {
  fromPath: string;
  toPath: string;
  originalName: string;
  targetName: string;
  kind: RenamerItemKind;
}

export interface RenameTransaction {
  id: string;
  createdAt: string;
  undoneAt?: string;
  operations: RenameTransactionOperation[];
}

export interface RenameApplyResult {
  transaction: RenameTransaction | null;
  renamedCount: number;
  items: RenamerItem[];
}

export interface RenameUndoResult {
  transaction: RenameTransaction;
  restoredCount: number;
  items: RenamerItem[];
}

export interface RenamerTransactionFile {
  version: 1;
  transactions: RenameTransaction[];
}