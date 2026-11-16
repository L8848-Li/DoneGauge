# DoneGauge

**Know what's done. See what's verified.**

DoneGauge is a local acceptance layer for AI coding: connect explicit requirements
to real commands, Git changes, and inspectable test evidence.

> AI says it's done. DoneGauge shows the evidence.

[简体中文](README.zh-CN.md) · [Configuration](docs/configuration.md) ·
[DSH integration](docs/dsh.md) · [Architecture](docs/architecture.md) ·
[Next steps design (中文)](docs/next-steps.zh-CN.md)

## What it does

- Collects tracked and untracked changes against a Git commit, including staged
  and unstaged work. It never modifies your Git history or index.
- Reads one `donegauge.json` with the task, acceptance criteria, and explicit check
  commands; validates it with a shipped JSON Schema.
- Links exact named tests to fresh JUnit XML from Node, pytest, and compatible
  runners; missing, skipped, ambiguous, and file-wrapper cases cannot PASS.
- Runs reviewed local commands without an implicit shell, with deadlines,
  cancellation, and bounded logs.
- Separates **PASS**, **FAIL**, **UNVERIFIED**, and **ERROR**. Every passing criterion
  references a real execution with its command, timestamps, exit status, and logs.
- Produces terminal, Markdown, and JSON reports in a fresh directory for every run.
- Offers `donegauge_check` through the official DeepSeek Harness plugin API.

Code review explains a diff. A test runner executes tests. DoneGauge links the
user's acceptance conditions to configured checks and shows gaps in the evidence.
It does not infer correctness from related code, invent tests, assign a correctness
percentage, or use a model to decide PASS. No API key is required.

## Install from this source checkout

Requires **Node.js 22+**, npm, and Git. The Python example needs Python 3.
The optional DSH adapter requires **Node.js 24.9+ and DSH 0.2.2-rc.3**.

```sh
git clone https://github.com/L8848-Li/DoneGauge.git
cd DoneGauge
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

This release is a local source/tarball deliverable; it has not been published to
npm. Do not assume `npx donegauge` downloads this code. To install the built package
in another project's local tools:

```sh
# In the DoneGauge checkout
npm pack

# In your project, using the actual tarball path
npm install --save-dev /path/to/DoneGauge/donegauge-0.1.0.tgz
npx --no-install donegauge --version
```

No global dependency installation is needed. `npm run test:package` tests an actual
packed installation in a disposable project, including its installed executable.

## Three-minute example

From the DoneGauge checkout, prepare an isolated example Git repository:

```sh
node scripts/demo.mjs node-registration
```

The script copies the example to a temporary directory, initializes Git there,
and prints the exact check commands. It never changes Git in this checkout.
Run the printed preview, then the printed `check --allow-run` command. Three real
Node.js assertions cover duplicate email, salted password storage, and login.

To see all four states using real execution results:

```sh
node scripts/demo.mjs node-registration --mixed
```

The mixed configuration tests an intentionally regressed login implementation,
leaves one condition without a check, and invokes a missing audit executable.
Its expected exit code is 2, with one criterion in each status. This is an
intentional failure fixture, not a fabricated acceptance result.

The independent Python example uses standard-library `unittest` and `Decimal`:

```sh
node scripts/demo.mjs python-cart
```

## Use it in your project

```sh
npx --no-install donegauge init
```

Edit the created config. `init` never overwrites an existing file and creates no
pre-approved test command. For example:

```json
{
  "version": 1,
  "task": "Implement user registration",
  "criteria": [
    {
      "id": "registration",
      "description": "The registration assertions pass",
      "check": {
        "command": [
          "node",
          "--test",
          "--test-reporter=tap",
          "registration.test.mjs"
        ],
        "timeoutMs": 30000,
        "expect": { "stdoutIncludes": "# pass 3" }
      }
    },
    { "id": "audit", "description": "Security review completed" }
  ]
}
```

```sh
npx --no-install donegauge check
npx --no-install donegauge check --allow-run
npx --no-install donegauge check --allow-run --base main --json
```

Without `--allow-run`, `check` only previews and marks checks UNVERIFIED.
Commands are argv arrays, not shell strings. `&&`, redirection, `$()` and globs
are not expanded. Review the commands and project code before authorizing a run;
they execute with your local user permissions and environment.

## Reading results

The mixed demo has this summary; ids, times, and logs come from each actual run:

```text
DoneGauge — Acceptance Report

Task: Review registration with a real login regression and evidence gaps

[PASS] email: Duplicate email is rejected
  Configured check completed with expected exit code 0 and expected output.
[FAIL] login: User can log in with the regressed implementation
  Check exited 1; expected 0.
[UNVERIFIED] audit: Security audit completed (no check configured)
  No verification command configured. Add a check to collect evidence.
[ERROR] missing-tool: External audit command can execute
  Could not start the configured audit executable.

Summary: 1 verified, 1 failed, 1 unverified, 1 errors
Final status: REVIEW REQUIRED
```

Actual terminal output also includes changed files, commands, evidence ids,
execution states, durations, and failure excerpts. Full retained stdout/stderr and
diffs are saved in:

```text
.donegauge/runs/<run-id>/report.md
.donegauge/runs/<run-id>/report.json
```

`--json` keeps stdout machine-readable; saved report paths go to stderr. Add
`.donegauge/` to your `.gitignore` before sharing a repository. This reserved
directory is excluded from untracked change collection. Reports can contain
private code and logs; they stay local and are not automatically redacted.

| Status     | Interpretation                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------ |
| PASS       | The configured check met its exit/output contract.                                               |
| FAIL       | The completed command contradicted its contract, or a selected JUnit test failed.                |
| UNVERIFIED | No sufficient evidence: missing check, preview, or required output lost to truncation.           |
| ERROR      | Execution failed to start, timed out, was interrupted, or otherwise failed to complete normally. |

For JUnit, PASS also requires uniquely selected executed tests and complete fresh
XML; missing, skipped, ambiguous, or file-wrapper targets remain UNVERIFIED. See
[JUnit status precedence](docs/configuration.md#junit-checks).

Exit codes: **0** all criteria verified against a stable working tree; **1** review
required; **2** configuration, Git, report-writing, or check execution errors.
Interrupts use 130/143. A workspace change during verification always requires
review, even if the commands passed. Global setup errors do not create fake check
evidence.

## DeepSeek Harness

The adapter is a real Cordis tool plugin, independent of the CLI. Bind an absolute
Git root and a reviewed config SHA-256 in a local DSH patch, then explicitly ask
DSH to use `donegauge_check` with `{}`. The model cannot supply commands or paths.

```sh
npx --no-install donegauge config-hash
```

See [the complete DSH setup](docs/dsh.md). V0.1 verifies the official runtime and
installed host CLI path; it does not provide a custom Web card or claim a manual
model-driven Desktop UI test. It never edits your global DSH configuration.

## Known limits

- You choose which checks establish each condition. Exit code 0 alone proves
  only the declared process contract. It cannot prove test quality or coverage.
  Prefer specific output/test-count expectations to detect empty test runs.
- JUnit supports exact names and optional class names, one report and command per
  criterion. No automatic test discovery/generation, failure-to-source mapping,
  cross-criterion cache, retry orchestration, or score.
- Tests run sequentially and can modify local files. Before/after fingerprints
  flag observed changes but are not atomic snapshots or signed attestations.
  Ignored files and dirty submodule contents are not fully fingerprinted.
- Logs default to 64 KiB per check; the displayed Git diff is capped at 256 KiB.
  Metadata that exceeds its bound stops the run rather than silently omitting files.
- Renames are reported as delete/add. No remote fetch or automatic base selection.
- Ubuntu and macOS passed the [hosted CI checks](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml). Windows is not a supported,
  verified V0.1 target. Its process-tree termination and `.cmd` launching need work.
- DSH compatibility is deliberately pinned to 0.2.2-rc.3. Commands run in the host
  user context, not DSH's bash sandbox. No other agent adapters are implemented.
- No dashboard, accounts, collaboration, cloud storage, automatic repair,
  interactive initializer, or previous-report browser.

## Development and roadmap

```sh
python3 -m pip install -r tests/requirements.txt # preferably in a virtual environment
npm run check
npm run test:package
npm run test:dsh-host  # optional: requires an installed compatible DSH
```

See [CONTRIBUTING](CONTRIBUTING.md) and the [actual validation record](docs/validation.md).

The **JUnit result checker** now links criteria to named tests from fresh runs;
see [JUnit configuration](docs/configuration.md#junit-checks). Next: V0.2 Codex/Claude
Code adapters; V0.3 framework checkers; V0.4 evidence tracing and quality gates;
V1.0 acceptance handoff protocol. These are future plans, not shipped features.

## License

[MIT](LICENSE). Runtime dependency notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No source is copied from dsh-qa.
