# `goal`

Run a bounded autonomous job with a durable goal ledger, delegated implementation, named validation, and reviewer-gated completion.

- **Source:** [`./index.ts`](./index.ts)
- **Posture:** mutating and approval-gated. Orchestrator subagents may edit, test, and commit work. Three independent reviewers inspect the actual delta before a TypeScript reducer decides the outcome.
- **PR safety:** PR, MR, or review creation is off by default. Only `create_pr=true` allows the final `pull-request` stage after approval; prompt text alone does not opt in.
- **Use it for:** a clear one-off objective that benefits from receipts, bounded follow-up turns, and strict proof against explicit done criteria.

## Run examples

```text
/workflow goal objective="Implement specs/2026-03-rate-limit.md, add the regression tests, run the focused test, and finish only when burst traffic returns 429 with Retry-After"
/workflow goal objective="Update the CLI docs for --json, add one example, and verify the docs build" max_turns=3
/workflow goal objective="Fix the install test in an isolated worktree and run the focused regression" git_worktree_dir=../atomic-goal-install-wt base_branch=main
/workflow goal objective="Implement the focused docs fix and run docs validation" create_pr=true
```

## Inputs

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `objective` | `text` | yes | — | Desired end state, expected result, validation steps, and explicit done criteria. Remove PR submission instructions and use `create_pr=true` instead. |
| `acceptance_criteria` | `text` | no | `objective` | Immutable original task contract. For a follow-up run, pass the original task text so reviewer findings cannot change its scope. |
| `max_turns` | `number` | no | `10` | Maximum orchestrator/review turns before human follow-up is needed. |
| `base_branch` | `string` | no | `origin/main` | Ref used for reviewer diff checks, optional final handoff, and creation of a missing worktree. |
| `git_worktree_dir` | `string` | no | `""` | Optional reusable Git worktree root. Empty uses the invoking checkout; non-empty creates or reuses an isolated worktree. |
| `create_pr` | `boolean` | no | `false` | Allows only the final stage to attempt a provider-specific PR, MR, or review after Goal reaches `complete`. |

Write `objective` as a compact acceptance spec. Goal uses it as supplied and does not run an initial prompt-refinement stage.

## Execution stages

1. Initialize an OS-temp `goal-ledger.json` with the objective, immutable acceptance criteria, goal id, and lifecycle events.
2. `orchestrator-N` supervises focused subagents for investigation, edits, tests, docs, and repairs, then writes `orchestrator-receipt.md`.
3. Three clean-context reviewers run in parallel:
   - `completion-reviewer-N` checks each contract clause and exact API, type, build, and example requirements.
   - `evidence-reviewer-N` checks that commands and artifacts prove the current checkout.
   - `risk-reviewer-N` probes state transitions, config precedence, feature flags, edge inputs, regressions, and scope drift.
4. A deterministic reducer records `complete`, `continue`, `blocked`, or `needs_human`. Two reviewer approvals form quorum; parse errors do not approve.
5. If work remains, the next orchestrator receives one deduplicated findings batch and the loop repeats up to `max_turns`.
6. `pull-request` runs only when `create_pr=true` and the reducer reached `complete`.

Reviewers coordinate costly or conflicting checks through Intercom but inspect the patch and vote independently. A repeated external blocker can produce `blocked`; turn exhaustion or stage failure produces `needs_human` with an inspectable reason.

## Outputs

| Field | Meaning |
| --- | --- |
| `result` | Final report with objective, state, receipts, turns, and remaining work. |
| `status` | `complete`, `blocked`, `needs_human`, or `active` if interrupted. |
| `approved` | Whether the reducer reached `complete`. |
| `goal_id` | Per-run id stored in the ledger. |
| `objective` | Raw objective used by the run. |
| `acceptance_criteria` | Immutable contract used by the run. |
| `ledger_path` | OS-temp ledger with receipts, reviews, blockers, decisions, and lifecycle events. |
| `turns_completed` / `iterations_completed` | Number of orchestrator/review turns completed. |
| `receipts` | Receipt summaries and orchestrator artifact paths. |
| `remaining_work` | Gaps or blockers when incomplete, otherwise `none`. |
| `review_report` | Markdown view of the latest reviewer decisions. |
| `review_report_path` | JSON artifact for the latest review round. |
| `pr_report` | Present only when the authorized final `pull-request` stage runs. |

## Worktree and delivery behavior

Set `git_worktree_dir` only when you want isolation. Relative paths resolve from the invoking repository root; an existing same-repository worktree is reused, and a missing one is created from `base_branch`. Atomic preserves the invoking repo-relative subdirectory inside it.

Unless the contract forbids commits, the orchestrator treats a committed change and clean working tree as part of delivery readiness. Reviewers reject claimed readiness when the review checkout has no relevant delta or required independent checks are missing.

## Upstream provenance

This workflow comes from [`bastani-inc/atomic`](https://github.com/bastani-inc/atomic) at commit [`020310225e0901e6a5e1515968500b73542f52a8`](https://github.com/bastani-inc/atomic/commit/020310225e0901e6a5e1515968500b73542f52a8).

Registry policy preserves the upstream runtime TypeScript byte-for-byte except for recorded private Atomic SDK and type imports, which are rewritten to the public `@bastani/workflows` import surface. See [`../upstream-builtins-manifest.json`](../upstream-builtins-manifest.json) and the focused parity test for the exact files, rewrites, and hashes.
