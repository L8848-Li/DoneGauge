# DoneGauge

**Acceptance checks for AI-assisted coding**

Write an acceptance criterion such as “Duplicate email is rejected” and link it
to an exact test name. DoneGauge runs the checks you approve and saves the Git
changes, command logs, and fresh JUnit XML alongside the result. You can see
which criteria passed and which still need review.

[简体中文](README.zh-CN.md) · [Try the demo](#three-minute-junit-demo) ·
[Use with DeepSeek Harness](#deepseek-harness) · [Configuration](docs/configuration.md) ·
[Distribution and market status (中文)](docs/release.zh-CN.md)

## Install from this source checkout

The standalone CLI requires **Node.js 22+**, npm, and Git. It runs locally
without an API key. The optional [DeepSeek Harness adapter](#deepseek-harness)
has its own runtime requirements.

```sh
git clone https://github.com/L8848-Li/DoneGauge.git
cd DoneGauge
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

DoneGauge is currently available to build from source. For use in another
project, pack this checkout and install the local tarball:

```sh
# In the DoneGauge checkout
npm pack

# In your project, using the actual tarball path
npm install --save-dev /path/to/DoneGauge/donegauge-0.1.0.tgz
npx --no-install donegauge --version
```

## Start with a requirement, not a config file

Run `npx --no-install donegauge review` in a trusted Git project. Enter requirements separated by semicolons, inspect discovered test names, file locations and commands, and type `edit` to add or change an item, select another test or leave it for manual review. Press Enter to save without testing or type `run` to approve the displayed plan. Only unique normalized test-name matches are preselected; keyword matches are suggestions, not coverage.

For non-interactive use, `donegauge review --task 'login after registration; weak password feedback' --json` returns a local draft ID and digest without running any tests. Reopen with `--draft ID` or run the reviewed plan with `--draft ID --approve DIGEST`. Changes to the draft or selected test files invalidate the digest. Unbound and excluded requirements stay `UNVERIFIED`. Drafts live under `.donegauge/reviews/`; existing configuration is never overwritten.

Discovery reads bounded, Git-visible `*.test.*`/`*.spec.*` JS files using `node:test` and `test_*.py`/`*_test.py` files. Python execution uses an already installed pytest (`DONEGAUGE_PYTHON` selects the interpreter). No model, upload, dependency installation or test generation is involved. This is not a sandbox: approved test files and dependencies execute with your local permissions.

## Three-minute JUnit demo

After building the checkout, run three named Node.js tests in a disposable Git
repository:

```sh
node scripts/demo.mjs node-registration --junit --run
```

Expect **3 PASS** for duplicate email rejection, salted password storage, and
login. Open `report.md` at the printed path inside the temporary project to
see each selected test name and the path to its fresh JUnit XML. Omit `--run`
to prepare the example and review the commands before running them.

To see all four states using real execution results:

```sh
node scripts/demo.mjs node-registration --mixed --run
```

The mixed configuration tests an intentionally regressed login implementation,
leaves one condition without a check, and invokes a missing audit executable.
Expect one criterion in each status and exit code 2.

The [runnable examples](examples/README.md) include a Python cart with both
`unittest` and pytest/JUnit setups.

## DeepSeek Harness

DoneGauge registers `donegauge_check` through the official DSH plugin API. The
verified hosts are **DSH 0.2.2-rc.3 and 0.2.2-rc.4**, which require Node.js 24.9 or later.
Follow the [DSH setup](docs/dsh.md) to load from a source checkout or install a
built bundle. Market submission status is recorded in the [release guide](docs/release.zh-CN.md).

Review the target project's `donegauge.json` and get its SHA-256 digest:

```sh
node /path/to/DoneGauge/dist/src/cli.js config-hash --cwd /path/to/project
```

Bind the absolute Git root and that digest in a local DSH patch. Send this
request in DSH.

> Use `donegauge_check` to verify this project's configured acceptance criteria.

The tool call uses `{}`. The local patch controls the project and commands. A
configuration change requires a fresh review and digest before tests can run.
Expand the tool group in Desktop or Web for the four status counts, per-criterion
evidence and buttons to open the local reports. The
[verification record](docs/validation.md#desktop-card-and-cancellation-verification-2026-11-18)
covers real Desktop calls, expired approvals, policy denials and cancellation.

## Use it in your project

```sh
npx --no-install donegauge init
```

Edit the generated config to connect a criterion to a test your project already
has. `init` preserves existing files and leaves execution for you to approve.

```json
{
  "version": 1,
  "task": "Reject duplicate email during registration",
  "criteria": [
    {
      "id": "duplicate-email",
      "description": "Duplicate email is rejected",
      "check": {
        "kind": "junit",
        "command": [
          "node",
          "--test",
          "--test-reporter=junit",
          "--test-reporter-destination={evidenceDir}/junit.xml",
          "--test-name-pattern=duplicate email",
          "registration.test.mjs"
        ],
        "junit": {
          "file": "{evidenceDir}/junit.xml",
          "tests": [
            { "name": "duplicate email is rejected", "className": "test" }
          ]
        }
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

The first command previews the checks and reports UNVERIFIED. The next two
execute approved checks with your local user permissions and environment.
Write commands as an executable followed by individual arguments and review
the commands and project code before execution. For exit-code or log-only
checks, use a [command check](docs/configuration.md#fields).

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

| Status     | Interpretation                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| PASS       | A selected JUnit test passed with complete fresh evidence, or a command met its exit/output contract. |
| FAIL       | The completed command contradicted its contract, or a selected JUnit test failed.                     |
| UNVERIFIED | No sufficient evidence: missing check, preview, or required output lost to truncation.                |
| ERROR      | Execution failed to start, timed out, was interrupted, or otherwise failed to complete normally.      |

For JUnit, PASS also requires uniquely selected executed tests and complete fresh
XML; missing, skipped, ambiguous, or file-wrapper targets remain UNVERIFIED. See
[JUnit status precedence](docs/configuration.md#junit-checks).

Exit codes: **0** all criteria verified against a stable working tree; **1** review
required; **2** configuration, Git, report-writing, or check execution errors.
Interrupts use 130/143. A workspace change during verification always requires
review, even if the commands passed. Global setup errors do not create fake check
evidence.

## Known limits

- You choose which checks establish each condition. Exit code 0 alone proves
  only the declared process contract. It cannot prove test quality or coverage.
  Prefer specific output/test-count expectations to detect empty test runs.
- JUnit supports exact names and optional class names, one report and command per
  criterion. Static review discovery can miss dynamic tests. No test generation, failure-to-source mapping,
  cross-criterion cache, retry orchestration, or score.
- Tests run sequentially and can modify local files. Before/after fingerprints
  flag observed changes but are not atomic snapshots or signed attestations.
  Ignored files and dirty submodule contents are not fully fingerprinted.
- Logs default to 64 KiB per check; the displayed Git diff is capped at 256 KiB.
  Metadata that exceeds its bound stops the run rather than silently omitting files.
- Renames are reported as delete/add. No remote fetch or automatic base selection.
- [Hosted CI](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml)
  verifies the CLI on Ubuntu, macOS and Windows with Node 24, plus the Ubuntu
  core/CLI suite on Node 22. See the [Windows batch and process limits](docs/configuration.md#commands-and-authorization).
- DSH checks run with host user permissions. Review the [execution and approval
  details](docs/dsh.md#returned-result-and-execution-permission) before enabling a project.

## Development and roadmap

```sh
python3 -m pip install -r tests/requirements.txt # preferably in a virtual environment
npm run check
npm run test:package
npm run test:dsh-host  # optional: requires an installed compatible DSH
```

See [CONTRIBUTING](CONTRIBUTING.md) and the [actual validation record](docs/validation.md).

See the [open issues](https://github.com/L8848-Li/DoneGauge/issues) for current
work and the [architecture notes](docs/architecture.md) for implementation details.

## License

[MIT](LICENSE). Runtime dependency notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
