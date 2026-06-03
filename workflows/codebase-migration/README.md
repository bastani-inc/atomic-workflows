# codebase-migration

`codebase-migration` coordinates a large legacy-to-target-stack migration in one Atomic workflow run. It composes built-in workflows for research and the final implementation handoff, plus a local Ralph-derived no-PR workflow for the intermediate literal pass:

1. Built-in `deep-research-codebase` inventories the migration surface.
2. Local `ralph-no-pr` performs a literal behavior-preserving translation pass without preparing an intermediate PR.
3. Built-in `ralph` runs for idiomatic target-stack cleanup, validation, safe deduplication, and normal Ralph PR/handoff behavior.
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
| `max_research_concurrency` | `100` | How many research tasks can run at once. Higher can finish faster but uses more compute/API capacity. |
| `max_translation_loops` | `10` | How many times Atomic may try to complete the initial code translation before stopping. |
| `max_idiomatic_loops` | `10` | How many times Atomic may refine the translated code for cleaner, more idiomatic results. |

## Stages

| Stage | Purpose |
| --- | --- |
| `deep research migration surface` | Runs `deep-research-codebase` with the starter migration research prompt plus the user's migration charter. The returned `research_doc_path` is required. |
| `literal translation pass` | Runs the local Ralph-derived `ralph-no-pr` workflow against the research artifact and original charter. It preserves Ralph's planning/orchestration/simplification/review loop but omits the final pull-request stage, so the literal pass can preserve behavior, map files 1:1 where practical, and intentionally keep duplicated/mechanical code without creating an intermediate PR. |
| `idiomatic cleanup pass` | Runs imported built-in Ralph in the same checkout/worktree. The prompt asks for target-stack idioms, validation, and safe deduplication only after the literal pass exists, then allows Ralph's normal PR/handoff behavior when ready. |
| `migration handoff report` | Writes a final developer-facing Markdown report using artifact paths from research and both Ralph passes. |

## Outputs

| Output | Description |
| --- | --- |
| `result` | Compact completion summary and review guidance. |
| `migration_report_path` | Path to the saved final migration report. |
| `research_doc_path` | Deep research report path used as the implementation handoff. |
| `research_artifact_dir` | Optional deep-research artifact directory. |
| `research_manifest_path` | Optional deep-research manifest path. |
| `literal_translation` | Selected outputs from the local no-PR literal Ralph pass, such as plan/notes/review paths. `pr_report` is intentionally absent because this pass skips PR preparation. |
| `idiomatic_cleanup` | Selected outputs from the imported built-in Ralph pass, including `pr_report` when built-in Ralph returns it. |
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
- Both implementation child passes receive the same effective absolute worktree root and the same `base_branch` for review/diff semantics, so the idiomatic cleanup starts from the literal pass changes in the same effective workspace.
- `worktree_dir` returns the shared effective value: `""` for invoking-checkout mode or the derived absolute worktree root for reusable-worktree mode.

The parent workflow does **not** deploy, run `git reset --hard`, run `git clean -ffdx`, or perform destructive cleanup. The first literal pass uses the local Ralph-derived `ralph-no-pr` workflow so it can plan, orchestrate, simplify, and review without creating an intermediate PR. The second idiomatic cleanup pass uses imported built-in Ralph without PR-control inputs; final PR behavior is owned by built-in Ralph and follows Ralph's normal policy when the implementation is ready and credentials/repository state allow it. Review the report, Ralph artifacts, repository diff, and validation evidence before deploying.

## Report behavior

Final handoff reports are written collision-safely under:

```text
./migrations/YYYY-MM-DD-<topic>.md
./migrations/YYYY-MM-DD-<topic>-2.md
```

The report includes executive summary, scope, research source, file/component mapping, literal pass summary, idiomatic cleanup summary, behavior parity notes, validation evidence, operational/deployment notes, rollback/fallback plan, known gaps, and PR review guidance.

Large handoffs stay path-based: Ralph prompts and the final report stage reference `research_doc_path`, implementation notes, plan paths, and review report paths rather than pasting full reports into every prompt.

## Failure behavior

`research_doc_path` is required. If `deep-research-codebase` does not return it, `codebase-migration` fails with a clear error instead of launching implementation passes without the research handoff artifact.

When non-empty `git_worktree_dir` is requested, `ctx.cwd` must be inside the parent-bound Git checkout/worktree so `git rev-parse --show-toplevel` can derive the effective absolute root shared by deep research and Ralph.

Reusable-worktree mode also fails fast before research if the installed `deep-research-codebase` cannot bind its internal stages to the same checkout/worktree. The error names `deep-research-codebase`, `git_worktree_dir`, and `worktreeFromInputs`/`inputBindings.worktree`; upgrade `@bastani/workflows` to a build with this contract or run with empty `git_worktree_dir`.
