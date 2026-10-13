import type { MacroTimeline } from '../shared/macroRecording';

export function validateTimeline(value: unknown): asserts value is MacroTimeline {
  if (!value || typeof value !== 'object') throw new Error('Invalid recording timeline.');
  const timeline = value as MacroTimeline;
  if (timeline.version !== 1 || !Array.isArray(timeline.events) || timeline.events.length > 10000
    || !Number.isFinite(timeline.speed) || timeline.speed < 0.1 || timeline.speed > 10
    || !['preserve-timing', 'preserve-schedule'].includes(timeline.timing)) throw new Error('Invalid recording timeline options.');
  const metadata = timeline.metadata;
  if (!metadata || metadata.backend !== 'windows-hooks' || !Number.isSafeInteger(metadata.frequency) || metadata.frequency <= 0
    || typeof metadata.layout !== 'string' || metadata.layout.length > 64
    || (metadata.displays !== undefined && (typeof metadata.displays !== 'string' || metadata.displays.length > 2048))
    || ![metadata.dropped, metadata.repaired, metadata.excluded].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid recording metadata.');
  let previous = 0;
  const keys = new Set<string>(), buttons = new Set<number>();
  const integer = (n: number, min: number, max: number): boolean => Number.isSafeInteger(n) && n >= min && n <= max;
  for (const event of timeline.events) {
    if (!event || !integer(event.timeUs, previous, 600000000)) throw new Error('Invalid recording event order or duration.');
    previous = event.timeUs;
    switch (event.kind) {
      case 'key': {
        if (!integer(event.key, 1, 254) || !integer(event.scan, 0, 65535) || typeof event.up !== 'boolean' || typeof event.extended !== 'boolean') throw new Error('Invalid recorded key.');
        const id = `${event.key}:${event.scan}:${event.extended}`;
        if (event.up) { if (!keys.delete(id)) throw new Error('Unmatched recorded key release.'); }
        else keys.add(id);
        break;
      }
      case 'button':
        if (!integer(event.button, 0, 4) || typeof event.up !== 'boolean') throw new Error('Invalid recorded button.');
        if (event.up) { if (!buttons.delete(event.button)) throw new Error('Unmatched recorded button release.'); }
        else buttons.add(event.button);
        break;
      case 'move': if (!integer(event.x, -1000000, 1000000) || !integer(event.y, -1000000, 1000000)) throw new Error('Invalid recorded position.'); break;
      case 'wheel': if (!integer(event.delta, -32768, 32767) || typeof event.horizontal !== 'boolean') throw new Error('Invalid recorded wheel.'); break;
      default: throw new Error('Unknown recording event.');
    }
  }
  if (keys.size || buttons.size) throw new Error('Recording has unreleased input.');
}
