import type { ChangeEvent, DragEvent, ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RegexRenamerExport } from '../../shared/regexLab';
import type { RenamePreview, RenamePreviewRow, RenameRule, RenameRuleType, RenameTransaction, RenamerItem } from '../../shared/renamer';

interface RenamerTabProps {
  importedRegex?: RegexRenamerExport | null;
}

const ruleTypeLabels: Record<RenameRuleType, string> = {
  'find-replace': 'Find / Replace',
  'prefix-suffix': 'Prefix / Suffix',
  case: 'Case',
  spaces: 'Spaces',
  trim: 'Trim',
  'clear-name': 'Clear Name',
  numbering: 'Numbering',
  extension: 'Extension',
};

const addableRuleTypes: RenameRuleType[] = [
  'find-replace',
  'prefix-suffix',
  'case',
  'spaces',
  'trim',
  'clear-name',
  'numbering',
  'extension',
];

const PREVIEW_ROW_PAGE_SIZE = 150;

export function RenamerTab({ importedRegex }: RenamerTabProps): ReactElement {
  const [items, setItems] = useState<RenamerItem[]>([]);
  const [excludedItemIds, setExcludedItemIds] = useState<Set<string>>(() => new Set());
  const [rules, setRules] = useState<RenameRule[]>([createRenameRule('find-replace')]);
  const [preview, setPreview] = useState<RenamePreview | null>(null);
  const [transactions, setTransactions] = useState<RenameTransaction[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [includeFolders, setIncludeFolders] = useState(false);
  const [newRuleType, setNewRuleType] = useState<RenameRuleType>('prefix-suffix');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [visibleRowCount, setVisibleRowCount] = useState(PREVIEW_ROW_PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lastImportedRegexId = useRef<string | null>(null);

  const undoableTransaction = useMemo(
    () => transactions.find((transaction) => !transaction.undoneAt) ?? null,
    [transactions],
  );
  const activeItems = useMemo(
    () => items.filter((item) => !excludedItemIds.has(item.id)),
    [excludedItemIds, items],
  );
  const previewRowsById = useMemo(
    () => new Map((preview?.rows ?? []).map((row) => [row.id, row])),
    [preview],
  );
  const visibleItems = useMemo(
    () => items.slice(0, visibleRowCount),
    [items, visibleRowCount],
  );
  const excludedCount = items.length - activeItems.length;

  const changedRows = preview?.counts.changed ?? 0;
  const errorRows = preview?.counts.errors ?? 0;

  useEffect(() => {
    void loadTransactions();
  }, []);

  useEffect(() => {
    if (!importedRegex || importedRegex.id === lastImportedRegexId.current) return;

    lastImportedRegexId.current = importedRegex.id;
    const importedRule: RenameRule = {
      id: newId(),
      type: 'find-replace',
      enabled: true,
      find: importedRegex.pattern,
      replace: importedRegex.replacement,
      useRegex: true,
      caseSensitive: !importedRegex.flags.includes('i'),
    };

    setRules((currentRules) => {
      const emptyRuleIndex = currentRules.findIndex(
        (rule) => rule.type === 'find-replace' && !rule.find && !rule.replace,
      );

      if (emptyRuleIndex === -1) {
        return [...currentRules, importedRule];
      }

      return currentRules.map((rule, index) => (index === emptyRuleIndex ? importedRule : rule));
    });
    setMessage('Regex imported from Regex Lab.');
  }, [importedRegex]);

  useEffect(() => {
    setVisibleRowCount(PREVIEW_ROW_PAGE_SIZE);
  }, [items.length]);

  useEffect(() => {
    if (activeItems.length === 0) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const nextPreview = await window.winUtils.renamer.preview({ items: activeItems, rules });
          if (!cancelled) {
            setPreview(nextPreview);
          }
        } catch (caughtError) {
          if (!cancelled) {
            setError(getErrorMessage(caughtError, 'Unable to build rename preview.'));
          }
        }
      })();
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [activeItems, rules]);

  const loadTransactions = async (): Promise<void> => {
    try {
      setTransactions(await window.winUtils.renamer.listTransactions());
    } catch {
      setTransactions([]);
    }
  };

  const addItems = (nextItems: RenamerItem[]): void => {
    setItems((currentItems) => mergeItems(currentItems, nextItems));
  };

  const handlePickFiles = async (): Promise<void> => {
    await runBusy(async () => {
      addItems(await window.winUtils.renamer.pickFiles());
    }, 'Unable to add files.');
  };

  const handlePickFolder = async (): Promise<void> => {
    await runBusy(async () => {
      addItems(await window.winUtils.renamer.pickFolder({ recursive, includeFolders }));
    }, 'Unable to add folder contents.');
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault();
    setDragging(false);

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.winUtils.renamer.getDroppedPath(file))
      .filter((filePath): filePath is string => Boolean(filePath));

    if (paths.length === 0) {
      setError('Dropped items did not expose file paths.');
      return;
    }

    await runBusy(async () => {
      addItems(await window.winUtils.renamer.loadPaths({ paths, recursive, includeFolders }));
    }, 'Unable to add dropped items.');
  };

  const handleApply = async (): Promise<void> => {
    if (activeItems.length === 0 || errorRows > 0 || changedRows === 0) return;

    await runBusy(async () => {
      const activeIds = new Set(activeItems.map((item) => item.id));
      const excludedItems = items.filter((item) => !activeIds.has(item.id));
      const result = await window.winUtils.renamer.apply({ items: activeItems, rules });
      setItems(mergeItems(excludedItems, result.items));
      setExcludedItemIds(new Set(excludedItems.map((item) => item.id)));
      setMessage(result.renamedCount === 1 ? 'Renamed 1 item.' : `Renamed ${result.renamedCount} items.`);
      await loadTransactions();
    }, 'Unable to apply rename batch.');
  };

  const handleUndo = async (): Promise<void> => {
    await runBusy(async () => {
      const result = await window.winUtils.renamer.undo(undoableTransaction?.id);
      const restoredTargets = new Set(result.transaction.operations.map((operation) => operation.toPath.toLowerCase()));
      setItems((currentItems) => mergeItems(
        currentItems.filter((item) => !restoredTargets.has(item.path.toLowerCase())),
        result.items,
      ));
      setMessage(result.restoredCount === 1 ? 'Restored 1 item.' : `Restored ${result.restoredCount} items.`);
      await loadTransactions();
    }, 'Unable to undo the last rename batch.');
  };

  const runBusy = async (action: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await action();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, fallback));
    } finally {
      setBusy(false);
    }
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>): void => {
    setRules((currentRules) => currentRules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } as RenameRule : rule)));
  };

  const replaceRuleType = (ruleId: string, type: RenameRuleType): void => {
    setRules((currentRules) => currentRules.map((rule) => (rule.id === ruleId ? createRenameRule(type, ruleId, rule.enabled) : rule)));
  };

  const moveRule = (ruleId: string, direction: -1 | 1): void => {
    setRules((currentRules) => {
      const index = currentRules.findIndex((rule) => rule.id === ruleId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= currentRules.length) return currentRules;

      const nextRules = [...currentRules];
      const [rule] = nextRules.splice(index, 1);
      nextRules.splice(nextIndex, 0, rule);
      return nextRules;
    });
  };

  const removeRule = (ruleId: string): void => {
    setRules((currentRules) => currentRules.length === 1 ? currentRules : currentRules.filter((rule) => rule.id !== ruleId));
  };

  const setItemIncluded = (itemId: string, included: boolean): void => {
    setExcludedItemIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (included) {
        nextIds.delete(itemId);
      } else {
        nextIds.add(itemId);
      }
      return nextIds;
    });
  };

  return (
    <div className="renamer-layout">
      <div className="renamer-toolbar">
        <div className="renamer-actions">
          <button className="toggle-button" type="button" onClick={() => void handlePickFiles()} disabled={busy}>Add Files</button>
          <button className="ghost-button" type="button" onClick={() => void handlePickFolder()} disabled={busy}>Add Folder</button>
          <button className="ghost-button" type="button" onClick={() => { setItems([]); setExcludedItemIds(new Set()); }} disabled={busy || items.length === 0}>Clear</button>
          <button className="ghost-button" type="button" onClick={() => setExcludedItemIds(new Set())} disabled={busy || excludedCount === 0}>Include All</button>
        </div>
        <div className="renamer-options">
          <label><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />Recursive</label>
          <label><input type="checkbox" checked={includeFolders} onChange={(event) => setIncludeFolders(event.target.checked)} />Folders</label>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {message ? <div className="success-banner">{message}</div> : null}

      <div className="renamer-workspace">
        <aside className="renamer-rules-panel">
          <div className="renamer-panel-header">
            <div>
              <p className="section-kicker">Rules</p>
              <h2>Rename Stack</h2>
            </div>
            <span className="renamer-count-pill">{rules.length}</span>
          </div>

          <div className="renamer-rule-list">
            {rules.map((rule, index) => (
              <div className={`renamer-rule ${rule.enabled ? '' : 'renamer-rule--disabled'}`} key={rule.id}>
                <div className="renamer-rule-topline">
                  <label className="renamer-rule-enabled">
                    <input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })} />
                    {index + 1}
                  </label>
                  <select className="macro-select" value={rule.type} onChange={(event) => replaceRuleType(rule.id, event.target.value as RenameRuleType)}>
                    {addableRuleTypes.map((type) => <option value={type} key={type}>{ruleTypeLabels[type]}</option>)}
                  </select>
                </div>
                <div className="renamer-rule-buttons">
                  <button className="micro-button" type="button" onClick={() => moveRule(rule.id, -1)} disabled={index === 0}>Up</button>
                  <button className="micro-button" type="button" onClick={() => moveRule(rule.id, 1)} disabled={index === rules.length - 1}>Down</button>
                  <button className="micro-button micro-button--danger" type="button" onClick={() => removeRule(rule.id)} disabled={rules.length === 1}>Remove</button>
                </div>
                {renderRuleControls(rule, updateRule)}
              </div>
            ))}
          </div>

          <div className="renamer-add-rule">
            <select className="macro-select" value={newRuleType} onChange={(event) => setNewRuleType(event.target.value as RenameRuleType)}>
              {addableRuleTypes.map((type) => <option value={type} key={type}>{ruleTypeLabels[type]}</option>)}
            </select>
            <button className="ghost-button" type="button" onClick={() => setRules((currentRules) => [...currentRules, createRenameRule(newRuleType)])}>Add Rule</button>
          </div>
        </aside>

        <section className="renamer-preview-panel">
          <div
            className={`renamer-drop-zone ${dragging ? 'renamer-drop-zone--active' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => void handleDrop(event)}
          >
            <div>
              <strong>{items.length === 0 ? 'Drop files or folders' : `${items.length} selected item${items.length === 1 ? '' : 's'}`}</strong>
              <p>{preview ? buildPreviewSummary(preview, excludedCount) : activeItems.length === 0 && items.length > 0 ? `${excludedCount} item${excludedCount === 1 ? '' : 's'} excluded.` : 'Preview is generated before anything changes.'}</p>
            </div>
            <div className="renamer-batch-actions">
              <button className="toggle-button" type="button" onClick={() => void handleApply()} disabled={busy || activeItems.length === 0 || changedRows === 0 || errorRows > 0}>{busy ? 'Working...' : 'Apply Rename'}</button>
              <button className="ghost-button" type="button" onClick={() => void handleUndo()} disabled={busy || !undoableTransaction}>Undo Last</button>
            </div>
          </div>

          <div className="renamer-stat-grid">
            <StatPill label="Queued" value={items.length} />
            <StatPill label="Included" value={activeItems.length} />
            <StatPill label="Excluded" value={excludedCount} />
            <StatPill label="Changing" value={preview?.counts.changed ?? 0} />
            <StatPill label="Warnings" value={preview?.counts.warnings ?? 0} tone="warning" />
            <StatPill label="Errors" value={preview?.counts.errors ?? 0} tone="danger" />
          </div>

          <div className="renamer-table-wrap">
            <div className="renamer-table-head renamer-table-row">
              <span>Include</span>
              <span>Original</span>
              <span>Preview</span>
              <span>Folder</span>
              <span>Status</span>
              <span>Notes</span>
            </div>
            {items.length ? visibleItems.map((item) => (
              <PreviewRow
                included={!excludedItemIds.has(item.id)}
                item={item}
                key={item.id}
                onToggle={(included) => setItemIncluded(item.id, included)}
                row={previewRowsById.get(item.id)}
              />
            )) : null}
            {items.length > visibleItems.length ? (
              <div className="renamer-table-footer">
                <span>Showing {visibleItems.length} of {items.length}</span>
                <button
                  className="ghost-button ghost-button--sm"
                  type="button"
                  onClick={() => setVisibleRowCount((currentCount) => Math.min(items.length, currentCount + PREVIEW_ROW_PAGE_SIZE))}
                >
                  Show More
                </button>
              </div>
            ) : null}
            {items.length === 0 ? <div className="empty-state">No files or folders are queued.</div> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function renderRuleControls(rule: RenameRule, updateRule: (ruleId: string, patch: Record<string, unknown>) => void): ReactElement {
  switch (rule.type) {
    case 'find-replace':
      return (
        <div className="renamer-rule-grid renamer-rule-grid--two">
          <input className="macro-input" value={rule.find} placeholder="Find" onChange={(event) => updateRule(rule.id, { find: event.target.value })} />
          <input className="macro-input" value={rule.replace} placeholder="Replace" onChange={(event) => updateRule(rule.id, { replace: event.target.value })} />
          <label><input type="checkbox" checked={rule.useRegex} onChange={(event) => updateRule(rule.id, { useRegex: event.target.checked })} />Regex</label>
          <label><input type="checkbox" checked={rule.caseSensitive} onChange={(event) => updateRule(rule.id, { caseSensitive: event.target.checked })} />Match case</label>
        </div>
      );
    case 'prefix-suffix':
      return (
        <div className="renamer-rule-grid renamer-rule-grid--two">
          <input className="macro-input" value={rule.prefix} placeholder="Prefix" onChange={(event) => updateRule(rule.id, { prefix: event.target.value })} />
          <input className="macro-input" value={rule.suffix} placeholder="Suffix" onChange={(event) => updateRule(rule.id, { suffix: event.target.value })} />
        </div>
      );
    case 'case':
      return (
        <select className="macro-select" value={rule.mode} onChange={(event) => updateRule(rule.id, { mode: event.target.value })}>
          <option value="lower">lowercase</option>
          <option value="upper">UPPERCASE</option>
          <option value="title">Title Case</option>
        </select>
      );
    case 'spaces':
      return (
        <select className="macro-select" value={rule.mode} onChange={(event) => updateRule(rule.id, { mode: event.target.value })}>
          <option value="underscore">spaces_to_underscores</option>
          <option value="hyphen">spaces-to-hyphens</option>
          <option value="remove">removespaces</option>
          <option value="collapse">collapse spaces</option>
        </select>
      );
    case 'trim':
      return (
        <div className="renamer-rule-grid renamer-rule-grid--two">
          <NumberInput label="Start" value={rule.start} onChange={(value) => updateRule(rule.id, { start: value })} />
          <NumberInput label="End" value={rule.end} onChange={(value) => updateRule(rule.id, { end: value })} />
        </div>
      );
    case 'clear-name':
      return <div className="renamer-rule-note">Stem cleared</div>;
    case 'numbering':
      return (
        <div className="renamer-rule-grid renamer-rule-grid--numbering">
          <NumberInput label="Start" value={rule.start} onChange={(value) => updateRule(rule.id, { start: value })} />
          <NumberInput label="Step" value={rule.increment} onChange={(value) => updateRule(rule.id, { increment: value })} />
          <NumberInput label="Pad" value={rule.padding} onChange={(value) => updateRule(rule.id, { padding: value })} />
          <label className="renamer-number-input">
            <span>Separator</span>
            <input className="macro-input" value={rule.separator} placeholder="_" onChange={(event) => updateRule(rule.id, { separator: event.target.value })} />
          </label>
          <label className="renamer-number-input">
            <span>Position</span>
            <select className="macro-select" value={rule.position} onChange={(event) => updateRule(rule.id, { position: event.target.value })}>
              <option value="suffix">Suffix</option>
              <option value="prefix">Prefix</option>
            </select>
          </label>
        </div>
      );
    case 'extension':
      return <input className="macro-input" value={rule.extension} placeholder="Extension" onChange={(event) => updateRule(rule.id, { extension: event.target.value })} />;
  }
}

function PreviewRow({ included, item, onToggle, row }: { included: boolean; item: RenamerItem; onToggle: (included: boolean) => void; row?: RenamePreviewRow }): ReactElement {
  const status = included ? row?.status ?? 'unchanged' : 'excluded';

  return (
    <div className={`renamer-table-row renamer-preview-row renamer-preview-row--${status}`}>
      <label className="renamer-include-toggle">
        <input type="checkbox" checked={included} onChange={(event) => onToggle(event.target.checked)} />
        {included ? 'Yes' : 'No'}
      </label>
      <code>{item.name}</code>
      <code>{included ? row?.targetName ?? item.name : item.name}</code>
      <span title={item.directory}>{item.directory}</span>
      <span className={`status-pill renamer-status--${status}`}>{status}</span>
      <div className="renamer-issues">
        {!included ? <span className="inline-note">Skipped</span> : !row ? <span className="inline-note">Waiting for preview</span> : row.issues.length === 0 ? <span className="inline-note">Ready</span> : row.issues.map((issue) => (
          <span className={`renamer-issue renamer-issue--${issue.severity}`} key={`${issue.severity}-${issue.message}`}>
            {issue.message}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatPill({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'warning' | 'danger' }): ReactElement {
  return (
    <div className={`renamer-stat renamer-stat--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): ReactElement {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0);
  };

  return (
    <label className="renamer-number-input">
      <span>{label}</span>
      <input className="macro-input" type="number" value={value} onChange={handleChange} />
    </label>
  );
}

function createRenameRule(type: RenameRuleType, id = newId(), enabled = true): RenameRule {
  switch (type) {
    case 'find-replace':
      return { id, type, enabled, find: '', replace: '', useRegex: false, caseSensitive: false };
    case 'prefix-suffix':
      return { id, type, enabled, prefix: '', suffix: '' };
    case 'case':
      return { id, type, enabled, mode: 'lower' };
    case 'spaces':
      return { id, type, enabled, mode: 'underscore' };
    case 'trim':
      return { id, type, enabled, start: 0, end: 0 };
    case 'clear-name':
      return { id, type, enabled };
    case 'numbering':
      return { id, type, enabled, start: 1, increment: 1, padding: 3, position: 'suffix', separator: '_' };
    case 'extension':
      return { id, type, enabled, extension: '' };
  }
}

function mergeItems(currentItems: RenamerItem[], nextItems: RenamerItem[]): RenamerItem[] {
  const byPath = new Map<string, RenamerItem>();

  for (const item of [...currentItems, ...nextItems]) {
    byPath.set(item.path.toLowerCase(), item);
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
}

function buildPreviewSummary(preview: RenamePreview, excludedCount: number): string {
  const excludedText = excludedCount > 0 ? ` ${excludedCount} excluded.` : '';

  if (preview.counts.errors > 0) return `${preview.counts.errors} error${preview.counts.errors === 1 ? '' : 's'} need attention.${excludedText}`;
  if (preview.counts.warnings > 0) return `${preview.counts.changed} changes with ${preview.counts.warnings} warning${preview.counts.warnings === 1 ? '' : 's'}.${excludedText}`;
  if (preview.counts.changed === 0) return `No filenames will change.${excludedText}`;
  return `${preview.counts.changed} item${preview.counts.changed === 1 ? '' : 's'} ready to rename.${excludedText}`;
}

function getErrorMessage(caughtError: unknown, fallback: string): string {
  if (caughtError instanceof Error) return caughtError.message || fallback;
  return typeof caughtError === 'string' && caughtError.trim() ? caughtError : fallback;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}