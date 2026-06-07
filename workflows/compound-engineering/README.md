# compound-engineering

`compound-engineering` is a safe, artifact-backed Atomic workflow inspired by EveryInc's MIT-licensed [Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin). It adapts the process vocabulary of brainstorm → plan → work → review → compound learning into an Atomic workflow graph.

Iteration 3 is still safe by default, but explicit implementation runners are active after approval: it can classify intake, scout repo memory, write brainstorm/plan/spec/review/learning artifacts, ask for human approval, and then either stop at handoff metadata or launch the selected child workflow. File-only review artifacts are read from disk before evidence parsing, Ralph receives the effective Git worktree root, and validated implementation can capture learning according to `learning_mode`.

## Safe posture

- no implementation before approval: the workflow always requires a human approval gate before emitting implementation handoff metadata.
- `runner=auto` resolves to `handoff-only` in iteration 3, so the default remains non-mutating.
- `runner=handoff-only` never launches a child workflow and omits command metadata unless there is a concrete command string.
- explicit `runner=goal` or `runner=ralph` runs after the human approval gate via Atomic built-ins.
- `goal` receives `objective`, `max_turns`, and `base_branch`.
- `ralph` receives `prompt`, `max_loops`, `base_branch`, strict boolean `create_pr`, and the effective Git worktree root derived with `git rev-parse --show-toplevel` when `git_worktree_dir` is non-empty.
- `create_pr` defaults to `false`; only strict boolean `true` can authorize Ralph PR creation.
- Review and scout stages are read-only by prompt contract; implementation completion is gated by the child workflow's structured `compound_engineering_evidence`, not by parent supplemental review or writer self-attestation.
- File-only review stages save Markdown artifacts; compact inline strings such as `Output saved to: ...` are not treated as review evidence.
- Child implementation evidence must be emitted in child outputs and/or a review artifact as a `compound_engineering_evidence` JSON block with all six sufficiency criteria, severity counts, and validation command summaries/exit codes. Missing, malformed, prose-only, blocked, conflicted, failed-validation, or P0/P1 evidence fails closed.
- After a validated implementation, `learning_mode=lightweight|full` writes one `docs/solutions/...` artifact, `off` writes nothing, and `ask` presents the existing lightweight/full/off selection.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `prompt` | required | Idea, spec/plan path, work request, review target, or learning-capture request. |
| `mode` | `auto` | `auto`, `brainstorm`, `plan`, `work`, `review`, or `compound-only`. |
| `runner` | `auto` | `auto`, `goal`, `ralph`, or `handoff-only`. Auto is handoff-only in iteration 3; explicit `goal`/`ralph` run after approval. |
| `max_loops` | `5` | Bound for approval revision loops and child runner loops (`goal` maps it to `max_turns`). |
| `base_branch` | `origin/main` | Base branch copied into implementation handoff metadata. |
| `git_worktree_dir` | `""` | Optional reusable worktree directory bound with `.worktreeFromInputs`; Ralph receives `""` when empty or the Git top-level root derived from `ctx.cwd` when non-empty. |
| `create_pr` | `false` | Strict `true` only; safe default is no PR creation. |
| `learning_mode` | `ask` | `ask`, `off`, `lightweight`, or `full`; honored for learning-only and post-validation implementation capture. |
| `memory_scope` | `repo` | `repo` scouts CE-style memory anchors; `none` skips repo memory. |

## Outputs

Required outputs: `status`, `mode`, `runner`, `approved`, `artifact_dir`, `manifest_path`, and `message`.

Optional outputs: `brainstorm_path`, `plan_path`, `spec_path`, `approved_spec_path`, `implementation`, `review_report_path`, and `learning_doc_path`.

Statuses are honest fixed strings: `complete`, `approved`, `handoff_ready`, `review_only`, `blocked`, `needs_human`, `rejected`, or `stopped`.

## Artifacts

The workflow writes a hidden run directory such as:

```text
./.compound-engineering-<run-id>/
  00-intake.md
  01-memory-context.md
  manifest.json
```

It may also write visible durable docs:

```text
docs/brainstorms/YYYY-MM-DD-<topic>.md
docs/plans/YYYY-MM-DD-<topic>.md
specs/YYYY-MM-DD-<topic>.md
docs/solutions/YYYY-MM-DD-<topic>.md
compound-engineering/YYYY-MM-DD-<topic>.md
```

Visible Markdown writes use exclusive create and preserve existing files with `-2`, `-3`, ... suffixes. The manifest records sanitized inputs, timestamps, final report path, and artifact paths.

## Examples

```text
/workflow compound-engineering prompt="Improve onboarding activation" mode=auto
/workflow compound-engineering prompt="specs/2026-06-05-rate-limit.md" mode=work runner=ralph create_pr=false
/workflow compound-engineering prompt="main..feature/auth" mode=review runner=handoff-only
/workflow compound-engineering prompt="Capture lessons from the last fix" mode=compound-only learning_mode=lightweight
```

## Attribution

This is not the upstream plugin. It is an Atomic workflow inspired by/adapting open-source Compound Engineering process language and severity vocabulary from EveryInc's Compound Engineering Plugin. The upstream project is MIT licensed; retain this notice when copying adapted workflow prompts or documentation.
