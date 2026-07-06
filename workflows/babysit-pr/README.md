# babysit-pr

Shepherd a GitHub pull request through review feedback and CI until it is clean, exhausted, or needs human attention.

This workflow now uses a trusted remediation stage. The remediation agent may run shell commands, tests, package scripts, `git`, and `gh` with the credentials available in the checkout, including creating commits, pushing to the PR branch, updating PR metadata, and replying to or resolving review threads when needed. The parent workflow observes the trusted remediation result, records receipts, syncs PR state, and reports remaining work.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `pr` | required | GitHub PR URL, `owner/repo#number`, or bare PR number resolved from the current `origin` remote. |
| `max_iterations` | `10` | Maximum remediation passes before returning `exhausted`. |
| `base_branch` | `origin/main` | Base ref used by the Atomic runtime worktree binding and local comparison context. |
| `poll_interval` | `30` | Seconds between CI polling attempts. |
| `poll_timeout` | `1800` | Maximum seconds to wait for pending checks in one iteration or post-push sync phase; each sleep is capped to the remaining budget. |
| `git_worktree_dir` | `""` | Optional reusable worktree root. Bound through the workflow `worktreeFromInputs` contract. |

Examples:

```text
/workflow babysit-pr pr="https://github.com/bastani-inc/atomic-workflows/pull/10"
/workflow babysit-pr pr="bastani-inc/atomic-workflows#10" max_iterations=5
/workflow babysit-pr pr=10 git_worktree_dir="../atomic-babysit-pr-wt"
```

## Behavior

1. Resolve the PR identity from the input airlock.
2. Check GitHub CLI authentication.
3. Run a bounded preflight classifier before checkout:
   - fetch only the PR state needed to route: lifecycle, authoritative `headRefOid`, head repository identity, mergeability, top-level comment/latest-review signals, inline review threads, and observed check status;
   - write a structured `00-preflight-decision.json` with `action`, `evidence`, `next_stage`, `commands_run`, and `stop_reason`;
   - choose exactly one route: `done`, `wait_for_ci`, `fix_failure`, `respond_to_review`, or `ask_human`;
   - stop preflight as soon as a valid route is available; do not review unrelated files, stage, commit, run speculative local tests, or inspect the checkout locally.
4. If CI is pending, run only the bounded CI polling gate and reclassify before checkout.
5. If preflight is clean or human-blocked, save the final report without checking out the PR branch.
6. Only when preflight routes to remediation, preserve pre-existing workspace changes outside workflow-owned artifacts in a safety stash before `gh pr checkout`; a stash failure returns `needs_human` with zero completed iterations and no pushed commits.
7. Checkout the PR branch with `gh pr checkout`, then fetch the latest GitHub `headRefOid` and verify local `HEAD` exactly matches it before remediation starts.
8. For each bounded iteration:
   - fetch PR metadata, including lifecycle state, authoritative `headRefOid`, explicit known/unknown PR head repository identity, mergeability, top-level comment/latest-review signals, inline review threads, and observed check status;
   - preserve stable GitHub IDs for top-level PR comments/review summaries when available, and ignore only those top-level signals that a validated remediation receipt listed and that were marked addressed after a successful pushed remediation in the current workflow run;
   - wait for pending CI to settle or time out only while the PR lifecycle state is `OPEN`, capping every sleep to the remaining `poll_timeout` budget;
   - treat skipped/neutral checks as non-failing;
   - treat empty or absent check data as unobserved/unknown rather than green;
   - classify the state as `clean`, `wait_for_ci`, `remediate`, `exhausted`, or `needs_human`;
   - require a clean workspace outside workflow-owned artifacts before remediation;
   - verify local `HEAD` exactly matches the latest observed GitHub `headRefOid` before the trusted remediation child starts;
   - run one trusted remediation stage for actionable feedback, requested-change review threads, merge conflicts, and failing CI with read/edit/write/bash tools so the agent can run tests, typechecks, builds, package scripts, `git`, and `gh`, create commits, push to the PR branch, update PR title/body or other metadata, and reply to or resolve review threads when needed;
   - convert remediation task or output failures to a final `needs_human` report before receipt parsing;
   - observe `HEAD` after the trusted remediation child returns;
   - parse and structurally validate a schema-backed machine-checkable remediation receipt, including addressed comment IDs and dirty-path ownership;
   - if the trusted remediation created a local commit, sync PR state until GitHub reports that commit as the PR head and checks for that exact SHA settle;
   - ignore stale check runs from older PR heads while waiting for the latest head SHA;
   - after latest-head checks are green, poll GitHub mergeability briefly so asynchronous branch-protection state can refresh before declaring `blocked`;
   - if the trusted remediation made metadata-only changes, sync PR state and checks without requiring a new commit.
9. Save a final Markdown report and per-run artifacts.

## Safety boundaries

`babysit-pr` still does not merge or close PRs. The trusted remediation agent may use `gh` for PR metadata updates and review-thread replies/resolution when that is the appropriate way to address feedback. Force-pushes are discouraged in the prompt unless the repository's normal workflow explicitly requires them and the agent can explain why.

Commit and mutation ownership now belongs to the trusted remediation stage, not preflight. Preflight treats the PR checkout/diff as the PR under observation, never as workflow-authored edits to stage or commit. Pre-existing workspace changes outside the current `.babysit-pr-*` artifact directory are safety-stashed before checkout instead of stopping immediately; workflow artifacts are excluded from workspace checks, and local `HEAD` must match GitHub `headRefOid` before the trusted remediator starts. After remediation, the parent requires a parseable receipt, records local validation/residual evidence, allows only dirty paths explicitly represented by the receipt, and syncs PR state. If local `HEAD` changed, the parent waits for GitHub to report that commit as the PR head and records it in `commits_pushed`; otherwise it treats the pass as metadata-only or no-commit remediation and reclassifies the PR state.

Remediation receipts should end after a `FINAL_REMEDIATION_RECEIPT:` marker as raw JSON or a fenced `json` block with `changed_files`, `tests_run`, `residual_items`, and optional `addressed_comment_signal_ids`; the remediation stage is also schema-backed so the final answer tool enforces the same shape. If examples appear earlier, the parser uses the final marked/fenced receipt. `tests_run[].result` must be exactly `passed`, `failed`, or `skipped`; transient retries, watcher timeouts, and focused-rerun details belong in optional `note`, not in `result`. The parser tolerates legacy `"passed: note"`/`"failed: note"`/`"skipped: note"` result strings by extracting the enum and preserving the note so prose does not become a structural parse failure. `addressed_comment_signal_ids` may be omitted or `[]`; when present it must be an array of non-empty strings naming only current actionable top-level PR comment/review-summary `comment_signal` IDs the remediation actually addressed, never inline review thread IDs. The parser trims, de-duplicates, and sorts those IDs, then validates them against the current PR state; unknown, non-actionable, or already-addressed IDs still return `needs_human`. Paths should be repo-relative in receipts. The trusted remediator is responsible for committing/pushing file changes itself; the parent no longer selectively stages receipt paths, but still rejects invalid addressed comment IDs and dirty paths not represented by the receipt after remediation. Local receipt outcome is recorded as evidence; final convergence is based on refreshed latest-head PR state, current actionable feedback, and exact-SHA check status.

Same-repo PRs are not blocked solely by `maintainerCanModify=false`. Missing or inaccessible `headRepository` / `headRepositoryOwner` metadata is an unknown PR head and always returns `needs_human` rather than guessing. The trusted remediator uses the checkout's configured credentials and remotes for `git`/`gh` operations. Merge conflicts route to remediation when the PR is otherwise safe to mutate; unknown mergeability cannot be reported as `clean`.

Actionable top-level PR comments and review summaries are first-class `comment_signals`, including actionable `COMMENTED` review summaries: they appear in remaining items, count toward remediation feedback, and block `clean` by routing to `remediate`. Because GitHub does not provide resolved/outdated lifecycle data for top-level PR comments or review summaries, the workflow marks only validated receipt-listed stable signal IDs addressed for the current workflow run after a successful trusted remediation receipt; later classifications ignore those addressed top-level signals while still blocking on new/unaddressed actionable comment signals. Non-actionable comment signals remain supplemental only. The shared actionability heuristic recognizes remediation, defect, obligation, and senior-review language such as `please fix`, `please change`, `please update`, `must`, `required`, `bug`, `broken`, `failing`, `nit`, `prefer`, `consider`, `stale`, and `merge conflict`; bare `please` or generic `should be okay` wording is not enough. When GitHub reports `CHANGES_REQUESTED` with unresolved non-outdated inline review threads, those threads route to remediation even if keyword actionability is unclear. Unresolved, non-outdated inline review threads without a requested-changes review decision still block `clean`: actionable threads route to remediation, while unclassified live threads route to `needs_human` before failing CI can trigger remediation.

The workflow uses GitHub `headRefOid` as the only PR head SHA source; paginated commit lists are not used for head identity. Closed, merged, and lifecycle-unknown PRs return `needs_human` and are not remediated or pushed.

Empty or absent check data is never treated as green: a `clean` result requires observed check records and a successful aggregate. When GitHub reports a PR `headRefOid`, the workflow queries check-runs and commit statuses for that exact SHA before considering any status rollup fallback, which prevents old Windows or matrix jobs from previous commits from being mistaken for the latest head. Required checks are still used as a fallback only when an exact head SHA is unavailable. After trusted remediation changes `HEAD`, the sync loop keeps polling until GitHub reports that commit as the PR head and check records for that SHA are observed and non-pending, or returns `needs_human` on timeout. After green checks, the same polling budget allows GitHub mergeability/branch-protection state to refresh before `blocked` or `unknown` mergeability is reported. CI wait and post-push sync sleeps are capped to the remaining `poll_timeout` budget, so a short timeout cannot oversleep a long `poll_interval`.

Parser-facing command stdout is kept exact and unredacted for GitHub JSON/GraphQL, origin URLs, and raw Git porcelain such as `git status --porcelain=v1 -z`; redaction is applied only to display, artifact, report, and error boundaries. Raw PR input is canonicalized to the GitHub PR URL before it is written to artifacts or manifests.

The workflow returns `needs_human` for unsafe or incomplete cases such as missing `gh` auth, preflight or per-iteration GitHub/CLI sync failure, dirty-workspace stash failure, dirty paths absent from the remediation receipt, local `HEAD`/`headRefOid` mismatch after checkout or before remediation, unknown mergeability after checks and mergeability polling have settled, missing `headRefOid`, ambiguous feedback, no-progress remediation, post-remediation sync failure, no observed latest-head CI records, unknown CI state, or CI polling timeout.

## Outputs

The workflow returns compact metadata:

- `summary`
- `status` (`clean`, `exhausted`, or `needs_human`)
- `pr_url`
- `iterations_completed`
- `commits_pushed`
- `remaining_items`
- `report_path`
- `filename_summary`
- `artifact_dir`
- `manifest_path`
- `stages`

## Reports and artifacts

Final reports are written under:

```text
./babysit-pr/YYYY-MM-DD-<summary>(-N).md
```

Intermediate artifacts are written under hidden run directories:

```text
./.babysit-pr-<run-id>/
```

Artifacts include PR intake, structured preflight decisions, preflight PR/CI state, per-iteration PR state, CI state, decisions, parsed remediation receipts, post-remediation state, explicit sync-failure diagnostics when GitHub/CLI reads fail, and `manifest.json`. Manifests reference only artifacts that were written successfully.
