import { evaluateRegex } from '../../shared/regexEvaluation';
import type { RegexTestInput } from '../../shared/regexLab';

self.onmessage = (event: MessageEvent<RegexTestInput>): void => {
  self.postMessage(evaluateRegex(event.data));
};
