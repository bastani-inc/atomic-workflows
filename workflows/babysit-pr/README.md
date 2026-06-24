# babysit-pr

Shepherd a GitHub pull request through review feedback and CI until it is clean, exhausted, or needs human attention.

This workflow is intentionally bounded. It may edit the local checkout, commit fixes, and push commits to the PR head branch, but the only remote branch mutation chokepoint is `push_pr_fixes`.

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
3. Require a clean workspace outside workflow-owned artifacts before `gh pr checkout`; a dirty pre-checkout workspace returns `needs_human` with zero completed iterations and no pushed commits.
4. Checkout the PR branch with `gh pr checkout`.
5. For each bounded iteration:
   - fetch PR metadata, including lifecycle state, authoritative `headRefOid`, explicit known/unknown PR head repository identity, mergeability, top-level comment/latest-review signals, inline review threads, and observed check status;
   - preserve stable GitHub IDs for top-level PR comments/review summaries when available, and ignore only those top-level signals that a validated remediation receipt listed and that were marked addressed after a successful pushed remediation in the current workflow run;
   - wait for pending CI to settle or time out only while the PR lifecycle state is `OPEN`, capping every sleep to the remaining `poll_timeout` budget;
   - treat skipped/neutral checks as non-failing;
   - treat empty or absent check data as unobserved/unknown rather than green;
   - classify the state as `clean`, `wait_for_ci`, `remediate`, `exhausted`, or `needs_human`;
   - require a clean workspace outside workflow-owned artifacts before remediation;
   - verify local `HEAD` exactly matches the latest observed GitHub `headRefOid` and confirm push access with a credential-safe `git push --dry-run --porcelain --no-verify` preflight with local hooks disabled before the remediation child starts;
   - run one remediation stage for actionable feedback and failing CI with read/edit/write tools only, no shell access, and MCP denied so Git, GitHub CLIs, wrappers, interpreters, network clients, package scripts, remote Git, and branch/history mutation are not available to the child;
   - convert remediation task or output failures to a final `needs_human` report before receipt parsing;
   - verify `HEAD` is unchanged after the remediation child returns and before parsing any receipt;
   - parse and validate a machine-checkable remediation receipt before staging anything, where failed tests, residual items, or invalid receipt-listed addressed comment signal IDs return `needs_human`;
   - commit only paths present in both the parsed receipt and the Git diff with `git add -- <paths>`, after re-checking that local `HEAD` still matches `headRefOid`, with local hooks and commit signing disabled and the resulting commit parent/tree verified against the selectively staged remediation tree;
   - reuse the preflight-confirmed same-repo or fork push target, then push with local hooks disabled and `--no-verify` only through `push_pr_fixes` after verifying the commit parent equals `headRefOid`;
   - sync PR state again after every successful push, waiting until GitHub reports the pushed commit as the PR head, including the final allowed iteration.
5. Save a final Markdown report and per-run artifacts.

## Safety boundaries

`babysit-pr` does not merge, close, approve, force-push, resolve review threads, or post PR comments. It does not create fallback branches or follow-up PRs when direct push access is missing.

Commit safety does not rely on `.gitignore`: pre-existing workspace changes outside the current `.babysit-pr-*` artifact directory return `needs_human` both before `gh pr checkout` and before each remediation pass, workflow artifacts are never staged, remediation child stages must not create commits or rewrite history, local `HEAD` must match GitHub `headRefOid` before remediation and before the parent-owned commit, the commit receipt records its parent SHA, `push_pr_fixes` refuses commits whose parent is not the observed PR head or when local `HEAD` is not that parent-owned commit, and fix commits stage only paths listed in a parseable remediation receipt and present in `git status`. Parent-owned commits run with local hooks and commit signing disabled, then verify the new commit parent and tree against the pre-commit staged remediation tree. Whole-workspace staging is intentionally forbidden.

Remediation receipts should end after a `FINAL_REMEDIATION_RECEIPT:` marker as raw JSON or a fenced `json` block with `changed_files`, `tests_run`, `residual_items`, and optional `addressed_comment_signal_ids`; if examples appear earlier, the parser uses the final marked/fenced receipt. `addressed_comment_signal_ids` may be omitted or `[]`; when present it must be an array of non-empty strings naming only current actionable top-level PR comment/review-summary `comment_signal` IDs the remediation actually addressed, never inline review thread IDs. The parser trims, de-duplicates, and sorts those IDs, then validates them against the current PR state; unknown, non-actionable, or already-addressed IDs return `needs_human` before ownership collection, staging, commit, or push. Any `tests_run[].result` of `failed` or any non-empty `residual_items` returns `needs_human` before ownership collection, staging, commit, or push; `skipped` tests are informational and do not count as passed validation. Paths must be repo-relative; absolute/escaping paths, workflow artifact/report paths, unlisted dirty paths, listed paths without diffs, rename mismatches, and dirty copy sources without a separate modification entry return `needs_human`. For copy entries, `old_path` is safe existing provenance and only `new_path` is staged unless `old_path` also has its own modification entry.

Same-repo PRs are not blocked solely by `maintainerCanModify=false`; fork/cross-repo PRs with `maintainerCanModify=false` may still proceed when a validated push target for the fork is available. Missing or inaccessible `headRepository` / `headRepositoryOwner` metadata is an unknown PR head and always returns `needs_human` rather than defaulting to the base repo. Same-repo and fork PRs are pushed only to a validated remote name after all of that remote's push URLs are checked with `git remote get-url --push --all`, or to a single validated direct URL only when it contains no URL credentials. Push preflights and real pushes use `--no-verify` with local hooks disabled so repository-local `pre-push` hooks cannot affect safety decisions or remote mutation. Credential-bearing URLs are never placed in `git push` argv, raw push URLs are redacted from artifacts, and raw `owner/repo` slugs are refused. Merge conflicts and unknown mergeability cannot be reported as `clean`.

Actionable top-level PR comments and review summaries are first-class `comment_signals`, including actionable `COMMENTED` review summaries: they appear in remaining items, count toward remediation feedback, and block `clean` by routing to `remediate`. Because GitHub does not provide resolved/outdated lifecycle data for top-level PR comments or review summaries, the workflow marks only validated receipt-listed stable signal IDs addressed for the current workflow run, and only after a successful remediation commit is pushed; later classifications ignore those addressed top-level signals while still blocking on new/unaddressed actionable comment signals. Non-actionable comment signals remain supplemental only. The shared actionability heuristic requires explicit remediation, defect, or obligation language such as `please fix`, `please change`, `please update`, `must`, `required`, `bug`, `broken`, or `failing`; bare `please` or `should` wording is not enough. When GitHub reports `CHANGES_REQUESTED` but no actionable thread, PR comment, or review-summary text is safely identified, the workflow returns `needs_human` rather than guessing. Unresolved, non-outdated inline review threads with GitHub lifecycle data always block `clean`: actionable threads route to remediation, while unclassified live threads route to `needs_human` before failing CI can trigger remediation.

The workflow uses GitHub `headRefOid` as the only PR head SHA source; paginated commit lists are not used for head identity. Closed, merged, and lifecycle-unknown PRs return `needs_human` and are not remediated or pushed.

Empty or absent check data is never treated as green: a `clean` result requires observed check records and a successful aggregate. Required checks are preferred where they are discoverable, but visible optional failures, pending checks, or unknown check states from all-check data are merged back into the decision so optional problems are not hidden by required-check preference. If required checks are observed but all-check data is absent, the workflow can still use the required-only result; otherwise it falls back to observed all-check data and then GitHub `statusCheckRollup`, and empty or absent data never satisfies the green criterion. After a push, the sync loop keeps polling even after `headRefOid` matches the pushed commit until check records are observed and non-pending, or returns `needs_human` on timeout. CI wait and post-push sync sleeps are capped to the remaining `poll_timeout` budget, so a short timeout cannot oversleep a long `poll_interval`.

Parser-facing command stdout is kept exact and unredacted for GitHub JSON/GraphQL, origin URLs, remote push URLs, and raw Git porcelain such as `git status --porcelain=v1 -z` and `git diff --cached --name-only -z`; redaction is applied only to display, artifact, report, and error boundaries. Raw PR input is canonicalized to the GitHub PR URL before it is written to artifacts or manifests.

The workflow returns `needs_human` for unsafe cases such as missing `gh` auth, per-iteration GitHub/CLI sync failure, no push access, dirty workspace, local `HEAD`/`headRefOid` mismatch, merge conflicts, unknown mergeability, missing `headRefOid`, non-fast-forward push rejection, ambiguous feedback, no-progress remediation, post-push sync failure, no observed CI records, unknown CI state, or CI polling timeout.

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

Artifacts include PR intake, per-iteration PR state, CI state, decisions, parsed remediation receipts, owned path sets, redacted push targets, explicit sync-failure diagnostics when GitHub/CLI reads fail, and `manifest.json`. Manifests reference only artifacts that were written successfully.
