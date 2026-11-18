# DeepSeek Harness integration

DoneGauge uses the official Cordis tool API. The packaged plugin was verified
with **DSH 0.2.2-rc.3 and 0.2.2-rc.4** (Node.js 24.9+). The standalone CLI
requires Node.js 22+ and can run the same acceptance checks independently.

## Local source overlay

Build DoneGauge, review your target project's `donegauge.json`, and compute its
digest. Substitute your actual directories:

```sh
node /path/to/DoneGauge/dist/src/cli.js config-hash --cwd /path/to/project
```

Create a local overlay file, for example `donegauge.local.patch.yml`:

```yaml
- insert:
    - id: donegauge
      name: '/path/to/DoneGauge/dist/src/adapters/dsh/index.js'
      config:
        root: '/path/to/project'
        configPath: 'donegauge.json'
        approvedConfigSha256: 'paste-the-64-character-config-hash-here'
```

Launch your compatible DSH CLI with that overlay:

```sh
dsh --version
dsh web --patch /path/to/donegauge.local.patch.yml
```

This uses the official supported `--patch` path and does not edit your existing
DSH home/profile configuration. The project `root` must be its Git root, rather
than a subdirectory. Keep approval overlays human-owned; do not let the agent
approve a changed configuration. Updating `donegauge.json` requires reviewing it,
recomputing its digest, and updating the overlay before further checks.

Ask DSH: **Use donegauge_check to verify this project's configured acceptance
criteria.** The call arguments are `{}`. Unexpected arguments, missing approval,
and changed config digests are rejected before commands run. The adapter does not
automatically run after every coding turn.

## Install a prebuilt bundle

```sh
# In the DoneGauge checkout, if you need to build the archive locally
npm pack

# Explicit optional installation into a chosen DSH profile
dsh plugin --profile web add /path/to/DoneGauge/donegauge-0.1.0.tgz --ignore-scripts
```

This installs into the chosen Web profile. In Desktop, use the profile managed
from its Plugins page. New installations contribute a `donegauge` row with an
empty config. Bind a project and approved digest before running checks.

For an installed bundle, replace the source overlay with an override:

```yaml
- id: donegauge
  config:
    root: '/path/to/project'
    configPath: 'donegauge.json'
    approvedConfigSha256: 'paste-the-64-character-config-hash-here'
```

For Web, launch `dsh web --patch /path/to/that.patch.yml`. To persist the settings
in a Web or Desktop profile, merge the override into that profile's existing
`cordis.patch.yml` under `DSH_HOME/profiles/<profile>/`. Use the override for an
installed tarball and the insertion for a local checkout. Run
`dsh plugin --profile web remove donegauge` to uninstall from Web.

To try named JUnit checks, run `node scripts/demo.mjs node-registration --junit`
from a built checkout. Use the printed temporary project as `root`, set
`configPath: donegauge.junit.json`, and pass `--config donegauge.junit.json` when
computing the digest with `config-hash`.

## Returned result and execution permission

The canonical JSON result contains run id, task, final status, four counts,
criterion statuses/reasons/evidence ids, report paths, and human-readable text.
The complete commands and logs remain in the local JSON/Markdown reports. Failing
checks are normal domain results; invalid invocation/configuration is a DSH tool
error. In Desktop and Web, expand the tool-call group to see DoneGauge's
acceptance card. Use the workspace that matches the approved Git root so the
report and JUnit buttons open files in that project. Earlier recorded results
with text-only metadata remain readable in the tool group.

DSH's normal pre-execute tool policy can deny the call; cancellation propagates
through `exec.signal`. The pinned configuration is an additional explicit
deployment authorization. Checks execute as local host processes with your user
permissions. They do **not** inherit the DSH bash tool's sandbox implementation.
Inspect commands, tests, and dependencies in trusted projects before approving.

## Reproduce verification

```sh
npm test                # official runtime, native executor, real check commands
npm run test:dsh-host   # packaged plugin in an actual DSH host
```

The host script uses a fresh temporary project, `DSH_HOME`, and profile. It packs
the bundle or accepts an existing archive with `npm run test:dsh-host -- /path/to/bundle.tgz`.
It installs that archive with lifecycle scripts disabled, boots the host,
dispatches `donegauge_check` through the native executor, and verifies three
named tests with saved JUnit XML. Package managers may download dependencies
during installation. The host uses no model API and stops after the test. The
script prints the temporary path containing the result and reports.

On macOS it defaults to the official app in `/Applications/DeepSeek Harness.app`.
For a CLI already on PATH:

```sh
DONEGAUGE_DSH_EXECUTABLE=dsh DONEGAUGE_DSH_CLI_ENTRY='' npm run test:dsh-host
```

For a CLI JS entry executed by Node, set `DONEGAUGE_DSH_EXECUTABLE` to your Node
executable and `DONEGAUGE_DSH_CLI_ENTRY` to the CLI entry. The bundle's
`engines.dsh` specifies the two supported versions.

## Verified boundary

The packaged bundle was installed through the official CLI in both supported
versions, and the tool ran real tests through the native executor. Automated tests also cover
denial, cancellation, missing approval, arbitrary arguments, stale config approval,
and plugin unload. A live Desktop conversation also exercised tool selection,
four mixed results, both report links, stale-approval refusal, deployment
policy and cancellation. See the
[verification record](validation.md#desktop-card-and-cancellation-verification-2026-11-18).

See the [official tool reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
and [plugin packaging guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).
