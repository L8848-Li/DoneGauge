# V0.1 scope and integration research

Checked on 2026-11-16. The development directory was empty, with Node.js 24.16.0,
npm 11.13.0, Python 3.12.13, Git, and DeepSeek Harness Desktop installed. DSH was not
on `PATH`; its bundled official CLI reported **0.2.2-rc.3**. Existing Desktop
configuration was read only to identify installation context and was not modified.

## Official integration contract

Sources reviewed:

- [First plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)
- [Build a tool](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)
- [Tool authoring reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
- [Configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)
- [Packaging, profiles, peers, and local overlays](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

The supported plugin exports `name`, `inject`, and `apply`. The registry accepts
`defineTool()` with typed input/output schemas and a canonical JSON result;
rendering is separate. Cancellation must honor `exec.signal`. DSH bundles declare
`dsh.bundle.patch` and `engines.dsh`; local `--patch` overlays are supported.
The installed package declarations and actual official host were checked against
these documents. Compatibility is conservatively pinned to `0.2.2-rc.3`.

## Similar tools and differentiation

| Project                                                        | Existing value                                                                                                                                                   | DoneGauge boundary                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [dsh-qa](https://github.com/naodeng/dsh-qa)                    | Local QA workbench with projects, requirements, cases, controlled execution, evidence and gates; its current README identifies PolyForm Noncommercial licensing. | One small config for one coding task; standalone CLI and no QA database or UI. No source copied.                     |
| [dsh-file-review](https://github.com/left0ver/dsh-file-review) | DSH Web diff review, file comments, and undo/reapply workflow.                                                                                                   | Collect read-only Git context and associate explicit acceptance commands with evidence; no diff editing or undo.     |
| Existing test runners and CI                                   | Execute assertions and expose exits and logs.                                                                                                                    | Add requirement-to-command mapping, explicit evidence gaps, and one portable acceptance report; reuse those runners. |

Evidence management overlaps dsh-qa. DoneGauge's small standalone configuration,
agent-independent core, and explicit four-state report are the minimum useful
difference. It intentionally does not replicate test management or file review.

## V0.1 decisions and risks

- JSON Schema + Ajv: one shipped schema used by the runtime and editors; reject
  unknown keys and duplicate criterion ids with actionable errors.
- Node process APIs with `shell: false`: exact argv, no automatic command creation;
  explicit CLI authorization and pinned human-approved DSH config.
- Sequential checks: simple lifecycle and attributable evidence; no speculative
  multi-agent orchestration or concurrent workspace mutation.
- Generic exit/output contracts: framework independent, but cannot infer test
  coverage or detect every zero-test run. Examples require actual test-count
  evidence. Dedicated result parsers remain future work.
- Before/after Git snapshots: flag moving targets; full atomic snapshot isolation
  and signed attestation are outside scope.
- DSH changes quickly: pin exact compatibility, test official packages and the
  installed host, and report UI/model limitations separately.

See [validation](validation.md) for the actual release verification record.
