export { checkAcceptance } from './core/check.js';
export type { CheckOptions } from './core/check.js';
export { parseConfig, loadConfig } from './core/config.js';
export { collectChanges, repositoryRoot } from './core/git.js';
export { runCommand } from './core/runner.js';
export { evaluate } from './core/evaluator.js';
export { parseJunit, JUNIT_LIMITS } from './core/junit.js';
export { evaluateJunit } from './core/junit-evaluator.js';
export { DoneGaugeError } from './core/errors.js';
export {
  renderTerminal,
  renderMarkdown,
  renderJson,
  writeReports,
} from './reporters/index.js';
export type * from './core/types.js';
// The DSH client loader discovers bundles by bare package name. Lazily load
// the optional host adapter so ordinary library imports never need DSH.
export const name = 'donegauge';
export const inject = ['tools'];
export async function apply(ctx: unknown, config?: unknown): Promise<void> {
  const adapter = await import('./adapters/dsh/index.js');
  adapter.apply(
    ctx as Parameters<typeof adapter.apply>[0],
    config as Parameters<typeof adapter.apply>[1],
  );
}
