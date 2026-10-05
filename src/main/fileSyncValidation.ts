import type { FileSyncJobInput } from '../shared/fileSync';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file sync settings.');
  return value as Record<string, unknown>;
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('Unknown file sync setting.');
  return result;
}
function text(value: unknown, maximum = 32768): void {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new Error('Invalid file sync text.');
}
function choice(value: unknown, choices: string[]): void {
  if (value !== undefined && (typeof value !== 'string' || !choices.includes(value))) throw new Error('Invalid file sync option.');
}
function number(value: unknown, minimum: number, maximum: number): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)) throw new Error('Invalid file sync numeric limit.');
}
export function validateFileSyncInput(value: unknown): asserts value is FileSyncJobInput {
  const input = fields(value, ['name', 'leftPath', 'rightPath', 'mode', 'filters', 'options', 'triggers']);
  for (const key of ['name', 'leftPath', 'rightPath']) if (input[key] !== undefined) text(input[key], key === 'name' ? 512 : 32768);
  choice(input.mode, ['left-to-right-update', 'left-to-right-mirror', 'right-to-left-update', 'right-to-left-mirror', 'two-way']);
  if (input.filters !== undefined) {
    const filters = fields(input.filters, ['includePatterns', 'excludePatterns', 'excludeHidden', 'excludeSystem', 'excludeEmptyFolders', 'maxFileSizeBytes']);
    for (const key of ['includePatterns', 'excludePatterns']) if (filters[key] !== undefined) {
      const patterns = filters[key];
      if (!Array.isArray(patterns) || patterns.length > 256) throw new Error('Invalid file sync patterns.');
      patterns.forEach(value => text(value, 1024));
    }
    for (const key of ['excludeHidden', 'excludeSystem', 'excludeEmptyFolders']) if (filters[key] !== undefined && typeof filters[key] !== 'boolean') throw new Error('Invalid file sync filter flag.');
    number(filters.maxFileSizeBytes, 0, Number.MAX_SAFE_INTEGER);
  }
  if (input.options !== undefined) {
    const options = fields(input.options, ['compareMode', 'verifyCopies', 'quarantineDeletes', 'keepVersions', 'conflictPolicy', 'createMissingFolders', 'detectMoves', 'copyCreationTime', 'copySecurityBits', 'copyLockedFiles', 'symbolicLinks']);
    choice(options.compareMode, ['size-time', 'hash']);
    choice(options.conflictPolicy, ['manual', 'newer', 'left', 'right', 'keep-both']);
    choice(options.symbolicLinks, ['ignore', 'copy-as-is', 'drill-down']);
    for (const [key, value] of Object.entries(options)) if (!['compareMode', 'conflictPolicy', 'symbolicLinks'].includes(key) && typeof value !== 'boolean') throw new Error('Invalid file sync option flag.');
  }
  if (input.triggers !== undefined) {
    if (!Array.isArray(input.triggers) || input.triggers.length > 64) throw new Error('Invalid file sync triggers.');
    const ids = new Set<string>();
    for (const value of input.triggers) {
      const trigger = fields(value, ['id', 'type', 'enabled', 'intervalMinutes', 'debounceSeconds', 'mode']);
      text(trigger.id, 128);
      if (!trigger.id || ids.has(trigger.id as string)) throw new Error('Duplicate file sync trigger.');
      ids.add(trigger.id as string);
      if (typeof trigger.enabled !== 'boolean' || typeof trigger.type !== 'string') throw new Error('Invalid file sync trigger.');
      choice(trigger.type, ['manual', 'interval', 'on-change', 'on-startup', 'path-available', 'logoff', 'schedule']);
      choice(trigger.mode, ['analyze', 'sync']);
      number(trigger.intervalMinutes, 1, 10080); number(trigger.debounceSeconds, 1, 300);
    }
  }
}
