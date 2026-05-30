# `descent`

Run an agent-descent-style optimization loop: setup projection, implementor research/plan/exec, parallel validators, deterministic controls, optional intervention/campaign/radical-planning stages, and a terminator decision.

- **Source:** [`./index.ts`](./index.ts)
- **Posture:** mutating. Implementor and campaign stages may edit files. Pass a non-empty `git_worktree_dir` when you want Atomic/Ralph-style reusable worktree isolation from the invoking checkout.
- **State:** in workflow TypeScript state for the duration of the run; no repo-local `.descend/` state directory is used.
- **Recommended isolation:** pass `git_worktree_dir` for broad code reshaping or speculative changes so the invoking checkout stays separate from the mutable workflow workspace.

## What this workflow demonstrates

`descent` is a bounded optimization loop for code-changing objectives. It projects the user objective into implementor, evaluator, and terminator goals, then repeatedly applies implementation work and validates it across feature, reliability, modularity, and symbolic axes. The loop records accepted/rejected evaluation history, can trigger intervention or campaign stages when progress stalls, and returns a structured final status.

Rejected or error evaluations stop the run with `needs_human`. Descent leaves the effective worktree intact for inspection instead of attempting to undo the changes automatically.

## Run examples

```text
/workflow descent objective="Implement the documented retry behavior and run focused tests"
/workflow descent objective="Refactor the parser safely" max_iterations=5 max_reject=2
/workflow descent objective="Complete specs/2026-05-parser.md" base_branch=origin/main git_worktree_dir=../atomic-descent-parser-wt
```

## Inputs

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `objective` | `text` | yes | — | Goal, issue summary, task, or spec path for the descent optimization loop. |
| `max_iterations` | `number` | no | `10` | Maximum implement/validate/terminate iterations before returning `needs_human`. |
| `max_reject` | `number` | no | `3` | Consecutive rejected/error iterations before reject-streak stagnation, campaign, and radical-plan triggers. A rejected/error mutating iteration may stop immediately for inspection. |
| `history_observe` | `number` | no | `3` | Recent score-history window for plateau/decreasing-score stagnation and cascading-failure detection. |
| `base_branch` | `string` | no | `origin/main` | Branch/ref used by Atomic's worktree runtime when it creates a missing reusable worktree. Descent also normalizes this value separately for validator prompts and final-report comparison metadata. |
| `git_worktree_dir` | `string` | no | `""` | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values activate Atomic's Ralph-style reusable worktree binding. |

## Worktree behavior

`descent` uses the standard Atomic runtime binding, matching Ralph's reusable worktree contract:

```ts
.worktreeFromInputs({
  gitWorktreeDir: "git_worktree_dir",
  baseBranch: "base_branch",
})
```

The compiled workflow therefore exposes `inputBindings.worktree`, and Atomic applies those inputs as workflow-wide defaults for stages, tasks, and parallel work. Descent does not own a separate worktree setup path; it consumes the projected `ctx.cwd` that Atomic provides and records that value as the effective workflow cwd.

When `git_worktree_dir` is empty, stages run in the invoking checkout. When it is non-empty, Atomic's runtime binding handles reusable worktree selection:

- missing reusable worktrees are created from `base_branch` according to the Atomic/Ralph runtime contract;
- existing same-repository worktree roots can be reused;
- the runtime preserves the invoking repo-relative subdirectory inside the selected reusable worktree;
- Descent records the trimmed requested worktree path separately from the effective workflow cwd;
- Descent derives validator/final-report comparison text from its normalized `base_branch` value, while worktree creation follows the runtime binding.

Descent itself does not create accepted-baseline commits and does not run `git reset --hard` or `git clean -ffdx`. Rejected/error work remains in the effective workspace for manual inspection, cleanup, or retry. Descent also does not remove reusable worktrees; clean them up manually when you are done (for example with your usual `git worktree list` / `git worktree remove` process).

## Execution stages

The exact stage set depends on validation outcomes and loop controls, but the core pass is:

1. `setup-projection` — converts the objective into implementor/evaluator/terminator goals and axis weights.
2. `implementor-research-N` — investigates the repo and identifies the next high-leverage change.
3. `implementor-plan-N` — plans the bounded next implementation iteration.
4. `implementor-exec-N` — applies the planned changes and reports a structured implementation receipt.
5. Validator fanout in parallel:
   - `validator-features-N`
   - `validator-reliability-N`
   - `validator-modularity-N`
   - `validator-symbolic-N`
6. Post-transition controls, depending on history and validation results:
   - `intervention-N`
   - `campaign-reliability-N`
   - `campaign-modularity-N`
   - `validator-symbolic-campaign-N`
   - `radical-plan-N`
7. `terminator-N` — returns `SUCCESS`, `FAILURE`, or `CONTINUE` when deterministic rules do not already stop the loop.

## Output

The workflow returns compact structured metadata:

- `result`
- `status` (`success`, `failure`, or `needs_human`)
- `converged`
- `objective`
- `iterations_completed`
- `accepted_evaluations`
- `rejected_evaluations`
- compatibility aliases `approved_iterations` and `rejected_iterations`
- `final_score`
- `final_scores`
- `history`
- `ultimates`
- `review_report`
- `final_report`
- optional `radical_plan`

Iteration history uses inspection-oriented transition labels:

- `accepted_evaluation`
- `rejected_left_for_inspection`
- `error_left_for_inspection`

The final report includes workspace mode, effective workflow cwd, requested `git_worktree_dir` when present, optional reusable-worktree metadata when the runtime exposes it, and the normalized comparison base from `base_branch`.

## Safety notes

- The workflow instructs worker stages not to create pull requests.
- Worker stages are instructed not to create a `.descend` directory or use repo-local `.descend` files as state.
- Mutating worker stages are instructed not to run `git commit`; Descent records evaluation outcomes in memory and leaves Git history untouched.
- Use `git_worktree_dir` when you want isolation from the invoking checkout; inspect and clean up preserved worktrees manually after stopped runs.
