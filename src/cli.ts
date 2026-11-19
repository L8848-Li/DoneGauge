#!/usr/bin/env node
import { writeFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkAcceptance } from './core/check.js';
import { isWithin, loadConfig } from './core/config.js';
import { DoneGaugeError, errorMessage } from './core/errors.js';
import { repositoryRoot } from './core/git.js';
import { version } from './core/version.js';
import { review } from './review/cli.js';
import { shareResult } from './review/shared-result.js';
import {
  renderJson,
  renderTerminal,
  terminalSafe,
  writeReports,
} from './reporters/index.js';

const help = `DoneGauge ${version} — Know what's done. See what's verified.

Usage:
  donegauge init [--cwd DIR] [--config FILE]
  donegauge review [--task TEXT | --draft ID [--approve DIGEST]] [--json]
  donegauge review --ai [--omit-tests] [--task TEXT | --draft ID [--send DIGEST]] [--json]
  donegauge check [--allow-run] [--json] [--base REF] [--cwd DIR]
  donegauge config-hash [--cwd DIR] [--config FILE]

Options:
  --cwd DIR          Project working directory (checks use its Git root)
  --config FILE      Configuration relative to Git root (default: donegauge.json)
  --base REF         Compare working tree to this commit/ref (default: HEAD)
  --output-dir PATH  New reports inside this project (default: .donegauge)
  --allow-run        Explicitly authorize configured commands for this run
  --task TEXT        Local review: separate requirements with semicolons or newlines
  --draft ID         Reopen a local review draft (preview by default)
  --share-with-dsh    On completed draft runs, save a local counts-only DSH receipt
  --approve DIGEST   Run only the exact review preview identified by this digest
  --ai               Preview an optional model request (no network by default)
  --omit-tests       Omit all candidate test names and IDs from the model request
  --send DIGEST      Send only the previewed model request; never executes tests
  --json             Print JSON to stdout; report file paths go to stderr
  --help             Show help
  --version          Show version

check previews by default. Review commands before adding --allow-run.
Exit codes: 0 verified, 1 review required, 2 execution/configuration error.
`;

function argumentsFromCli() {
  try {
    return parseArgs({
      options: {
        cwd: { type: 'string' },
        config: { type: 'string' },
        task: { type: 'string' },
        draft: { type: 'string' },
        'share-with-dsh': { type: 'boolean' },
        approve: { type: 'string' },
        ai: { type: 'boolean' },
        'omit-tests': { type: 'boolean' },
        send: { type: 'string' },
        base: { type: 'string' },
        'output-dir': { type: 'string' },
        'allow-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new DoneGaugeError(
      `${errorMessage(error)}. Run donegauge --help for supported options.`,
      'USAGE',
    );
  }
}

async function main(): Promise<number> {
  const { values, positionals } = argumentsFromCli();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
    return 0;
  }
  const command = positionals[0];
  if (
    values['share-with-dsh'] &&
    (command !== 'review' || !values.draft || values.ai)
  )
    throw new DoneGaugeError(
      '--share-with-dsh requires review --draft ID, without --ai.',
      'USAGE',
    );
  if (
    positionals.length !== 1 ||
    !['init', 'check', 'config-hash', 'review'].includes(command ?? '')
  ) {
    throw new DoneGaugeError(
      'Unknown command or extra arguments. Run donegauge --help.',
      'USAGE',
    );
  }
  if (
    command !== 'review' &&
    [
      values.task,
      values.draft,
      values.approve,
      values.ai,
      values.send,
      values['omit-tests'],
    ].some((value) => value !== undefined)
  )
    throw new DoneGaugeError(
      'Planning and draft options are only supported by review.',
      'USAGE',
    );
  if (
    command === 'review' &&
    ['allow-run', 'config', 'base', 'output-dir'].some((key) => key in values)
  )
    throw new DoneGaugeError(
      'Review uses its own local draft, HEAD and private report directory. Use --draft ID --approve DIGEST to run.',
      'USAGE',
    );
  const cwd = resolve(values.cwd ?? process.cwd());
  const configPath = values.config ?? 'donegauge.json';
  if (command === 'init') {
    const root = await realpath(cwd);
    const target = resolve(root, configPath);
    if (
      !isWithin(root, target) ||
      target !== resolve(root, basename(configPath))
    ) {
      throw new DoneGaugeError(
        'init needs a filename inside --cwd. Use --cwd to select the directory.',
        'CONFIG',
      );
    }
    const template = {
      version: 1,
      task: 'Describe your coding task',
      criteria: [
        {
          id: 'AC-1',
          description: 'Replace with a concrete acceptance condition',
        },
      ],
    };
    try {
      await writeFile(target, JSON.stringify(template, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new DoneGaugeError(
          'Configuration already exists. Edit it or select a new --config file; init never overwrites it.',
          'CONFIG',
        );
      throw error;
    }
    process.stdout.write(
      `Created ${configPath}. Edit the task and criteria; add check.command arrays for your tests.\nReview your commands, then run donegauge check --allow-run.\n`,
    );
    return 0;
  }
  const controller = new AbortController();
  let interrupted = 0;
  const onInt = (): void => {
    interrupted = 130;
    controller.abort();
  };
  const onTerm = (): void => {
    interrupted = 143;
    controller.abort();
  };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    const root = await repositoryRoot(cwd, controller.signal);
    if (command === 'config-hash') {
      process.stdout.write((await loadConfig(root, configPath)).sha256 + '\n');
      return 0;
    }
    const approved =
      command === 'review'
        ? await review(root, values, controller.signal)
        : null;
    if (command === 'review' && !approved) return 0;
    const report = await checkAcceptance({
      cwd: root,
      configPath,
      ...(approved ?? {}),
      execute: Boolean(approved || values['allow-run']),
      signal: controller.signal,
      ...(values.base !== undefined ? { base: values.base } : {}),
    });
    const paths = await writeReports(
      root,
      report,
      values['output-dir'] ?? '.donegauge',
    );
    process.stdout.write(
      values.json ? renderJson(report) : renderTerminal(report),
    );
    if (values['share-with-dsh'] && values.draft) {
      controller.signal.throwIfAborted();
      await shareResult(root, values.draft, report);
      process.stderr.write(
        'Local DSH summary ready. Draft: ' +
          values.draft +
          '  Run: ' +
          report.runId +
          '\n',
      );
    }
    process.stderr.write(
      terminalSafe(`Reports: ${paths.markdown}\n         ${paths.json}\n`),
    );
    return report.summary.ERROR > 0
      ? 2
      : report.finalStatus === 'VERIFIED'
        ? 0
        : 1;
  } catch (error) {
    if (interrupted) {
      process.stderr.write(
        'DoneGauge cancelled. In-flight foreground commands were stopped.\n',
      );
      return interrupted;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(terminalSafe(`DoneGauge: ${errorMessage(error)}\n`));
  return 2;
});
