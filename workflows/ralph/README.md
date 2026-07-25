# `ralph`

Run a bounded, research-first implementation loop with delegated work and independent review.

- **Source:** [`./index.ts`](./index.ts)
- **Posture:** mutating and approval-gated. Ralph researches the task, delegates implementation, validates the current delta, and iterates on reviewer findings.
- **PR safety:** PR, MR, or review creation is off by default. Only `create_pr=true` allows the final `pull-request` stage; prompt text alone does not opt in.
- **Use it for:** a spec, issue, or broad task that benefits from fresh research before each implementation and review pass.

## Run examples

```text
/workflow ralph prompt="Migrate the database layer to Drizzle" max_loops=3 base_branch=develop
/workflow ralph prompt="Refactor authentication across the API, CLI, and web UI" create_pr=true
/workflow ralph prompt="Safely implement the API refactor" git_worktree_dir=../atomic-ralph-api-wt base_branch=main
```

## Inputs

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prompt` | `text` | yes | — | Task, feature request, issue summary, or spec path to research, execute, refine, and review. Remove PR submission instructions and use `create_pr=true` instead. |
| `acceptance_criteria` | `text` | no | `prompt` | Immutable original task contract. For a follow-up run, pass the original task text so findings cannot change its scope. |
| `max_loops` | `number` | no | `10` | Maximum research/orchestrate/review iterations. |
| `base_branch` | `string` | no | `origin/main` | Ref used for reviewer diff checks, optional final handoff, and creation of a missing worktree. |
| `git_worktree_dir` | `string` | no | `""` | Optional reusable Git worktree root. Empty uses the invoking checkout; non-empty creates or reuses an isolated worktree. |
| `create_pr` | `boolean` | no | `false` | Allows only the final stage to attempt a provider-specific PR, MR, or review after reviewer approval. |

Ralph uses the raw `prompt` as its operative objective. `acceptance_criteria` defaults to it and remains the literal source of truth.

## Execution stages

Each loop runs:

1. `research-prompt-refinement-N` turns the raw task into a codebase and online research question with the prompt-engineer skill.
2. `research-N` runs codebase research and writes findings under `research/`; later passes include unresolved review evidence.
3. `orchestrator-N` derives an acceptance matrix, delegates implementation and validation to subagents, and updates OS-temp implementation notes.
4. `reviewer-a` and `reviewer-b` inspect the patch in parallel on different model families. They check each task clause, run independent probes, and return structured approval decisions.
5. If both reviewers do not approve, Ralph sends one deduplicated findings batch into the next research and implementation pass. The loop stops on approval or at `max_loops`.
6. `pull-request` runs only when `create_pr=true` and both reviewers approved.

For UI or full-stack changes, the orchestrator seeks end-to-end proof with `playwright-cli` and may expose a reviewable QA video. Reviewers coordinate costly shared checks through Intercom but inspect the patch and decide independently.

## Outputs

| Field | Meaning |
| --- | --- |
| `result` | Latest implementation report from the orchestrator. |
| `plan` | Latest transformed research question. |
| `plan_path` | Compatibility alias for `research_path`. |
| `research` | Latest research report text or artifact reference. |
| `research_path` | Latest generated artifact under `research/`. |
| `implementation_notes_path` | OS-temp notes with decisions, deviations, blockers, and validation. |
| `qa_video_path` | Absolute path to a QA proof video for UI-applicable work, when produced. |
| `approved` | Whether both reviewers approved before completion or final handoff. |
| `iterations_completed` | Number of research/orchestrate/review loops. |
| `review_report` | Compact reference to the latest reviewer payload. |
| `review_report_path` | JSON artifact for the latest review round. |
| `pr_report` | Present only when the authorized final `pull-request` stage runs. |

## Worktree and stopping behavior

Set `git_worktree_dir` only when you want isolation. Relative paths resolve from the invoking repository root; an existing same-repository worktree is reused, and a missing one is created from `base_branch`. Atomic preserves the invoking repo-relative subdirectory inside it.

The loop always stops within `max_loops`. If approval is not reached, the latest review artifacts and implementation notes keep the remaining work inspectable. Missing or failed material proof does not count as approval.

## Upstream provenance

This workflow comes from [`bastani-inc/atomic`](https://github.com/bastani-inc/atomic) at commit [`020310225e0901e6a5e1515968500b73542f52a8`](https://github.com/bastani-inc/atomic/commit/020310225e0901e6a5e1515968500b73542f52a8).

Registry policy preserves the upstream runtime TypeScript byte-for-byte except for recorded private Atomic SDK and type imports, which are rewritten to the public `@bastani/workflows` import surface. See [`../upstream-builtins-manifest.json`](../upstream-builtins-manifest.json) and the focused parity test for the exact files, rewrites, and hashes.
