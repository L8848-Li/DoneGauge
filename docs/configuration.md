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
