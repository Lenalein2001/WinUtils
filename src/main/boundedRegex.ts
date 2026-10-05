import { Worker } from 'node:worker_threads';
import type { RenameIssue, RenameRule, RenamerItem } from '../shared/renamer';
import { applyCase, applyRules, applySpaces, escapeRegExp } from './renameRules';

type RuleResult = { name: string; issues: RenameIssue[] };
const source = `
  const { parentPort, workerData } = require('node:worker_threads');
  ${applyRules.toString()}
  ${applyCase.toString()}
  ${applySpaces.toString()}
  ${escapeRegExp.toString()}
  try {
    parentPort.postMessage({ results: workerData.items.map((item, index) => applyRules(item, workerData.rules, index)) });
  } catch (error) { parentPort.postMessage({ error: String(error.message || error) }); }
`;
let activeWorkers = 0;

export async function testBoundedRegex(pattern: string, input: string, caseSensitive: boolean): Promise<boolean> {
  if (pattern.length > 4096 || input.length > 50_000) throw new Error('Macro regex condition exceeds its preview limits.');
  if (activeWorkers >= 2) throw new Error('Regex workers are busy.');
  activeWorkers++;
  let worker: Worker;
  try {
    worker = new Worker(`const {parentPort, workerData} = require('node:worker_threads');
      try { parentPort.postMessage({ value: new RegExp(workerData.pattern, workerData.caseSensitive ? '' : 'i').test(workerData.input) }); }
      catch (error) { parentPort.postMessage({ error: String(error.message) }); }`, {
      eval: true, workerData: { pattern, input, caseSensitive }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
  } catch (error) { activeWorkers--; throw error; }
  worker.once('exit', () => { activeWorkers--; });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Macro regex condition timed out. Simplify the expression.')), 2000);
    worker.once('message', result => {
      if (result.error) finish(new Error(result.error));
      else if (typeof result.value !== 'boolean') finish(new Error('Invalid regex worker response.'));
      else finish(undefined, result.value);
    });
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', () => finish(new Error('Regex worker exited before returning a result.')));
  });
}

export async function evaluateRenameRules(items: RenamerItem[], rules: RenameRule[]): Promise<RuleResult[]> {
  if (!Array.isArray(items) || !Array.isArray(rules) || items.length > 10_000 || rules.length > 100
    || rules.some(rule => rule.type === 'find-replace' && (rule.find.length > 4096 || rule.replace.length > 4096))) {
    throw new Error('Rename preview exceeds its item, rule, or pattern limits. Use a smaller batch.');
  }
  if (!items.length) return [];
  if (activeWorkers >= 2) throw new Error('Rename previews are busy. Wait for the current preview, then retry.');
  activeWorkers++;
  let worker: Worker;
  try {
    worker = new Worker(source, {
      eval: true,
      workerData: { items, rules },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
  } catch (error) { activeWorkers--; throw error; }
  worker.once('exit', () => { activeWorkers--; });
  return new Promise<RuleResult[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, results?: RuleResult[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(results!);
    };
    const timer = setTimeout(() => finish(new Error('Rename preview timed out. Simplify the regex or use a smaller batch.')), 2000);
    worker.once('message', (response: { results?: RuleResult[]; error?: string }) => {
      if (response.error) finish(new Error(response.error));
      else if (!Array.isArray(response.results) || response.results.length !== items.length
        || response.results.some(result => result.name.length > 32_768)) {
        finish(new Error('Rename preview exceeded its output limit.'));
      } else finish(undefined, response.results);
    });
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', code => {
      if (!settled) finish(new Error(`Rename preview worker exited unexpectedly (${code}).`));
    });
  });
}
