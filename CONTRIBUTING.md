# Contributing to DoneGauge

Thanks for helping make acceptance evidence easier to trust. Keep changes small,
explicit, and reproducible. DoneGauge does not generate tests and then declare its
own work accepted.

## Local development

Use Node.js 22 or newer, npm, Git, and Python 3 for the integration example.
The optional DSH integration requires Node.js 24.9+ and a [supported DSH version](docs/dsh.md).

```sh
npm ci --ignore-scripts
npm run build
python3 -m pip install -r tests/requirements.txt # use a virtual environment
npm run check
npm run test:package
```

`npm run format` formats source and documentation. `npm run lint` and
`npm run typecheck` can run independently. Tests use Node's built-in test runner.

JUnit integration tests require pytest (pinned in `tests/requirements.txt`); set
`DONEGAUGE_PYTHON` to select an existing virtual environment interpreter. Missing
pytest fails these tests rather than silently skipping acceptance coverage.
They create disposable Git repositories; fixture commits never touch your working
repository. All acceptance checks execute real local processes.

##  Pull requests

The [Protect main ruleset](https://github.com/L8848-Li/DoneGauge/rules/27529800)
requires an up-to-date pull request with all four GitHub Actions checks passing.

| Required check                     | Coverage                             |
| ---------------------------------- | ------------------------------------ |
| `Verify (ubuntu-latest, Node 22)`  | Core and CLI compatibility           |
| `Verify (ubuntu-latest, Node 24)`  | Full checks and package installation |
| `Verify (macos-latest, Node 24)`   | Full checks and package installation |
| `Verify (windows-latest, Node 24)` | Full checks and package installation |

Node 22 excludes the DSH integration tests, which require Node.js 24.9 or newer.
The rules apply to maintainers too, with no bypass list or required reviewer.
Direct pushes, force pushes, and deletion of `main` are blocked.

- Explain the user-visible problem, behavior after the change, and checks you ran.
- Add meaningful coverage for changed evidence, execution, configuration, or
  reporting behavior. Never replace failing assertions with fabricated reports.
- Preserve the separation between the standalone core and DSH adapter. Do not
  import DSH into the CLI or core.
- Keep `version: 1` configuration and `reportVersion: 1` backwards compatible;
  document format changes and use a new version for breaking changes.
- Keep shell execution explicit. Never interpolate configuration into a shell
  string or bypass execution authorization in an adapter.
- Do not add credentials, private project diffs, local report output, or personal
  paths. Review third-party licenses before adding dependencies.

By contributing, you agree to license your contributions under the MIT license.

## DSH validation

`tests/dsh.test.ts` assembles the official Cordis, tool registry, native executor,
and DoneGauge adapter without a model or API key. It exercises real check commands,
policy denial, approval mismatch, cancellation, and disposal.

For an installed DSH host, build first and run `npm run test:dsh-host`.
See [the DSH guide](docs/dsh.md) for host selection and isolation details. A DSH
compatibility change requires checking both the installed version and official
interfaces, then updating the exact peer/engine range and these tests.
