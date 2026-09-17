// Engine-owned reporter for the public Vitest 3.2.4+/4 reporter API.
export const vitestReporterSource = String.raw`
import { writeFileSync } from 'node:fs';
function kind(error) {
  const name = String(error?.name || error?.nameStr || '');
  const message = String(error?.message || '');
  if (name === 'AssertionError' || error?.code === 'ERR_ASSERTION') return 'assertion';
  if (name === 'SyntaxError' || /Unexpected token|Parse failure|Transform failed|Expected .* but found/u.test(message)) return 'syntax';
  if (/Cannot find|Failed to resolve|Cannot resolve|MODULE_NOT_FOUND/u.test(message)) return 'dependency';
  return 'other';
}
export default class Reporter {
  pendingHooks = new Map();
  onHookStart({ entity, name }) {
    const pending = this.pendingHooks.get(entity.id) || new Set();
    pending.add(name); this.pendingHooks.set(entity.id, pending);
  }
  onHookEnd({ entity, name }) { this.pendingHooks.get(entity.id)?.delete(name); }
  onTestRunEnd(modules, unhandled, reason) {
    const failures = [];
    let failureTotal = 0;
    const summary = { success: reason === 'passed', tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
    const fail = (name, file, errors, allowAssertion) => {
      failureTotal++; summary.failed++;
      const kinds = errors.map(kind);
      const type = kinds.includes('syntax') ? 'syntax' : kinds.includes('dependency') ? 'dependency'
        : allowAssertion && kinds.length > 0 && kinds.every(k => k === 'assertion') ? 'assertion' : 'other';
      if (failures.length < 100) failures.push({name: String(name || 'unnamed test').slice(0,512), file: String(file || 'unhandled'), kind: type});
    };
    for (const module of modules) {
      const suites = [module, ...module.children.allSuites()];
      for (const suite of suites) {
        const errors = suite.errors();
        if (errors.length) fail(suite.fullName || module.moduleId, module.moduleId, errors, false);
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === 'passed') { summary.tests++; summary.passed++; }
        else if (result.state === 'failed') { summary.tests++; fail(test.fullName, module.moduleId, result.errors || [], !this.pendingHooks.get(test.id)?.size); }
        else if (result.state === 'skipped') summary.skipped++;
        else { summary.cancelled++; summary.success = false; }
      }
    }
    for (const error of unhandled) fail('unhandled error', 'unhandled', [error], false);
    summary.success = summary.success && failureTotal === 0 && summary.cancelled === 0;
    writeFileSync(process.env.WSPECKIT_VITEST_REPORT, JSON.stringify({version:1, adapter:'vitest', summary, failureTotal, truncated: failureTotal > failures.length, failures}));
  }
}
`;
