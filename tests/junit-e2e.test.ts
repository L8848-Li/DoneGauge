import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAcceptance } from '../src/core/check.js';
import { parseConfig, sha256 } from '../src/core/config.js';
import {
  renderJson,
  renderMarkdown,
  renderTerminal,
} from '../src/reporters/index.js';
import type {
  AcceptanceConfig,
  AcceptanceReport,
  JunitCheck,
} from '../src/core/types.js';
import { newRepo, runCli, saveConfig, tempDirectory } from './helpers.js';

function junitConfig(command: string[], names: string[]): AcceptanceConfig {
  return {
    version: 1,
    task: 'Verify named executed tests',
    criteria: [
      {
        id: 'target',
        description: 'Selected tests pass',
        check: {
          kind: 'junit',
          command,
          junit: {
            file: '{evidenceDir}/junit.xml',
            tests: names.map((name) => ({ name })),
          },
        },
      },
    ],
  };
}
const nodeCommand = (file = 'target.test.mjs', pattern?: string): string[] => [
  process.execPath,
  '--test',
  ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
  '--test-reporter=junit',
  '--test-reporter-destination={evidenceDir}/junit.xml',
  file,
];
const source = `import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
test('target passes', () => assert.equal(2 + 2, 4));
test('target fails', () => assert.equal(2 + 2, 5));
test.skip('target skips', () => assert.fail('not run'));
test.todo('target todo');
test('duplicate', () => {}); test('duplicate', () => {});
describe('parent suite', () => { it('parameter[one]', () => assert.ok(true)); });
`;

for (const [label, pattern, names, status] of [
  ['pass', '^target passes$', ['target passes'], 'PASS'],
  ['assertion failure', '^target fails$', ['target fails'], 'FAIL'],
  ['all skip', '^target skips$', ['target skips'], 'UNVERIFIED'],
  ['todo', '^target todo$', ['target todo'], 'UNVERIFIED'],
  ['wrong filter', '^nonexistent$', ['target passes'], 'UNVERIFIED'],
  ['unrelated test', '^target passes$', ['missing target'], 'UNVERIFIED'],
  ['duplicate names', '^duplicate$', ['duplicate'], 'UNVERIFIED'],
  [
    'parameter and nested suite',
    'parent suite|parameter',
    ['parameter[one]'],
    'PASS',
  ],
  ['passing target with failed run', undefined, ['target passes'], 'ERROR'],
  [
    'mixed target outcomes',
    undefined,
    ['target passes', 'target fails', 'target skips', 'missing'],
    'FAIL',
  ],
] as const)
  test(`real Node JUnit: ${label}`, async (t) => {
    const root = await newRepo(t);
    await writeFile(join(root, 'target.test.mjs'), source);
    await saveConfig(
      root,
      junitConfig(nodeCommand('target.test.mjs', pattern), [...names]),
    );
    const report = await checkAcceptance({ cwd: root, execute: true });
    const result = report.criteria[0]!;
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.testEvidence?.executionId, result.evidence?.id);
    assert.equal(result.testEvidence?.runId, report.runId);
    assert.equal(result.testEvidence?.configSha256, report.config.sha256);
    assert.equal(
      result.testEvidence?.git.fingerprint,
      report.changes.fingerprint,
    );
    const raw = await readFile(join(root, result.testEvidence!.source.path));
    assert.equal(result.testEvidence?.source.sha256, sha256(raw));
    assert.equal(report.workspaceChangedDuringRun, false);
    if (label === 'wrong filter') {
      assert.equal(result.evidence?.exitCode, 0);
      assert.equal(result.testEvidence?.cases.length, 1);
      assert.equal(result.testEvidence?.cases[0]?.outcome, 'unverified');
    }
  });

test('real Node file wrapper cannot pass even if explicitly selected; empty file gives no target evidence', async (t) => {
  const root = await newRepo(t);
  await writeFile(join(root, 'target.test.mjs'), source);
  await saveConfig(
    root,
    junitConfig(nodeCommand('target.test.mjs', 'nonexistent'), [
      'target.test.mjs',
    ]),
  );
  assert.equal(
    (await checkAcceptance({ cwd: root, execute: true })).criteria[0]?.status,
    'UNVERIFIED',
  );
  await writeFile(join(root, 'target.test.mjs'), '');
  assert.equal(
    (await checkAcceptance({ cwd: root, execute: true })).criteria[0]?.status,
    'UNVERIFIED',
  );
});

const python = process.env.DONEGAUGE_PYTHON ?? 'python3';
test('real pytest empty collection and unmatched filter are UNVERIFIED even with exit 5', async (t) => {
  const root = await newRepo(t);
  for (const [content, args] of [
    ['', []],
    ['def test_unrelated():\n    assert True\n', ['-k', 'nonexistent']],
  ] as const) {
    await writeFile(join(root, 'test_empty.py'), content);
    await saveConfig(
      root,
      junitConfig(
        [
          python,
          '-B',
          '-m',
          'pytest',
          '-p',
          'no:cacheprovider',
          '-q',
          'test_empty.py',
          ...args,
          '--junitxml={evidenceDir}/junit.xml',
        ],
        ['test_target'],
      ),
    );
    const result = (await checkAcceptance({ cwd: root, execute: true }))
      .criteria[0]!;
    assert.equal(result.evidence?.exitCode, 5);
    assert.equal(result.status, 'UNVERIFIED', JSON.stringify(result));
    assert.equal(result.testEvidence?.counts.total, 0);
  }
});
for (const [name, status] of [
  ['test_pass[one]', 'PASS'],
  ['test_fail', 'FAIL'],
  ['test_skip', 'UNVERIFIED'],
  ['test_setup', 'ERROR'],
] as const)
  test(`real pytest JUnit: ${name}`, async (t) => {
    const root = await newRepo(t);
    await writeFile(
      join(root, 'test_target.py'),
      `import pytest
@pytest.mark.parametrize("value", [1], ids=["one"])
def test_pass(value):
    assert value == 1
def test_fail():
    assert 1 == 2
@pytest.mark.skip(reason="not executed")
def test_skip():
    assert False
@pytest.fixture
def broken():
    raise RuntimeError("setup failed")
def test_setup(broken):
    pass
`,
    );
    const config = junitConfig(
      [
        python,
        '-B',
        '-m',
        'pytest',
        '-p',
        'no:cacheprovider',
        '-q',
        `test_target.py::${name}`,
        '--junitxml={evidenceDir}/junit.xml',
      ],
      [name],
    );
    (config.criteria[0]!.check as JunitCheck).junit.tests[0]!.className =
      'test_target';
    await saveConfig(root, config);
    const result = (await checkAcceptance({ cwd: root, execute: true }))
      .criteria[0]!;
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.testEvidence?.cases[0]?.className, 'test_target');
  });

test('JUnit argv and report paths preserve literal dollar sequences in the repository name', async (t) => {
  const fixture = await newRepo(t);
  const root = join(await tempDirectory(t), 'project $& $$');
  await rename(fixture, root);
  await writeFile(join(root, 'target.test.mjs'), source);
  await saveConfig(
    root,
    junitConfig(nodeCommand('target.test.mjs', '^target passes$'), [
      'target passes',
    ]),
  );
  const report = await checkAcceptance({ cwd: root, execute: true });
  assert.equal(report.finalStatus, 'VERIFIED', JSON.stringify(report.criteria));
  assert.match(
    report.criteria[0]!.testEvidence!.source.path,
    /^\.donegauge\/evidence\//,
  );
});

test('preview and approval mismatch never allocate JUnit evidence or start a command', async (t) => {
  const root = await newRepo(t);
  await saveConfig(root, junitConfig(nodeCommand(), ['target']));
  const preview = await checkAcceptance({ cwd: root });
  assert.equal(preview.criteria[0]?.evidence, null);
  assert.equal(preview.criteria[0]?.testEvidence, undefined);
  await assert.rejects(readFile(join(root, '.donegauge/evidence')), /ENOENT/);
  await assert.rejects(
    checkAcceptance({
      cwd: root,
      execute: true,
      approvedConfigSha256: '0'.repeat(64),
    }),
    /approved SHA-256/,
  );
});

// Synthetic reports here test hostile filesystem/report boundaries, not real
// framework acceptance. The Node and pytest tests above generate actual XML.
for (const [label, body, status] of [
  ['missing report', '', 'ERROR'],
  ['empty report', `fs.writeFileSync(file, '')`, 'ERROR'],
  ['damaged report', `fs.writeFileSync(file, '<testsuite>')`, 'ERROR'],
  [
    'invalid UTF-8',
    `fs.writeFileSync(file, Buffer.from([0xff,0xfe]))`,
    'ERROR',
  ],
  [
    'oversized report',
    `fs.writeFileSync(file, ' '.repeat(10*1024*1024+1))`,
    'ERROR',
  ],
  [
    'zero cases',
    `fs.writeFileSync(file, '<testsuite tests="0"/>')`,
    'UNVERIFIED',
  ],
  [
    'explicit failure with exit zero',
    `fs.writeFileSync(file, '<testsuite><testcase name="target"><failure message="bad"/></testcase></testsuite>')`,
    'FAIL',
  ],
  ['file symlink', `fs.symlinkSync('outside.xml', file)`, 'ERROR'],
  [
    'outside symlink',
    `fs.symlinkSync(require('node:path').resolve('old.xml'), file)`,
    'ERROR',
  ],
  ['hard link to stale report', `fs.linkSync('old.xml', file)`, 'ERROR'],
  ['report directory instead of file', `fs.mkdirSync(file)`, 'ERROR'],
  [
    'directory replaced',
    `fs.rmSync(require('node:path').dirname(file), {recursive:true});fs.mkdirSync(require('node:path').dirname(file));fs.writeFileSync(file, xml)`,
    'ERROR',
  ],
] as const)
  test(`JUnit evidence boundary: ${label}`, async (t) => {
    const root = await newRepo(t);
    await writeFile(
      join(root, 'old.xml'),
      '<testsuite><testcase name="target"/></testsuite>',
    );
    const command = [
      process.execPath,
      '-e',
      `const fs=require('node:fs');const file=process.argv[1];const xml='<testsuite><testcase name="target"/></testsuite>';${body}`,
      '{evidenceDir}/junit.xml',
    ];
    await saveConfig(root, junitConfig(command, ['target']));
    const result = (await checkAcceptance({ cwd: root, execute: true }))
      .criteria[0]!;
    assert.equal(result.status, status, JSON.stringify(result));
  });

test('timeout partial XML is retained but cannot pass, and later runs never reuse it', async (t) => {
  const root = await newRepo(t);
  const config = junitConfig(
    [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(process.argv[1],'<testsuite><testcase name="target"/></testsuite>'); setInterval(()=>{},1000)`,
      '{evidenceDir}/junit.xml',
    ],
    ['target'],
  );
  config.criteria[0]!.check!.timeoutMs = 500;
  await saveConfig(root, config);
  const first = (await checkAcceptance({ cwd: root, execute: true }))
    .criteria[0]!;
  assert.equal(first.status, 'ERROR');
  assert.equal(first.evidence?.state, 'timed-out');
  assert.equal(first.testEvidence?.cases[0]?.outcome, 'passed');
  await saveConfig(root, junitConfig([process.execPath, '-e', ''], ['target']));
  const second = (await checkAcceptance({ cwd: root, execute: true }))
    .criteria[0]!;
  assert.equal(second.status, 'ERROR');
  assert.notEqual(
    first.testEvidence?.source.path,
    second.testEvidence?.source.path,
  );
  assert.equal(second.testEvidence?.source.sha256, null);
});

test('JUnit refuses symlink ancestors before execution and nested report symlinks afterwards', async (t) => {
  const root = await newRepo(t);
  const other = await tempDirectory(t);
  await symlink(
    other,
    join(root, '.donegauge'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await saveConfig(root, junitConfig(nodeCommand(), ['target']));
  await assert.rejects(
    checkAcceptance({ cwd: root, execute: true }),
    /normal directory/,
  );
  const nestedRoot = await newRepo(t);
  await mkdir(join(nestedRoot, 'old'));
  await writeFile(
    join(nestedRoot, 'old/junit.xml'),
    '<testsuite><testcase name="target"/></testsuite>',
  );
  const config = junitConfig(
    [
      process.execPath,
      '-e',
      `require('node:fs').symlinkSync(require('node:path').resolve('old'),process.argv[1],process.platform === 'win32' ? 'junction' : 'dir')`,
      '{evidenceDir}/nested',
    ],
    ['target'],
  );
  (config.criteria[0]!.check as JunitCheck).junit.file =
    '{evidenceDir}/nested/junit.xml';
  await saveConfig(nestedRoot, config);
  assert.equal(
    (await checkAcceptance({ cwd: nestedRoot, execute: true })).criteria[0]
      ?.status,
    'ERROR',
  );
});

test('CLI JSON and saved Markdown/terminal carry identical target counts, status and evidence identity', async (t) => {
  const root = await newRepo(t);
  await writeFile(join(root, 'target.test.mjs'), source);
  await saveConfig(
    root,
    junitConfig(nodeCommand('target.test.mjs', '^target passes$'), [
      'target passes',
    ]),
  );
  const cli = await runCli(root, ['check', '--allow-run', '--json']);
  assert.equal(cli.code, 0, cli.stderr);
  const report = JSON.parse(cli.stdout) as AcceptanceReport;
  assert.deepEqual(JSON.parse(renderJson(report)), report);
  const criterion = report.criteria[0]!;
  for (const output of [
    renderTerminal(report),
    renderMarkdown(report),
    await readFile(
      join(root, `.donegauge/runs/${report.runId}/report.md`),
      'utf8',
    ),
  ]) {
    assert.ok(output.includes(criterion.evidence!.id));
    assert.ok(output.includes(criterion.testEvidence!.source.path));
    assert.ok(output.includes('1/1'));
    assert.ok(output.includes('PASS'));
  }
});

test('JUnit schema stays strict and rejects wrong branches, empty selectors and traversal before execution', () => {
  const valid = junitConfig(nodeCommand(), ['target']);
  assert.doesNotThrow(() => parseConfig(JSON.stringify(valid)));
  for (const change of [
    { expect: { exitCode: 0 } },
    { kind: 'command' },
    { kind: 'unknown' },
    { junit: { file: 'old.xml', tests: [{ name: 'target' }] } },
    {
      junit: { file: '{evidenceDir}/../old.xml', tests: [{ name: 'target' }] },
    },
    { junit: { file: '{evidenceDir}/a\\b.xml', tests: [{ name: 'target' }] } },
    { junit: { file: '{evidenceDir}/junit.xml', tests: [] } },
    {
      junit: {
        file: '{evidenceDir}/junit.xml',
        tests: [{ name: 'target', regex: true }],
      },
    },
    {
      junit: {
        file: '{evidenceDir}/junit.xml',
        tests: [{ name: 'target' }],
        minExecuted: 0,
      },
    },
  ]) {
    const config = structuredClone(valid);
    Object.assign(config.criteria[0]!.check!, change);
    assert.throws(() => parseConfig(JSON.stringify(config)));
  }
});

test('exact class selection disambiguates names; unrelated cases and overlapping selectors cannot inflate minExecuted', async (t) => {
  const root = await newRepo(t);
  const xml =
    '<testsuite><testcase name="target" classname="A"/><testcase name="target" classname="B"/><testcase name="unrelated"/></testsuite>';
  const command = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(process.argv[1], process.argv[2])`,
    '{evidenceDir}/junit.xml',
    xml,
  ];
  const config = junitConfig(command, ['target']);
  const check = config.criteria[0]!.check as JunitCheck;
  for (const [className, minimum, expected] of [
    ['A', 1, 'PASS'],
    ['wrong', 1, 'UNVERIFIED'],
    ['A', 2, 'UNVERIFIED'],
  ] as const) {
    check.junit.tests[0]!.className = className;
    check.junit.minExecuted = minimum;
    await saveConfig(root, config);
    const result = (await checkAcceptance({ cwd: root, execute: true }))
      .criteria[0]!;
    assert.equal(result.status, expected);
    assert.equal(result.testEvidence?.counts.total, 3);
  }
  // A single unique testcase selected by both a name-only and a class selector
  // is still one executed target, even though both selectors matched.
  check.command[check.command.length - 1] =
    '<testsuite><testcase name="target" classname="A"/></testsuite>';
  check.junit.tests = [{ name: 'target' }, { name: 'target', className: 'A' }];
  await saveConfig(root, config);
  const result = (await checkAcceptance({ cwd: root, execute: true }))
    .criteria[0]!;
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(result.testEvidence?.counts.executedTargets, 1);
});

test('JUnit execution errors outrank assertion failures and retry/extension evidence never passes', async (t) => {
  const root = await newRepo(t);
  for (const [xml, expected] of [
    [
      '<testsuite><testcase name="target"><failure/></testcase><testcase name="other"><error/></testcase></testsuite>',
      'ERROR',
    ],
    [
      '<testsuite><testcase name="target"><flakyFailure>first failed attempt</flakyFailure></testcase></testsuite>',
      'UNVERIFIED',
    ],
    [
      '<testsuite><testcase name="target" retries="1"/></testsuite>',
      'UNVERIFIED',
    ],
    [
      '<testsuite><testcase name="target"><ignored/></testcase></testsuite>',
      'UNVERIFIED',
    ],
  ]) {
    await saveConfig(
      root,
      junitConfig(
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(process.argv[1],process.argv[2])`,
          '{evidenceDir}/junit.xml',
          xml!,
        ],
        ['target'],
      ),
    );
    assert.equal(
      (await checkAcceptance({ cwd: root, execute: true })).criteria[0]?.status,
      expected,
    );
  }
});
