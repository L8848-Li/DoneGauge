import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJunit, JUNIT_LIMITS } from '../src/core/junit.js';

test('normalizes nested suites, named leaf tests, locations, durations, CDATA and XML entities', () => {
  const result =
    parseJunit(`<?xml version="1.0" encoding="UTF-8"?><testsuites tests="3"><testsuite name="outer" tests="3" failures="1" errors="1" skipped="1"><testsuite name="inner" tests="3">
    <testcase name="parameter[&lt;one&gt;]" classname="Example" time="0.125" file="test.py" line="12"><failure type="AssertionError" message="a &amp; b"><![CDATA[expected <1>\nstack]]></failure></testcase>
    <testcase name="setup"><error message="fixture broke"/></testcase>
    <testcase name="todo"><skipped type="todo"/></testcase>
  </testsuite></testsuite></testsuites>`);
  assert.equal(result.cases.length, 3);
  const first = result.cases[0]!;
  assert.deepEqual(first.suite, ['outer', 'inner']);
  assert.equal(first.name, 'parameter[<one>]');
  assert.equal(first.className, 'Example');
  assert.equal(first.file, 'test.py');
  assert.equal(first.line, 12);
  assert.equal(first.durationMs, 125);
  assert.equal(first.outcome, 'failed');
  assert.equal(first.details[0]?.message, 'a & b');
  assert.equal(first.details[0]?.text, 'expected <1>\nstack');
  assert.ok(first.reportLine > 0);
  assert.deepEqual(
    result.cases.map((c) => c.outcome),
    ['failed', 'error', 'skipped'],
  );
});

test('preserves duplicate names and requires review for file wrappers, retries and unknown statuses', () => {
  const result = parseJunit(
    '<testsuite><testcase name="same"/><testcase name="same"/><testcase name="a.test.mjs" file="/project/a.test.mjs"/><testcase name="retry" retries="1"><flakyFailure>first failure</flakyFailure></testcase><testcase name="unknown" status="mystery"/></testsuite>',
  );
  assert.equal(result.cases[2]?.outcome, 'unverified');
  assert.equal(result.cases[4]?.outcome, 'unverified');
  assert.ok(result.problems.some((problem) => problem.includes('retry/flaky')));
  assert.ok(
    result.problems.some((problem) => problem.includes('status/result')),
  );
});

for (const [name, xml] of [
  ['empty document', ''],
  ['malformed XML', '<testsuite><testcase></testsuite>'],
  ['invalid root', '<report/>'],
  ['missing name', '<testsuite><testcase/></testsuite>'],
  [
    'hidden testcase',
    '<testsuite><properties><testcase name="hidden"/></properties></testsuite>',
  ],
  [
    'nested testcase',
    '<testsuite><testcase name="parent"><testcase name="child"/></testcase></testsuite>',
  ],
  [
    'contradictory outcomes',
    '<testsuite><testcase name="x"><failure/><skipped/></testcase></testsuite>',
  ],
  [
    'nonfinite time',
    '<testsuite><testcase name="x" time="Infinity"/></testsuite>',
  ],
  ['negative time', '<testsuite><testcase name="x" time="-1"/></testsuite>'],
  ['invalid line', '<testsuite><testcase name="x" line="NaN"/></testsuite>'],
  ['false counts', '<testsuite tests="2"><testcase name="x"/></testsuite>'],
  [
    'failure counts',
    '<testsuite failures="1"><testcase name="x"/></testsuite>',
  ],
  [
    'DTD and external entities',
    '<!DOCTYPE testsuite [<!ENTITY secret SYSTEM "file:///etc/passwd">]><testsuite><testcase name="&secret;"/></testsuite>',
  ],
  [
    'external DTD',
    '<!DOCTYPE testsuite SYSTEM "https://example.test/a"><testsuite/>',
  ],
  ['HTML entity', '<testsuite><testcase name="&nbsp;"/></testsuite>'],
  [
    'processing instruction',
    '<?fetch href="https://example.test"?><testsuite/>',
  ],
  ['wrong encoding', '<?xml version="1.0" encoding="UTF-16"?><testsuite/>'],
  [
    'contradictory passed status',
    '<testsuite><testcase name="x" status="passed"><failure/></testcase></testsuite>',
  ],
  [
    'orphan failure attribute',
    '<testsuite><testcase name="x" failure="failed"/></testsuite>',
  ],
] as const)
  test(`JUnit rejects ${name}`, () => assert.throws(() => parseJunit(xml)));

test('bounds XML size, nesting and case count, accepting documented case limit', () => {
  assert.throws(() => parseJunit(' '.repeat(JUNIT_LIMITS.bytes + 1)), /10 MiB/);
  assert.throws(
    () => parseJunit('<testsuite>'.repeat(51) + '</testsuite>'.repeat(51)),
    /50 levels/,
  );
  const cases = '<testcase name="case"/>'.repeat(JUNIT_LIMITS.cases);
  assert.equal(
    parseJunit(`<testsuite>${cases}</testsuite>`).cases.length,
    50_000,
  );
  assert.throws(
    () => parseJunit(`<testsuite>${cases}<testcase name="extra"/></testsuite>`),
    /50000/,
  );
});
