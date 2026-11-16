# Architecture

DoneGauge is one TypeScript package. The core has no model, cloud service, or DSH
dependency. CLI and DSH call the same `checkAcceptance()` function.

```text
src/
  core/
    config.ts       JSON Schema validation, path boundaries, config digest
    git.ts          Read-only Git baseline and working-tree snapshot
    runner.ts       Argument-array processes, deadlines, cancellation, output cap
    evaluator.ts    Deterministic contract evaluation
    check.ts        Preflight, sequential execution, evidence and final status
    types.ts        Versioned config and report contracts
  reporters/        Terminal, Markdown, JSON, exclusive report persistence
  adapters/dsh/     Official Cordis tool plugin and deployment approval
  cli.ts            init, check, config-hash
schema/             Editor and runtime configuration schema
tests/              Unit, Git, CLI, real projects, official DSH runtime
examples/           Node registration and Python cart
scripts/            Packed-install and installed-host smoke checks
```

## Evidence flow

1. Resolve the Git root, validate the config, and resolve all check directories.
2. An adapter may require the exact SHA-256 of the human-approved configuration.
3. Collect changes relative to the selected commit (default `HEAD`), including
   staged, unstaged, and untracked files. Unborn repositories use an empty tree.
4. Execute the configured checks sequentially when explicitly authorized.
5. Record unique evidence ids, argv, project-relative cwd, timestamps, process
   state, exit code/signal, retained output, original byte counts, and digests.
6. Evaluate each explicit contract and collect another Git/config snapshot.
7. Return an immutable-by-convention report value. Reporters present the same
   evidence and save new files under a unique run id.

No code path stages, commits, resets, switches, or cleans the user's repository.
Git external diff/text conversion helpers are disabled. Renames appear as
delete/add, avoiding ambiguous rename attribution. `.donegauge/` is reserved for
untracked report storage; tracked files there are still considered changes.

## Status semantics

| Status     | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| PASS       | The process finished and met its configured exit/output contract.                          |
| FAIL       | A normally completed process contradicted its contract.                                    |
| UNVERIFIED | There was no configured/executed check, or required text may have been truncated.          |
| ERROR      | A check could not start, timed out, was interrupted, or otherwise did not finish normally. |

Only a nonempty set of passing criteria with a stable workspace and no unsupported
Git states produces `VERIFIED`. Truncation is disclosed; a complete exit-only
contract can pass even when output is truncated. A missing required output token
in a truncated log cannot produce PASS. Global setup failures produce CLI exit 2
without inventing per-criterion execution records.

## Boundaries

The user's configuration asserts what command is relevant to which criterion.
DoneGauge cannot prove that the test itself is correct, comprehensive, or honest.
An exit-only contract verifies process success; use output expectations for a
specific assertion or test count. No LLM can assign PASS.

Commands run with the current user's local permissions and inherited environment
(except the internal `NODE_TEST_CONTEXT` marker, which would skip nested tests).
This is a process runner, not a security isolation system. It does not run tests
through DSH's bash sandbox. Approval of a config does not pin the source of tests,
dependencies, or executable files. Use trusted projects and reviewed commands.

POSIX process groups are terminated on timeout, cancellation, and foreground exit.
Windows can terminate only the immediate process in V0.1; Windows is not a verified
platform for this release. Background daemons are unsuitable acceptance commands.

Working-tree fingerprints detect before/after changes, including hashed untracked
contents and the complete streamed tracked diff even when the displayed diff is
capped. They are not an atomic filesystem snapshot or a cryptographic attestation.
Ignored files, dirty contents inside submodules, changes reverted between snapshots,
and adversarial concurrent writes require independent controls.

## Integration

The DSH adapter registers `donegauge_check` through `ctx.tools.register(defineTool())`.
It exposes no command/path arguments, requires a bound Git root and approved
config digest, honors `exec.signal`, and participates in DSH pre-execute policy.
It returns typed JSON with counts, criterion states, evidence ids, and local report
paths. It uses the default DSH tool card; no custom UI or model is required.

Future adapters should reuse the public core API and keep their authorization and
presentation concerns at the edge. V0.1 does not implement other agent adapters.
