import { useEffect, useRef, useState, type ReactElement } from 'react';

export function ClipboardExclusions({ apps, disabled, onSave }: { apps: string[]; disabled: boolean; onSave: (apps: string[]) => Promise<void> }): ReactElement {
  const [draft, setDraft] = useState(apps.join(', '));
  const dirty = useRef(false);
  const saved = apps.join(',');
  useEffect(() => { if (!dirty.current) setDraft(apps.join(', ')); }, [saved]);
  return <div className="clipboard-settings-strip">
    <label style={{ flex: '1 1 320px' }}>Skip these apps
      <input className="macro-input" aria-label="Excluded clipboard source apps" placeholder="passwordmanager.exe, privateapp.exe" value={draft} disabled={disabled}
        onChange={event => { dirty.current = true; setDraft(event.target.value); }} />
    </label>
    <button className="micro-button" disabled={disabled} onClick={() => void onSave(draft.split(',').map(name => name.trim()).filter(Boolean))}>Save exclusions</button>
    <small>Enter app filenames, separated by commas. Unknown sources are also skipped.</small>
  </div>;
}
