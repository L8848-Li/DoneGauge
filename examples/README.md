# Runnable examples

Run these from the DoneGauge checkout after `npm ci --ignore-scripts` and
`npm run build`:

```sh
node scripts/demo.mjs node-registration --run
node scripts/demo.mjs node-registration --mixed --run
node scripts/demo.mjs python-cart --run
```

Each command copies the fixture into a new temporary Git working tree and prints
its path. No Git state in this checkout is changed. Omit `--run` to prepare the
project and print exact preview/execution commands without running checks.

| Example           | Real checks                                                                                                                                          | Expected result             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Node registration | Duplicate normalized email rejection, distinct scrypt salt/hash storage, successful login and bad-password rejection.                                | 3 PASS; exit 0.             |
| Node mixed        | Duplicate rejection, a real assertion against an intentionally broken login implementation, no security-audit check, a nonexistent audit executable. | One of each status; exit 2. |
| Python cart       | Exact Decimal addition and rejection of negative prices via unittest.                                                                                | 2 PASS; exit 0.             |

The broken implementation and failing test are intentional fixtures. They are
not run by the all-pass configuration. No fabricated test output is used.
The Node account store is a small teaching fixture, not a production identity
system or a complete security audit. The Python project requires no external
packages and uses `-B` to avoid writing bytecode into the working tree.

## JUnit variants

```sh
node scripts/demo.mjs node-registration --junit --run
# Activate a Python virtual environment with pytest installed first:
node scripts/demo.mjs python-cart --junit --run
```

These use `donegauge.junit.json` and generate fresh XML for every criterion.
The Node variant selects three named registration assertions. The Python variant
uses pytest to run the existing two unittest cases and selects their exact names
and class. The original configurations remain available without `--junit`.
JUnit does not prove that the test design is correct or sufficiently covers the
product; inspect the assertions and retained raw reports.
