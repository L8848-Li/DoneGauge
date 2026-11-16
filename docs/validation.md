# V0.1 validation record

Verified locally on **2026-11-16**, macOS arm64, Node.js 24.16.0, npm 11.13.0,
Python 3.12.13, Git, and installed DeepSeek Harness Desktop **0.2.2-rc.3**.
Results below describe the initial local runs, not planned checks or simulated reports.
Current hosted CI results are available on the [repository Actions page](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml).

## Automated checks

| Command / scope                            | Actual result                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                            | Strict TypeScript, ESLint, Prettier, build, and **48/48 tests passed**, zero skipped.                                                                                                                                     |
| Node.js 22.23.5 core/CLI compatibility run | **42/42 tests passed**, zero skipped; DSH-specific tests intentionally excluded because DSH requires Node 24.9+.                                                                                                          |
| `npm run test:package`                     | Tarball installed offline in a disposable project; installed executable reported 0.1.0; 3 real Node checks passed; JSON/Markdown reports persisted; no DSH package installed.                                             |
| `npm run test:dsh-host`                    | Installed official CLI version checked; local bundle installed into an isolated temporary profile; configuration composed; host booted; `donegauge_check` invoked through native tool executor; **3 real checks passed**. |
| Documented Node demo                       | 3 PASS, final VERIFIED.                                                                                                                                                                                                   |
| Documented mixed demo                      | 1 PASS, 1 FAIL, 1 UNVERIFIED, 1 ERROR; final REVIEW REQUIRED, exit 2.                                                                                                                                                     |
| Documented Python demo                     | 2 PASS, final VERIFIED, using standard-library unittest.                                                                                                                                                                  |

The 48-test suite covers invalid config/JSON, unknown fields, duplicate ids,
missing evidence, read/path boundaries, staged/unstaged/untracked/deleted changes,
unusual filenames, alternative bases, unborn Git, non-Git directories, binary
contents, diff truncation, preservation of Git index/history, real failed
assertions, startup failure, timeout, signals, cancellation, output truncation,
literal shell-operator arguments, POSIX descendant cleanup, moving workspaces,
report integrity, overwrite refusal, and report-directory symlink refusal.

Six of these tests assemble the official Cordis framework, system-prompt service,
tool registry, native executor, and DoneGauge plugin. They verify real approved
checks, structured mixed states, missing/stale authorization, unexpected model
arguments, deployment policy denial, cancellation, and unregistering on disposal.

The minimum-runtime check was executed with a locally cached Node 22 binary:

```sh
npm exec --offline --yes --package=node@22 -- node --test \
  dist/tests/config.test.js dist/tests/git.test.js \
  dist/tests/runner.test.js dist/tests/acceptance.test.js
```

## Evidence and reproduction

Real acceptance reports contain the exact commands, config hash, expected
contracts, execution ids and times, stdout/stderr, byte counts, output digests,
Git base, changed paths, and retained diff. Reports are generated in each temporary
demo project; their printed locations can be inspected directly.

For this local delivery, copies of actual Node, mixed, Python, and installed-host
reports are retained under the ignored `.donegauge/validation/` directory. These
machine-local execution artifacts are deliberately excluded from the open-source
package and Git ignore rules prevent accidentally committing them. Re-run the
documented demos or installed-host script to create your own fresh evidence.

`npm run test:package` creates and removes a separate temporary npm consumer.
`npm run test:dsh-host` leaves its temporary home/project and evidence at the
printed path, then stops the isolated host. Existing Desktop/profile configuration
is not changed. No model/API request or paid service is used by these checks.

## Hosted CI verification

The public repository's [first hosted run](https://github.com/L8848-Li/DoneGauge/actions/runs/43867449510)
completed successfully for source commit `9feca35de780ca9134744eab975cfa82e29abf54`.
Both `ubuntu-latest` and `macos-latest` completed dependency installation,
`npm run check`, and `npm run test:package`. The package-install check now uses
`--prefer-offline` so that a fresh CI cache can fetch missing dependencies.
See [Actions](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml) for
later runs; do not infer a new commit's status from this historical result.

## Boundaries recorded at initial local delivery

- Ubuntu/macOS hosted CI has now passed as recorded above. Windows support remains incomplete.
- No manual live-model conversation or custom card was tested in DSH Desktop/Web.
  The installed CLI, loader, and actual tool execution were tested. PTC-specific
  agent calls and DSH versions other than 0.2.2-rc.3 remain unverified.
- No npm package or tagged GitHub release was published during initial local verification.
  The public source repository and its commit history are maintained on GitHub.
- Framework result parsing (including zero-test detection), automatic discovery,
  interactive init, previous-report browsing, source-line failure mapping,
  Codex/Claude adapters, cloud services, and automatic repairs are not implemented.

PASS certifies the configured command contract. It is not proof of comprehensive
coverage, test honesty, or production correctness. See [architecture](architecture.md)
for process permissions and snapshot limitations.

## Issue #1: JUnit checker (2026-11-16)

Local verification uses Node.js 24.16.0, Python 3.12.13, and pytest 9.2.0 in
a disposable virtual environment. Install the pinned test dependency first:

```sh
python3 -m venv /tmp/donegauge-pytest
/tmp/donegauge-pytest/bin/python -m pip install -r tests/requirements.txt
DONEGAUGE_PYTHON=/tmp/donegauge-pytest/bin/python npm run check
npm run test:package
node scripts/demo.mjs node-registration --junit --run
# Activate that virtual environment before the Python demo:
node scripts/demo.mjs python-cart --junit --run
```

The Node JUnit demo produced 3 PASS and the pytest cart demo 2 PASS, both VERIFIED.
The packed installation also ran 3 existing command checks and 3 JUnit checks
through its actual installed executable. The regression suite runs real Node and
pytest pass/failure/skip cases, Node todo, empty pytest collection (exit 5),
unmatched filters (including Node file wrappers), duplicate/parameterized names,
setup errors, and passing targets in a failed run. Separate synthetic XML tests
cover malformed/oversized reports, invalid UTF-8, DTD/entities, counts, limits,
class selection, minimum counts, retries, and hostile filesystem boundaries.
A timed-out process that wrote complete-looking XML remains ERROR; subsequent
runs cannot reuse its directory. Official DSH runtime tests compare all four
statuses, target counts, XML paths and execution ids with the saved JSON and
rendered terminal/Markdown output. Existing command regressions remain covered.

Demo console records are retained locally under ignored
`.donegauge/validation/issue-1/`; they identify disposable projects containing the
actual raw XML and reports. They are not distributed as canned acceptance evidence.
The CI matrix now installs pytest explicitly on Ubuntu and macOS. Historical CI
results above do not certify this increment; inspect its own commit workflow.
JUnit adds traceability and does not establish test honesty or coverage.

The first Ubuntu CI run caught immediate inode reuse after an evidence directory
was deleted and recreated. Collection now holds the original directory open
through execution and parsing, preventing inode recycling from disguising that
replacement. The existing replacement regression remains enabled on both systems.
