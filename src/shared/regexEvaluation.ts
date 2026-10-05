import type { RegexMatchResult, RegexTestInput } from './regexLab';

/** Must run in a terminable worker: JavaScript regex execution has no timeout. */
export function evaluateRegex(input: RegexTestInput): RegexMatchResult {
  if (typeof input.pattern !== 'string' || typeof input.flags !== 'string' || typeof input.sampleText !== 'string') {
    return { error: 'Invalid regex preview request.', matches: [] };
  }
  if (input.pattern.length > 4096 || input.sampleText.length > 50_000) {
    return { error: 'Preview is limited to 4,096 pattern characters and 50,000 input characters.', matches: [] };
  }
  if (!input.pattern) return { error: null, matches: [] };
  const matches: RegexMatchResult['matches'] = [];
  try {
    const regex = new RegExp(input.pattern, input.flags.includes('g') ? input.flags : `${input.flags}g`);
    let match: RegExpExecArray | null;
    let outputSize = 0;
    while ((match = regex.exec(input.sampleText)) !== null) {
      const groups = match.slice(1).map(value => value ?? '');
      outputSize += match[0].length + groups.reduce((sum, value) => sum + value.length, 0);
      if (matches.length >= 200 || outputSize > 256_000 || groups.length > 100) {
        return { error: 'Preview exceeded its match/output limit; narrow the pattern or input.', matches };
      }
      matches.push({ value: match[0], index: match.index, groups });
      if (match[0] === '') {
        // Advancing into a surrogate pair can make a Unicode regex repeat the
        // same empty match forever. Advance by a complete code point instead.
        regex.lastIndex += regex.unicode && (input.sampleText.codePointAt(regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      }
    }
    return { error: null, matches };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid regular expression.', matches: [] };
  }
}
