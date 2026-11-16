# DeepSeek Harness integration

DoneGauge V0.1 uses the official Cordis tool API and is verified against
**DSH 0.2.2-rc.3** (Node.js 24.9+). The CLI/core do not require DSH. The adapter
does not need an API key or model to execute checks.

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

## Install the built bundle instead

```sh
# In DoneGauge source
npm run build
npm pack

# Explicit optional installation into a chosen DSH profile
dsh plugin --profile web add /path/to/DoneGauge/donegauge-0.1.0.tgz
```

This command intentionally changes that chosen profile. It is a user-run setup
step, not something the adapter does. The bundle contributes a `donegauge` row
with no approved project; it cannot execute tests until configured.

For an installed bundle, replace the source overlay with an override:

```yaml
- id: donegauge
  config:
    root: '/path/to/project'
    configPath: 'donegauge.json'
    approvedConfigSha256: 'paste-the-64-character-config-hash-here'
```

Then launch `dsh web --patch /path/to/that.patch.yml`. Use **one** of source insertion
or installed bundle override; two registrations of the same tool are not supported.
For uninstall: `dsh plugin --profile web remove donegauge`.

## Returned result and execution permission

The canonical JSON result contains run id, task, final status, four counts,
criterion statuses/reasons/evidence ids, report paths, and human-readable text.
The complete commands and logs remain in the local JSON/Markdown reports. Failing
checks are normal domain results; invalid invocation/configuration is a DSH tool
error. The tool uses the generic DSH card; there is no custom Web interface.

DSH's normal pre-execute tool policy can deny the call; cancellation propagates
through `exec.signal`. The pinned configuration is an additional explicit
deployment authorization. Checks execute as local host processes with your user
permissions. They do **not** inherit the DSH bash tool's sandbox implementation.
Inspect commands, tests, and dependencies in trusted projects before approving.

## Reproduce verification

```sh
npm test                # official runtime, native executor, real check commands
npm run test:dsh-host   # installed CLI/profile loader and actual tool dispatch
```

The host script uses a fresh temporary project, `DSH_HOME`, and profile. It installs
the local bundle there using the official `dsh plugin` command, checks composed
configuration, boots the host, calls `donegauge_check` through its native executor,
asserts three real passing checks and persisted evidence, then stops that host.
No model or network API call is made. The temporary host evidence is retained at
the printed path for inspection; remove that temporary directory when finished.

On macOS it defaults to the official app in `/Applications/DeepSeek Harness.app`.
For a CLI already on PATH:

```sh
DONEGAUGE_DSH_EXECUTABLE=dsh DONEGAUGE_DSH_CLI_ENTRY='' npm run test:dsh-host
```

For a CLI JS entry executed by Node, set `DONEGAUGE_DSH_EXECUTABLE` to your Node
executable and `DONEGAUGE_DSH_CLI_ENTRY` to the CLI entry. The script deliberately
requires the verified version; it will not claim compatibility with a new release.

## Verified boundary

The actual installed 0.2.2-rc.3 CLI, official profile loader, registry, native
executor, local bundle, and real checks were exercised. Automated tests also cover
denial, cancellation, missing approval, arbitrary arguments, stale config approval,
and plugin unload. A manual conversation where a live model selects the tool in
Desktop/Web has not been performed. PTC-specific agent execution and other DSH
versions have not been validated. Existing project/profile restrictions may hide
the tool; inspect those rather than bypassing policy.

See the [official tool reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
and [plugin packaging guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).
