import { useState } from 'react';
import type { TimelineAction } from '../../shared/macro';
import { recordedKeyLabel } from '../../shared/macroRecording';
export function MacroTimelineEditor({ action, onChange }: { action: TimelineAction; onChange: (action: TimelineAction) => void }) {
  const [page, setPage] = useState(0);
  const timeline = action.timeline, size = 40;
  const start = Math.min(page * size, Math.max(0, Math.floor((timeline.events.length - 1) / size) * size));
  return <div className="action-nested-editor">
    <div className="action-fields"><label className="macro-label">Speed</label>
      <input aria-label="Playback speed multiplier" className="macro-input macro-input--short" type="number" min={0.1} max={10} step={0.1} value={timeline.speed} onChange={e => {
        const speed = Number(e.target.value); if (speed >= 0.1 && speed <= 10) onChange({ ...action, timeline: { ...timeline, speed } });
      }} />
      <select aria-label="Recording timing policy" title="Preserve timing keeps holds and spacing when Windows runs late. Fixed schedule keeps original deadlines and may compress overdue intervals." className="macro-input" value={timeline.timing} onChange={e => onChange({ ...action, timeline: { ...timeline, timing: e.target.value as typeof timeline.timing } })}>
        <option value="preserve-timing">Preserve timing</option><option value="preserve-schedule">Fixed schedule</option>
      </select><span className="inline-note">{timeline.events.length} events · {((timeline.events.at(-1)?.timeUs ?? 0) / 1000).toFixed(2)} ms</span>
    </div>
    <details><summary className="inline-note">Recorded events</summary>
      {timeline.events.slice(start, start + size).map((event, offset) => {
        const index = start + offset;
        const label = event.kind === 'key' ? `${recordedKeyLabel(event.key)}${event.up ? ' up' : ' down'}` : event.kind === 'button' ? `${['Left', 'Right', 'Middle', 'X1', 'X2'][event.button]}${event.up ? ' up' : ' down'}` : event.kind === 'move' ? `Move ${event.x}, ${event.y}` : `Wheel ${event.delta}`;
        return <div className="action-fields" key={index}><span className="inline-note">{index + 1}. {label}</span>
          <input aria-label={`Event ${index + 1} time in milliseconds`} type="number" className="macro-input macro-input--short" value={event.timeUs / 1000} step={0.001}
            min={(timeline.events[index - 1]?.timeUs ?? 0) / 1000} max={(timeline.events[index + 1]?.timeUs ?? 600000000) / 1000} onChange={e => {
              const timeUs = Math.round(Number(e.target.value) * 1000);
              if (!Number.isFinite(timeUs) || timeUs < (timeline.events[index - 1]?.timeUs ?? 0) || timeUs > (timeline.events[index + 1]?.timeUs ?? 600000000)) return;
              onChange({ ...action, timeline: { ...timeline, events: timeline.events.map((old, i) => i === index ? { ...old, timeUs } : old) } });
            }} /><span className="inline-note">ms</span></div>;
      })}
      <div className="action-fields"><button className="ghost-button ghost-button--xs" disabled={start === 0} onClick={() => setPage(Math.max(0, page - 1))}>Previous</button>
        <span className="inline-note">{start + 1}–{Math.min(start + size, timeline.events.length)} of {timeline.events.length}</span>
        <button className="ghost-button ghost-button--xs" disabled={start + size >= timeline.events.length} onClick={() => setPage(page + 1)}>Next</button></div>
      <p className="inline-note">Times are relative to the first event. Input pairs and scan codes are preserved.</p>
    </details>
  </div>;
}
