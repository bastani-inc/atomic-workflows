# compound-engineering

`compound-engineering` is a safe, artifact-backed Atomic workflow inspired by EveryInc's MIT-licensed [Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin). It adapts brainstorm → plan → work → review → compound learning into an Atomic workflow graph.

Iteration 4 remains safe by default while supporting explicit child runners after approval. The workflow classifies the request, scouts lightweight repo memory, writes file-backed brainstorm/plan/spec/review/learning artifacts, requires human approval, then either stops at handoff metadata or launches the selected declared child workflow.

## Core patterns

- **Classify and act:** `mode=auto` routes vague/product prompts to brainstorm, short concrete work prompts such as `Fix auth bug`, `Add API tests`, or `Fix CLI config` to work, plan/spec paths to work, review targets to review, and learning requests to compound-only.
- **Human-gated implementation:** no implementation before approval; no implementation runner starts before the approval prompt returns Approve.
- **Bounded loop:** `max_loops` is an integer bound for approval revisions and child runner loop metadata (`goal` maps it to `max_turns`).
- **Artifact handoffs:** specs, plans, final reports, learning docs, manifests, and child review reports stay file-backed; compact pointers must be read from disk before they count.
- **Adversarial verification:** parent completion depends on declared child outputs plus review artifacts, not writer prose or supplemental parent self-review.
- **Declared child contracts:** `goal` evidence is normalized only from declared Goal outputs; `ralph` evidence is normalized only from declared Ralph outputs. Unknown child keys are retained only as diagnostics (`unknown_child_output_keys`).
- **Fail-closed evidence extraction:** completion requires either a valid native builtin review-round JSON artifact or typed `review_evidence` in `review_report_path`, `review_report`, or another declared review artifact fallback (`ledger_path`, `implementation_notes_path`). Native review-round artifacts are parsed before wrapper `review_evidence` fallback only when the artifact has the native shape (`turn` or `iteration`, plus its own `reviews` property). Wrapper metadata such as `{ "iteration": 1, "review_evidence": { ... } }` remains wrapper evidence. Generic `result` prose is diagnostic only. Legacy `compound_engineering_evidence` and its entire subtree are ignored. Prose-only, malformed, missing, blocked, conflicted, stale, failed-validation, malformed stop-flag, reviewer-error, unknown-severity, or P0/P1 evidence cannot complete.
- **Strict numeric evidence:** validation `exit_code` values and `severity_counts.p0/p1/p2/p3` must be non-negative integers (and `exit_code` must be exactly `0` to pass). Fractional, non-finite, negative, string-coerced, malformed, or non-zero values fail closed; passing summaries do not override a bad `exit_code`. When no `exit_code` is present, explicit summary-only zero forms (`0 failures`, `zero failures`, `no failures`, `0 errors`, `zero errors`, `no errors`) can satisfy validation if there is no contradictory failure/error evidence.
- **Guard exits:** true precondition/child-exit guards use `ctx.exit` when available. Child-exit receipts include explicit `gate_child_run_completion` metadata with `state: "child_exited"`, `exit_status`, and `exit_reason`. Atomic child `cancelled` and `skipped` statuses are preserved in `ctx.exit.status` while the schema-compatible domain output status is `stopped`; blocked or unknown child exits use `ctx.exit.status="blocked"` and domain status `blocked`. Normal artifact-producing domain outcomes still return statuses such as `handoff_ready`, `needs_human`, `rejected`, `stopped`, and `complete`.

## Safe posture

- `runner=auto` resolves to `handoff-only`, so the default remains non-mutating.
- `runner=handoff-only` never launches a child workflow and omits command metadata unless there is a concrete command string.
- explicit `runner=goal` or `runner=ralph` runs only after the human approval gate via Atomic built-ins.
- `goal` receives `objective`, `max_turns`, and `base_branch`; completion requires `approved === true` and `status === "complete"`.
- `ralph` receives `prompt`, `max_loops`, `base_branch`, strict boolean `create_pr`, and the effective Git worktree root derived with `git rev-parse --show-toplevel` when `git_worktree_dir` is non-empty; completion requires `approved === true`.
- `create_pr` defaults to `false`; only strict boolean `true` can authorize Ralph PR creation.
- Review/scout stages are read-only by prompt contract. Implementation completion is gated by structured review evidence from declared child outputs/artifacts.
- Legacy or undeclared `compound_engineering_evidence` child output is ignored as completion evidence, including all nested descendants; sibling declared `review_evidence` can still complete.
- After validated implementation, `learning_mode=lightweight|full` writes one `docs/solutions/...` artifact, `off` writes nothing, and `ask` presents the lightweight/full/off selection.

## Child review evidence artifact shape

A child review report can include JSON like:

```json
{
  "review_evidence": {
    "independent": { "satisfied": true, "evidence": "Fresh internal review after implementation." },
    "acceptance_mapped": { "satisfied": true, "evidence": "Each approved acceptance criterion was checked." },
    "diff_aware": { "satisfied": true, "evidence": "Changed files and git diff were inspected." },
    "validation_backed": {
      "satisfied": true,
      "evidence": "Validation passed.",
      "commands": [{ "command": "bun test", "exit_code": 0, "summary": "passed" }]
    },
    "risk_aware": { "satisfied": true, "evidence": "Residual risks documented." },
    "fresh": { "satisfied": true, "evidence": "Collected after the final diff." },
    "severity_counts": { "p0": 0, "p1": 0, "p2": 0, "p3": 0 }
  }
}
```

Every satisfied criterion needs explicit support; validation commands must have integer zero exit codes or explicit passing summaries. If an `exit_code` field is present it must be exactly integer `0`; summaries are used only when no exit code is present. Accepted zero-count summaries include `0 failures`, `zero failures`, `no failures`, `0 errors`, `zero errors`, and `no errors`; contradictions such as `0 failures, 1 error` fail closed. Severity counts must be integer counts, not rounded or coerced. Optional stop flags `blocked`, `conflicted`, and `validation_failed` must be booleans when present; `false` is valid, while strings/numbers/null fail closed.

Wrappers may include harmless metadata next to `review_evidence`; for example, `{ "iteration": 1, "review_evidence": { ... } }` is treated as wrapper evidence rather than a malformed native round.

Native Goal/Ralph review-round artifacts are also accepted before wrapper evidence fallback when they have this JSON shape:

```json
{
  "iteration": 2,
  "reviews": [
    {
      "reviewer": "native-reviewer",
      "artifact_path": "/path/to/review.json",
      "decision": {
        "overall_correctness": "patch is correct",
        "stop_review_loop": true,
        "findings": []
      }
    }
  ]
}
```

Native review-round classification requires `turn` or `iteration` plus the artifact's own `reviews` property. Native review-round completion requires a non-empty `reviews` array, no root-level/review-level/decision-level `reviewer_error`, `overall_correctness: "patch is correct"`, any present `stop_review_loop` set to `true`, and no P0/P1 findings. Findings must use known integer/string severities P0-P3; unknown or malformed severities fail closed. The evidence trace records `source_kind: "native_goal_review_round"` or `"native_ralph_review_round"`.

Prose fallback is negation-aware for hard-stop diagnostics: phrases such as `not blocked`, `no blockers`, `no blocking issues`, `not unable to review`, `no conflicting evidence`, `no conflicts`, `not conflicted`, and `no evidence conflicts` do not set blocked/conflicted flags, while positive blocker/conflict prose still does. Prose-only child evidence still cannot complete implementation.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `prompt` | required | Idea, spec/plan path, work request, review target, or learning-capture request. |
| `mode` | `auto` | `auto`, `brainstorm`, `plan`, `work`, `review`, or `compound-only`. |
| `runner` | `auto` | `auto`, `goal`, `ralph`, or `handoff-only`. Auto is handoff-only; explicit `goal`/`ralph` run after approval. |
| `max_loops` | `5` | Integer bound for approval revision loops and child runner loops. |
| `base_branch` | `origin/main` | Base branch copied into implementation handoff metadata. |
| `git_worktree_dir` | `""` | Optional reusable worktree directory bound with `.worktreeFromInputs`; Ralph receives `""` when empty or the Git top-level root derived from `ctx.cwd` when non-empty. |
| `create_pr` | `false` | Strict `true` only; safe default is no PR creation. |
| `learning_mode` | `ask` | `ask`, `off`, `lightweight`, or `full`; honored for learning-only and post-validation implementation capture. |
| `memory_scope` | `repo` | `repo` scouts CE-style memory anchors; `none` skips repo memory. |

## Outputs

Required outputs: `status`, `mode`, `runner`, `approved`, `artifact_dir`, `manifest_path`, and `message`.

Optional outputs: `brainstorm_path`, `plan_path`, `spec_path`, `approved_spec_path`, `implementation`, `review_report_path`, and `learning_doc_path`.

Statuses are fixed strings: `complete`, `approved`, `handoff_ready`, `review_only`, `blocked`, `needs_human`, `rejected`, or `stopped`.

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

Visible Markdown writes use exclusive create and preserve existing files with `-2`, `-3`, ... suffixes. The `compound-engineering/` final report directory is generated and gitignored; hidden `/.compound-engineering-*/` run directories remain generated and gitignored separately. The manifest records sanitized inputs, timestamps, final report path, and artifact paths.

## Examples

```text
/workflow compound-engineering prompt="Improve onboarding activation" mode=auto
/workflow compound-engineering prompt="Fix auth bug" mode=auto
/workflow compound-engineering prompt="specs/2026-06-05-rate-limit.md" mode=work runner=ralph create_pr=false
/workflow compound-engineering prompt="main..feature/auth" mode=review runner=handoff-only
/workflow compound-engineering prompt="Capture lessons from the last fix" mode=compound-only learning_mode=lightweight
```

## Attribution

This is not the upstream plugin. It is an Atomic workflow inspired by/adapting open-source Compound Engineering process language and severity vocabulary from EveryInc's Compound Engineering Plugin. The upstream project is MIT licensed; retain this notice when copying adapted workflow prompts or documentation.
