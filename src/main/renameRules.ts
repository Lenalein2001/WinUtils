import type { RenameIssue, RenameRule, RenamerItem } from '../shared/renamer';

export function applyRules(item: RenamerItem, rules: RenameRule[], index: number): { name: string; issues: RenameIssue[] } {
  let stem = item.stem;
  let extension = item.extension;
  const issues: RenameIssue[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    try {
      switch (rule.type) {
        case 'find-replace': {
          if (!rule.find) break;
          if (rule.useRegex) {
            const flags = rule.caseSensitive ? 'g' : 'gi';
            stem = stem.replace(new RegExp(rule.find, flags), rule.replace);
          } else if (rule.caseSensitive) {
            stem = stem.split(rule.find).join(rule.replace);
          } else {
            stem = stem.replace(new RegExp(escapeRegExp(rule.find), 'gi'), rule.replace);
          }
          break;
        }
        case 'prefix-suffix':
          stem = `${rule.prefix}${stem}${rule.suffix}`;
          break;
        case 'case':
          stem = applyCase(stem, rule.mode);
          break;
        case 'spaces':
          stem = applySpaces(stem, rule.mode);
          break;
        case 'trim':
          stem = stem.slice(Math.max(0, rule.start), Math.max(Math.max(0, rule.start), stem.length - Math.max(0, rule.end)));
          break;
        case 'clear-name':
          stem = '';
          break;
        case 'numbering': {
          const number = String(rule.start + index * rule.increment).padStart(Math.max(0, rule.padding), '0');
          const separator = stem ? rule.separator : '';
          stem = rule.position === 'prefix'
            ? `${number}${separator}${stem}`
            : `${stem}${separator}${number}`;
          break;
        }
        case 'extension': {
          if (item.kind === 'folder') break;
          const nextExtension = rule.extension.trim();
          extension = nextExtension ? `.${nextExtension.replace(/^\.+/, '')}` : '';
          break;
        }
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Rule failed while building this preview.',
      });
    }
  }

  return {
    name: `${stem}${extension}`,
    issues,
  };
}

export function applyCase(value: string, mode: 'lower' | 'upper' | 'title'): string {
  if (mode === 'lower') return value.toLowerCase();
  if (mode === 'upper') return value.toUpperCase();

  return value
    .toLowerCase()
    .replace(/(^|[\s_-])([a-z0-9])/g, (_match, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`);
}

export function applySpaces(value: string, mode: 'underscore' | 'hyphen' | 'remove' | 'collapse'): string {
  if (mode === 'underscore') return value.replace(/\s+/g, '_');
  if (mode === 'hyphen') return value.replace(/\s+/g, '-');
  if (mode === 'remove') return value.replace(/\s+/g, '');
  return value.replace(/\s+/g, ' ').trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

