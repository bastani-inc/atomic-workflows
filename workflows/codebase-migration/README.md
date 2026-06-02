# codebase-migration

`codebase-migration` coordinates a large legacy-to-target-stack migration in one Atomic workflow run. It composes built-in workflows instead of reimplementing them:

1. `deep-research-codebase` inventories the migration surface.
2. `ralph` performs a literal behavior-preserving translation pass.
3. `ralph` runs again for idiomatic target-stack cleanup and safe deduplication.
4. The parent workflow writes a final Markdown handoff report under `migrations/`.

## Usage

Free-form request:

```text
/workflow run codebase-migration migration_request="Migrate the Express API in services/api to Fastify while preserving routes, auth behavior, tests, and deployment config."
```

Spec-path request:

```text
/workflow run codebase-migration migration_request="specs/api-fastify-migration.md"
```

Recommended reusable worktree for broad migrations, when the installed `deep-research-codebase` supports worktree-bound stages:

```text
/workflow run codebase-migration \
  migration_request="specs/api-fastify-migration.md" \
  base_branch="origin/main" \
  git_worktree_dir="../atomic-api-fastify-migration"
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `migration_request` | required | Migration spec path or free-form migration prompt. Existing file paths are passed as path references; other values are treated as inline migration charters. |
| `base_branch` | `origin/main` | Branch/ref used by Ralph review comparison and reusable worktree creation. |
| `git_worktree_dir` | `""` | Optional reusable Git worktree path. Empty runs in the invoking checkout. Non-empty values activate Atomic/Ralph-style reusable worktree binding. |
| `max_research_concurrency` | `100` | Passed to `deep-research-codebase` as `max_concurrency`. |
| `max_translation_loops` | `10` | Passed to the literal Ralph pass as `max_loops`. |
| `max_idiomatic_loops` | `10` | Passed to the idiomatic Ralph pass as `max_loops`. |

## Stages

| Stage | Purpose |
| --- | --- |
| `deep research migration surface` | Runs `deep-research-codebase` with the starter migration research prompt plus the user's migration charter. The returned `research_doc_path` is required. |
| `literal translation pass` | Runs Ralph against the research artifact and original charter. The prompt asks Ralph to preserve behavior, map files 1:1 where practical, and intentionally keep duplicated/mechanical code. |
| `idiomatic cleanup pass` | Runs Ralph again in the same checkout/worktree. The prompt asks for target-stack idioms and safe deduplication only after the literal pass exists. |
| `migration handoff report` | Writes a final developer-facing Markdown report using artifact paths from research and both Ralph passes. |

## Outputs

| Output | Description |
| --- | --- |
| `result` | Compact completion summary and review guidance. |
| `migration_report_path` | Path to the saved final migration report. |
| `research_doc_path` | Deep research report path used as the implementation handoff. |
| `research_artifact_dir` | Optional deep-research artifact directory. |
| `research_manifest_path` | Optional deep-research manifest path. |
| `literal_translation` | Selected outputs from the literal Ralph pass, such as plan/notes/review paths. |
| `idiomatic_cleanup` | Selected outputs from the idiomatic Ralph pass. |
| `approved` | Final Ralph approval value when returned. |
| `worktree_dir` | Effective shared worktree root used by deep research and both Ralph passes in reusable-worktree mode, or empty when the invoking checkout was used. |

## Worktree and safety behavior

The workflow uses:

```ts
.worktreeFromInputs({ gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" })
```

This mirrors the Descent/Ralph reusable-worktree convention:

- Empty `git_worktree_dir` means the workflow operates in the invoking checkout. The deep research child receives only its normal `prompt` and `max_concurrency` inputs, and Ralph receives `git_worktree_dir: ""` in this mode.
- A non-empty `git_worktree_dir` lets the Atomic runtime bind the parent run to a reusable worktree based on `base_branch` and preserve the invoking repo-relative subdirectory.
- The parent worktree binding owns `git_worktree_dir`. The parent never forwards the raw relative parent value to nested child workflows. Instead, it runs `git rev-parse --show-toplevel` from the parent effective `cwd` and passes that effective absolute worktree root to every child workflow that can bind it.
- In reusable-worktree mode, `deep-research-codebase` must declare `git_worktree_dir` and bind it through `.worktreeFromInputs`/`inputBindings.worktree`. When supported, the parent passes the effective absolute worktree root to deep research so its agents inspect the same checkout/worktree Ralph will edit; `base_branch` is passed only if the installed child declares it.
- Both Ralph child passes receive the same effective absolute worktree root and the same `base_branch` for review/diff semantics, so the idiomatic cleanup starts from the literal pass changes in the same effective workspace.
- `worktree_dir` returns the shared effective value: `""` for invoking-checkout mode or the derived absolute worktree root for reusable-worktree mode.

The parent workflow does **not** commit, create branches, post PRs/comments, deploy, run `git reset --hard`, run `git clean -ffdx`, or perform destructive cleanup. Before launching Ralph, it requires Ralph to declare a hard PR-disable input and passes `create_pr: false` and/or `pull_request_mode: "disabled"` to both Ralph calls when supported. If the installed Ralph exposes neither input, `codebase-migration` fails fast before either Ralph pass can mutate code. Review the report, Ralph artifacts, repository diff, and validation evidence before committing or deploying.

## Report behavior

Final handoff reports are written collision-safely under:

```text
./migrations/YYYY-MM-DD-<topic>.md
./migrations/YYYY-MM-DD-<topic>-2.md
```

The report includes executive summary, scope, research source, file/component mapping, literal pass summary, idiomatic cleanup summary, behavior parity notes, validation evidence, operational/deployment notes, rollback/fallback plan, known gaps, and PR review guidance.

Large handoffs stay path-based: Ralph prompts and the final report stage reference `research_doc_path`, implementation notes, plan paths, and review report paths rather than pasting full reports into every prompt.

## Failure behavior

`codebase-migration` intentionally fails fast when the installed Ralph workflow does not expose a hard PR-disable input (`create_pr` or `pull_request_mode`). Current unsafe Ralph builds are not composed silently because they may create branches, PRs, or comments when credentials are available.

`research_doc_path` is required. If `deep-research-codebase` does not return it, `codebase-migration` fails with a clear error instead of launching Ralph without the research handoff artifact.

When non-empty `git_worktree_dir` is requested, `ctx.cwd` must be inside the parent-bound Git checkout/worktree so `git rev-parse --show-toplevel` can derive the effective absolute root shared by deep research and Ralph.

Reusable-worktree mode also fails fast before research if the installed `deep-research-codebase` cannot bind its internal stages to the same checkout/worktree. The error names `deep-research-codebase`, `git_worktree_dir`, and `worktreeFromInputs`/`inputBindings.worktree`; upgrade `@bastani/workflows` to a build with this contract or run with empty `git_worktree_dir`.
