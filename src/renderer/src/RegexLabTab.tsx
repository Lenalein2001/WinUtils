import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { RegexRenamerExport } from '../../shared/regexLab';

interface RegexLabTabProps {
  onExportToRenamer: (payload: RegexRenamerExport) => void;
}

interface SegmentOption {
  id: string;
  label: string;
  pattern: string;
  tone: string;
  captureDefault: boolean;
  recommended?: boolean;
}

interface RegexSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  kind: 'number' | 'word' | 'space' | 'symbol';
  options: SegmentOption[];
}

interface RegexMatchResult {
  error: string | null;
  matches: Array<{
    value: string;
    index: number;
    groups: string[];
  }>;
}

const DEFAULT_SAMPLE = '';

export function RegexLabTab({ onExportToRenamer }: RegexLabTabProps): ReactElement {
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE);
  const [flags, setFlags] = useState('gi');
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [includedSegments, setIncludedSegments] = useState<Record<string, boolean>>({});
  const [capturedSegments, setCapturedSegments] = useState<Record<string, boolean>>({});
  const [patternDraft, setPatternDraft] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replacementTouched, setReplacementTouched] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const segments = useMemo(() => buildSegments(sampleText), [sampleText]);
  const matchResult = useMemo(
    () => testPattern(patternDraft, flags, sampleText),
    [flags, patternDraft, sampleText],
  );

  useEffect(() => {
    const nextSelectedOptions: Record<string, string> = {};

    for (const segment of segments) {
      const defaultOption = segment.options.find((option) => option.recommended) ?? segment.options[0];
      nextSelectedOptions[segment.id] = defaultOption.id;
    }

    setSelectedOptions(nextSelectedOptions);
    setIncludedSegments({});
    setCapturedSegments({});
  }, [segments]);

  const setFlag = (flag: string, enabled: boolean): void => {
    setFlags((currentFlags) => {
      const nextFlags = new Set(currentFlags.split(''));
      if (enabled) {
        nextFlags.add(flag);
      } else {
        nextFlags.delete(flag);
      }
      return ['g', 'i', 'm'].filter((candidate) => nextFlags.has(candidate)).join('');
    });
  };

  const applySelectedPattern = (
    nextSelectedOptions: Record<string, string>,
    nextIncludedSegments: Record<string, boolean>,
    nextCapturedSegments: Record<string, boolean>,
  ): void => {
    setPatternDraft(buildSelectedPattern(segments, nextSelectedOptions, nextIncludedSegments, nextCapturedSegments));
    if (!replacementTouched) {
      setReplacement(buildSuggestedReplacement(segments, nextSelectedOptions, nextIncludedSegments, nextCapturedSegments));
    }
    setExportMessage(null);
  };

  const useAllSegments = (): void => {
    const nextIncludedSegments: Record<string, boolean> = {};
    const nextCapturedSegments = { ...capturedSegments };

    for (const segment of segments) {
      nextIncludedSegments[segment.id] = true;
      if (!hasSegmentValue(nextCapturedSegments, segment.id)) {
        nextCapturedSegments[segment.id] = getSelectedOption(segment, selectedOptions).captureDefault;
      }
    }

    setIncludedSegments(nextIncludedSegments);
    setCapturedSegments(nextCapturedSegments);
    applySelectedPattern(selectedOptions, nextIncludedSegments, nextCapturedSegments);
  };

  const clearSelectedSegments = (): void => {
    setIncludedSegments({});
    setCapturedSegments({});
    setPatternDraft('');
    setReplacement('');
    setReplacementTouched(false);
    setExportMessage(null);
  };

  const chooseOption = (segment: RegexSegment, option: SegmentOption): void => {
    const activeOption = getSelectedOption(segment, selectedOptions);
    const shouldRemoveFilter = includedSegments[segment.id] && activeOption.id === option.id;
    const nextSelectedOptions = { ...selectedOptions, [segment.id]: option.id };
    const nextIncludedSegments = { ...includedSegments, [segment.id]: !shouldRemoveFilter };
    const nextCapturedSegments = { ...capturedSegments };

    if (shouldRemoveFilter) {
      delete nextCapturedSegments[segment.id];
    } else {
      nextCapturedSegments[segment.id] = option.captureDefault;
    }

    setSelectedOptions(nextSelectedOptions);
    setIncludedSegments(nextIncludedSegments);
    setCapturedSegments(nextCapturedSegments);
    applySelectedPattern(nextSelectedOptions, nextIncludedSegments, nextCapturedSegments);
  };

  const toggleSegmentIncluded = (segment: RegexSegment, included: boolean): void => {
    const nextIncludedSegments = { ...includedSegments, [segment.id]: included };
    const nextCapturedSegments = { ...capturedSegments };

    if (!included) {
      delete nextCapturedSegments[segment.id];
    } else if (!hasSegmentValue(nextCapturedSegments, segment.id)) {
      nextCapturedSegments[segment.id] = getSelectedOption(segment, selectedOptions).captureDefault;
    }

    setIncludedSegments(nextIncludedSegments);
    setCapturedSegments(nextCapturedSegments);
    applySelectedPattern(selectedOptions, nextIncludedSegments, nextCapturedSegments);
  };

  const toggleSegmentCaptured = (segment: RegexSegment, captured: boolean): void => {
    const nextIncludedSegments = { ...includedSegments, [segment.id]: true };
    const nextCapturedSegments = { ...capturedSegments, [segment.id]: captured };
    setIncludedSegments(nextIncludedSegments);
    setCapturedSegments(nextCapturedSegments);
    applySelectedPattern(selectedOptions, nextIncludedSegments, nextCapturedSegments);
  };

  const handleExport = (): void => {
    if (!patternDraft.trim() || matchResult.error) return;

    onExportToRenamer({
      id: newId(),
      pattern: patternDraft,
      flags,
      replacement,
      sampleText,
      createdAt: new Date().toISOString(),
    });
    setExportMessage('Sent to Batch Renamer.');
  };

  return (
    <div className="regex-lab-layout">
      <div className="regex-lab-topbar">
        <div className="regex-lab-field regex-lab-field--sample">
          <span>Sample Text</span>
          <input className="macro-input" value={sampleText} onChange={(event) => { setSampleText(event.target.value); setExportMessage(null); }} />
        </div>
        <div className="regex-flag-row">
          {['g', 'i', 'm'].map((flag) => (
            <label key={flag}>
              <input type="checkbox" checked={flags.includes(flag)} onChange={(event) => setFlag(flag, event.target.checked)} />
              {flag}
            </label>
          ))}
        </div>
      </div>

      <div className="regex-lab-grid">
        <section className="regex-card regex-card--builder">
          <div className="regex-card-header">
            <div>
              <p className="section-kicker">Builder</p>
              <h2>Token Map</h2>
            </div>
          </div>

          <div className="regex-token-strip">
            {segments.map((segment) => {
              const option = getSelectedOption(segment, selectedOptions);
              const included = Boolean(includedSegments[segment.id]);
              return (
                <button
                  aria-pressed={included}
                  className={`regex-token regex-token--${option.tone} ${included ? 'regex-token--selected' : ''} ${included && getSegmentCapture(segment, selectedOptions, capturedSegments) ? 'regex-token--captured' : ''}`}
                  key={segment.id}
                  type="button"
                  onClick={() => toggleSegmentIncluded(segment, !included)}
                  title={included ? `Remove ${option.label}` : `Use ${option.label}`}
                >
                  {segment.text || ' '}
                </button>
              );
            })}
          </div>

          <div className="regex-segment-list">
            {segments.map((segment) => {
              const option = getSelectedOption(segment, selectedOptions);
              const included = Boolean(includedSegments[segment.id]);
              const captured = included && getSegmentCapture(segment, selectedOptions, capturedSegments);
              return (
                <div className={`regex-segment-row ${included ? 'regex-segment-row--selected' : ''}`} key={segment.id}>
                  <span className={`regex-segment-sample regex-token--${option.tone}`}>{segment.text || ' '}</span>
                  <div className="regex-option-pills">
                    {segment.options.map((candidate) => (
                      <button
                        aria-pressed={included && candidate.id === option.id}
                        className={`micro-button ${included && candidate.id === option.id ? 'regex-option-pill--active' : ''}`}
                        key={candidate.id}
                        type="button"
                        onClick={() => chooseOption(segment, candidate)}
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                  <div className="regex-segment-controls">
                    <label className="regex-capture-toggle">
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={(event) => toggleSegmentIncluded(segment, event.target.checked)}
                      />
                      Use
                    </label>
                    <label className="regex-capture-toggle" title="Creates a capture group for replacement references such as $1.">
                      <input
                        type="checkbox"
                        checked={captured}
                        disabled={!included}
                        onChange={(event) => toggleSegmentCaptured(segment, event.target.checked)}
                      />
                      Capture
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="regex-card regex-card--output">
          <div className="regex-card-header">
            <div>
              <p className="section-kicker">Pattern</p>
              <h2>Regex Output</h2>
            </div>
            <div className="regex-card-actions">
              <button className="ghost-button ghost-button--sm" type="button" onClick={useAllSegments}>
                Use All
              </button>
              <button className="ghost-button ghost-button--sm" type="button" onClick={clearSelectedSegments}>
                Clear
              </button>
            </div>
          </div>

          <textarea
            className="macro-textarea regex-pattern-box"
            value={patternDraft}
            onChange={(event) => { setPatternDraft(event.target.value); setExportMessage(null); }}
            spellCheck={false}
          />

          <div className="regex-lab-field">
            <span>Replacement</span>
            <input
              className="macro-input"
              value={replacement}
              onChange={(event) => { setReplacement(event.target.value); setReplacementTouched(true); setExportMessage(null); }}
              spellCheck={false}
            />
          </div>

          <div className="regex-actions-row">
            <button className="toggle-button" type="button" onClick={handleExport} disabled={!patternDraft.trim() || Boolean(matchResult.error)}>
              Send to Renamer
            </button>
            {exportMessage ? <span className="regex-export-message">{exportMessage}</span> : null}
          </div>

          <div className="regex-match-panel">
            <div className="regex-card-header regex-card-header--compact">
              <p className="section-kicker">Matches</p>
              <span className={`status-pill ${matchResult.error ? 'renamer-status--error' : 'renamer-status--ready'}`}>
                {matchResult.error ? 'Invalid' : matchResult.matches.length}
              </span>
            </div>

            {matchResult.error ? <div className="error-banner">{matchResult.error}</div> : null}
            {!matchResult.error && matchResult.matches.length === 0 ? <div className="empty-state">No matches.</div> : null}
            {!matchResult.error && matchResult.matches.length > 0 ? (
              <div className="regex-match-list">
                {matchResult.matches.map((match) => (
                  <div className="regex-match-row" key={`${match.index}-${match.value}`}>
                    <code>{match.value}</code>
                    <span>Index {match.index}</span>
                    {match.groups.length ? <small>{match.groups.map((group, index) => `$${index + 1}: ${group}`).join('  ')}</small> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function buildSegments(sampleText: string): RegexSegment[] {
  const matches = [...sampleText.matchAll(/\d+|[A-Za-z]+|\s+|[^\dA-Za-z\s]+/g)];
  const numberMatches = matches.filter((match) => /^\d+$/.test(match[0]));
  const dateLike = numberMatches.length >= 6 && numberMatches[0][0].length === 4;
  let numberIndex = 0;

  return matches.map((match, index) => {
    const text = match[0];
    const start = match.index ?? index;
    const kind = getSegmentKind(text);
    const currentNumberIndex = kind === 'number' ? numberIndex : -1;
    if (kind === 'number') numberIndex += 1;

    return {
      id: `${start}-${start + text.length}-${text}`,
      text,
      start,
      end: start + text.length,
      kind,
      options: createOptions(text, kind, dateLike ? currentNumberIndex : -1),
    };
  });
}

function createOptions(text: string, kind: RegexSegment['kind'], numberIndex: number): SegmentOption[] {
  const exact = { id: 'exact', label: `Exact (${text})`, pattern: escapeRegex(text), tone: 'exact', captureDefault: false, recommended: kind !== 'number' };

  if (kind === 'number') {
    const semantic = getSemanticNumberOption(numberIndex);
    return [
      ...(semantic ? [semantic] : []),
      { id: 'number-fixed', label: `Number (${text.length})`, pattern: `\\d{${text.length}}`, tone: 'number', captureDefault: true, recommended: !semantic },
      { id: 'number-any', label: 'Number', pattern: '\\d+', tone: 'number', captureDefault: true },
      exact,
    ];
  }

  if (kind === 'word') {
    return [
      { id: 'word', label: 'Letters', pattern: '[A-Za-z]+', tone: 'word', captureDefault: true },
      { id: 'alnum', label: 'Alphanumeric', pattern: '[A-Za-z0-9]+', tone: 'word', captureDefault: true },
      exact,
    ];
  }

  if (kind === 'space') {
    return [
      { id: 'space', label: 'Whitespace', pattern: '\\s+', tone: 'symbol', captureDefault: false, recommended: true },
      exact,
    ];
  }

  return [
    exact,
    { id: 'symbol', label: 'Symbol', pattern: '[^\\w\\s]+', tone: 'symbol', captureDefault: false },
  ];
}

function getSemanticNumberOption(numberIndex: number): SegmentOption | null {
  const semanticOptions: SegmentOption[] = [
    { id: 'year', label: 'Year', pattern: '\\d{4}', tone: 'date', captureDefault: true, recommended: true },
    { id: 'month', label: 'Month', pattern: '(?:0[1-9]|1[0-2])', tone: 'date', captureDefault: true, recommended: true },
    { id: 'day', label: 'Day', pattern: '(?:0[1-9]|[12]\\d|3[01])', tone: 'date', captureDefault: true, recommended: true },
    { id: 'hour', label: 'Hour', pattern: '(?:[01]\\d|2[0-3])', tone: 'time', captureDefault: true, recommended: true },
    { id: 'minute', label: 'Minute', pattern: '[0-5]\\d', tone: 'time', captureDefault: true, recommended: true },
    { id: 'second', label: 'Second', pattern: '[0-5]\\d', tone: 'time', captureDefault: true, recommended: true },
  ];

  return semanticOptions[numberIndex] ?? null;
}

function getSegmentKind(text: string): RegexSegment['kind'] {
  if (/^\d+$/.test(text)) return 'number';
  if (/^[A-Za-z]+$/.test(text)) return 'word';
  if (/^\s+$/.test(text)) return 'space';
  return 'symbol';
}

function buildSelectedPattern(
  segments: RegexSegment[],
  selectedOptions: Record<string, string>,
  includedSegments: Record<string, boolean>,
  capturedSegments: Record<string, boolean>,
): string {
  let previousEnd: number | null = null;
  const patternParts: string[] = [];

  for (const segment of segments) {
    if (!includedSegments[segment.id]) continue;

    if (previousEnd !== null && segment.start > previousEnd) {
      patternParts.push('.*?');
    }

    patternParts.push(buildSegmentPattern(segment, selectedOptions, capturedSegments));
    previousEnd = segment.end;
  }

  return patternParts.join('');
}

function buildSegmentPattern(
  segment: RegexSegment,
  selectedOptions: Record<string, string>,
  capturedSegments: Record<string, boolean>,
): string {
  const option = getSelectedOption(segment, selectedOptions);
  return getSegmentCapture(segment, selectedOptions, capturedSegments) ? `(${option.pattern})` : option.pattern;
}

function buildSuggestedReplacement(
  segments: RegexSegment[],
  selectedOptions: Record<string, string>,
  includedSegments: Record<string, boolean>,
  capturedSegments: Record<string, boolean>,
): string {
  const captureCount = segments.filter(
    (segment) => includedSegments[segment.id] && getSegmentCapture(segment, selectedOptions, capturedSegments),
  ).length;
  return Array.from({ length: captureCount }, (_item, index) => `$${index + 1}`).join('_');
}

function getSelectedOption(segment: RegexSegment, selectedOptions: Record<string, string>): SegmentOption {
  return segment.options.find((option) => option.id === selectedOptions[segment.id])
    ?? segment.options.find((option) => option.recommended)
    ?? segment.options[0];
}

function getSegmentCapture(
  segment: RegexSegment,
  selectedOptions: Record<string, string>,
  capturedSegments: Record<string, boolean>,
): boolean {
  if (hasSegmentValue(capturedSegments, segment.id)) {
    return capturedSegments[segment.id];
  }

  return getSelectedOption(segment, selectedOptions).captureDefault;
}

function hasSegmentValue(values: Record<string, boolean>, segmentId: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, segmentId);
}

function testPattern(pattern: string, flags: string, sampleText: string): RegexMatchResult {
  if (!pattern) return { error: null, matches: [] };

  try {
    const testFlags = flags.includes('g') ? flags : `${flags}g`;
    const regex = new RegExp(pattern, testFlags);
    const matches: RegexMatchResult['matches'] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(sampleText)) !== null) {
      matches.push({
        value: match[0],
        index: match.index,
        groups: match.slice(1),
      });

      if (match[0] === '') {
        regex.lastIndex += 1;
      }
    }

    return { error: null, matches };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid regular expression.', matches: [] };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}