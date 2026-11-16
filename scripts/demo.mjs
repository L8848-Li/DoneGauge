import { execFile } from 'node:child_process';
import { cp, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = process.argv[2] ?? 'node-registration';
const flags = process.argv.slice(3);
if (
  !['node-registration', 'python-cart'].includes(example) ||
  flags.some((flag) => !['--mixed', '--run'].includes(flag)) ||
  (example !== 'node-registration' && flags.includes('--mixed'))
) {
  throw new Error(
    'Use: node scripts/demo.mjs node-registration [--mixed] [--run], or python-cart [--run].',
  );
}
const project = await realpath(
  await mkdtemp(join(tmpdir(), `donegauge-${example}-`)),
);
await cp(join(source, 'examples', example), project, { recursive: true });
await writeFile(join(project, '.gitignore'), '.donegauge/\n__pycache__/\n');
await execute('git', ['init', '-q'], { cwd: project });
const cli = join(source, 'dist/src/cli.js');
const args = [
  'check',
  '--cwd',
  project,
  ...(flags.includes('--mixed') ? ['--config', 'donegauge.mixed.json'] : []),
];
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
console.log(`Prepared a disposable example Git repository: ${project}`);
console.log('Preview (no test commands execute):');
console.log([process.execPath, cli, ...args].map(quote).join(' '));
console.log('Execute the reviewed example checks:');
console.log(
  [process.execPath, cli, ...args, '--allow-run'].map(quote).join(' '),
);
if (flags.includes('--run')) {
  let outcome;
  try {
    outcome = {
      code: 0,
      ...(await execute(process.execPath, [cli, ...args, '--allow-run'], {
        maxBuffer: 10 * 1024 * 1024,
      })),
    };
  } catch (error) {
    outcome = error;
  }
  process.stdout.write(outcome.stdout ?? '');
  process.stderr.write(outcome.stderr ?? '');
  process.exitCode = typeof outcome.code === 'number' ? outcome.code : 2;
}
