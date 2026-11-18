# Configuration and reports

`donegauge.json` is strict JSON. The same [JSON Schema](../schema/donegauge.schema.json)
is used at runtime and can be selected in your editor. Unknown fields are errors.

```json
{
  "version": 1,
  "task": "Reject duplicate email during registration",
  "base": "HEAD",
  "criteria": [
    {
      "id": "duplicate-email",
      "description": "Duplicate email is rejected",
      "check": {
        "command": [
          "python3",
          "-B",
          "-m",
          "unittest",
          "tests.test_registration.TestRegistration.test_duplicate"
        ],
        "cwd": ".",
        "timeoutMs": 30000,
        "maxOutputBytes": 65536,
        "expect": { "exitCode": 0, "stderrIncludes": "OK" }
      }
    },
    {
      "id": "security",
      "description": "Independent security review is complete"
    }
  ]
}
```

## Fields

| Field                         | Meaning                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `version`                     | Required integer `1`.                                                              |
| `task`                        | Required nonblank task description, up to 500 characters.                          |
| `base`                        | Optional existing Git commit/ref; defaults to `HEAD`, overridden by `--base`.      |
| `criteria`                    | 1–100 criteria with unique ids.                                                    |
| `id`                          | 1–80 letters/digits/dots/underscores/hyphens, starting with a letter/digit.        |
| `description`                 | Required nonblank acceptance condition, up to 2000 characters.                     |
| `check`                       | Optional. Omit when there is no verification evidence yet.                         |
| `check.command`               | Required argv array: executable, then each argument as a separate string.          |
| `check.cwd`                   | Existing directory within the Git root, including symlink resolution; default `.`. |
| `check.timeoutMs`             | 1–600000; default 30000.                                                           |
| `check.maxOutputBytes`        | 256–1048576 retained bytes across stdout and stderr; default 65536.                |
| `check.expect.exitCode`       | Expected normal exit code, 0–255; default `0`.                                     |
| `check.expect.stdoutIncludes` | Optional nonempty literal text that must appear in retained stdout.                |
| `check.expect.stderrIncludes` | Optional nonempty literal text that must appear in retained stderr.                |

When both output expectations are present, both must match. They are literal,
case-sensitive substrings, not regular expressions. An explicitly expected nonzero
exit code can pass (useful when testing error handling). Startup errors, signals,
and timeouts always produce ERROR; they never satisfy an exit-code expectation.
Configured cwd paths are relative to the Git root, even when the config file is
in a subdirectory. Config files must also stay inside that root.

The configuration is limited to 1 MiB. All check directories are validated before
the first command starts. Relative executable paths are resolved by the operating
system against the check's cwd; PATH lookup is used for names such as `node`.

## Commands and authorization

`check` previews. `check --allow-run` explicitly authorizes this config's commands
for one run. No shell is started implicitly. For a package script use, for example,
`["npm", "test", "--", "--runInBand"]` on supported POSIX platforms. If a shell
is deliberately configured, such as `["sh", "-c", "..."]`, you are explicitly
authorizing that shell and its code. DoneGauge does not generate shell commands.

On Windows, a command whose executable explicitly ends in `.cmd` or `.bat`
uses the system `cmd.exe` with each argument quoted. The report records that
invocation. Batch arguments containing quotes, percent signs or line breaks,
and batch runs from a UNC working directory, require a native executable or
an explicit JavaScript entry such as `["node", "path/to/npm-cli.js", "test"]`.
Other executables use the native argument array. Timeout and cancellation ask
Windows `taskkill` to terminate the identified process tree. Processes that
detach or outlive an already-exited parent can require separate cleanup.

For Python, configure your intended interpreter (`python3` or an explicit virtual
environment path). For Node's test runner, request TAP output and a positive
expected count such as `"stdoutIncludes": "# pass 1"`. This catches accidentally
skipped or zero-test runs in the included examples; generic commands cannot prove
framework-level coverage.

The default environment is inherited, so tests can use existing local tools and
virtual environments. No environment or credentials are enumerated into reports;
test output may still contain sensitive material. Review before sharing.

## Output and exit codes

Reports are newly created at `.donegauge/runs/<run-id>/report.json` and `report.md`.
The directory and files use private permissions where supported. Existing run
directories and report-directory symlinks are refused. `--output-dir` selects a
different in-project directory; add it to `.gitignore` if it is not `.donegauge`.

The JSON contract has `reportVersion: 1`, tool version, task/run/config identity,
Git baseline and changed files/diff/fingerprint, run times, one result per criterion,
evidence or `null`, summary counts, warnings, and a final status. Evidence retains
the exact command, cwd, execution state, exit/signal, timing, logs, truncation flag,
and original byte counts. JSON retains raw output; terminal/Markdown remove control
sequences, and Markdown fences prevent log text from becoming document markup.

| Exit      | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| 0         | All criteria PASS, stable workspace, final status VERIFIED.                        |
| 1         | FAIL/UNVERIFIED or another review condition, with no check execution ERROR.        |
| 2         | At least one check ERROR, or invalid configuration/Git/setup/report-write failure. |
| 130 / 143 | CLI interrupted with SIGINT / SIGTERM; in-flight work was stopped.                 |

An execution ERROR is not proof that the feature itself is faulty. A FAIL is a
contradiction of the configured contract; inspect its assertion and environment
before attributing a product defect. No report is synthesized if global setup
cannot establish a valid run.

## JUnit checks

Use `kind: "junit"` to verify exact test names from a report generated by this
command. Omitted `kind` and explicit `kind: "command"` retain the original
exit/output contract. The two strict schema branches reject mixed options:
JUnit does not accept `expect`, and command checks do not accept `junit`.
Old DoneGauge builds reject the new fields instead of silently weakening them.

```json
{
  "version": 1,
  "task": "Reject duplicate email",
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
          "registration.test.mjs"
        ],
        "junit": {
          "file": "{evidenceDir}/junit.xml",
          "tests": [
            { "name": "duplicate email is rejected", "className": "test" }
          ],
          "minExecuted": 1
        }
      }
    }
  ]
}
```

For [pytest's JUnit output](https://docs.pytest.org/en/stable/how-to/output.html#creating-junitxml-format-files),
use an argv array such as
`["python3", "-B", "-m", "pytest", "-p", "no:cacheprovider", "--junitxml={evidenceDir}/junit.xml", "test_cart.py"]`.
Node's [JUnit reporter](https://nodejs.org/docs/latest-v24.x/api/test.html#test-reporters)
and pytest are exercised with real passing and failing assertions in the test suite.
Runnable configurations are included as `donegauge.junit.json` in both examples.

| Field               | Contract                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `junit.file`        | One `.xml` file under the literal `{evidenceDir}/` prefix; no absolute paths, empty/dot/traversal segments or backslashes. |
| `junit.tests`       | 1–1000 distinct selectors, each with an exact, case-sensitive `name` and optional exact `className`.                       |
| `junit.minExecuted` | Minimum distinct executed **selected** test cases, 1–50000; defaults to 1. Unrelated tests cannot satisfy it.              |

Each selector must match exactly one leaf testcase. List parameterized names
explicitly (for example `test_total[decimal]`). A missing name, a duplicate without
a disambiguating class, skip/todo, Node's file-path wrapper, or unsupported retry
metadata requires review. Suites are containers and never count as assertions.
If several selectors select the same case, it counts once toward `minExecuted`.
Some Node.js reporters omit source locations. When the report contains Node's
test-runner diagnostics, a top-level `test` record named like a JavaScript or
TypeScript file without a source location is ambiguous and requires review. Give
the assertion its own descriptive name to distinguish it from a file wrapper.

Each authorized check gets a new empty private directory at
`.donegauge/evidence/<run-id>/<check-id>/`. Only the fixed `{evidenceDir}` token is
replaced in argv; there is no shell expansion or general template language.
Reports are collected after process completion, and must be normal files under
that directory. Symlinks, hard links, replaced directories, oversized reports and
observed writes during reading are rejected. No old project report is deleted or
reused. Preview and rejected config approval never allocate execution evidence.
`--output-dir` changes the JSON/Markdown destination; raw XML always stays under
`.donegauge/evidence/` and should be kept with those reports.

Parsing accepts UTF-8 XML, `testsuite`/`testsuites`, nested suites, CDATA,
`failure`/`error`/`skipped`, XML built-in and numeric entities. DTDs, entity
declarations and other processing instructions are rejected; the parser loads
no external resources. Fixed limits are **10 MiB**, **50 element levels**, and
**50000 testcases**; SAX token buffers are also bounded (64 KiB). Malformed XML,
invalid numeric values, contradictory outcomes and inconsistent declared suite
counts produce ERROR. Unsupported status/extension/retry markers are disclosed
and prevent PASS. Missing `file`, `line`, and duration remain `null`.

Evaluation preserves both the original process outcome and every parsed test
record. Priority is: incomplete process/report or setup/teardown error → ERROR;
a uniquely selected assertion failure → FAIL; missing/ambiguous/skipped or
unsupported targets and unmet minimum count → UNVERIFIED. Otherwise nonzero
process exit → ERROR, even if the selected tests passed. Only complete evidence,
all uniquely selected tests passing, sufficient executed targets, and exit 0
produce PASS. Unrelated assertion failures cannot make a target FAIL; conflicts
between those failures and exit 0 produce ERROR. A valid zero-case pytest report
with exit 5 remains UNVERIFIED. Workspace mutation still makes the overall result
REVIEW REQUIRED.

`reportVersion: 1` is extended with optional `testEvidence` on JUnit criteria:
parser version, source XML path/bytes/SHA-256, run id, process evidence id,
config digest, Git base/head/fingerprint, all normalized cases, selector match
indices, counts, review problems and collection error. Cases include suite path,
class/name, outcome, duration, test file/line, XML line, and failure details.
Terminal and Markdown show selected results and execution counts; JSON retains
all records. DSH returns the same criterion status, execution id, target counts,
XML path and selected test outcomes, with full records in the saved reports.

JUnit strengthens traceable evidence. It cannot prove correct test design,
sufficient coverage, or that the test process did not copy or fabricate XML.
These filesystem checks and Git fingerprints are not atomic isolation or signed
attestations. There is one command per criterion, with no cross-criterion cache
or retry orchestration. Review test sources and failure details independently;
a test location or stack frame is not a verified product-code root cause.
