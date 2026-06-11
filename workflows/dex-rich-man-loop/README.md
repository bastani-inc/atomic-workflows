# dex-rich-man-loop

`dex-rich-man-loop` is a PR-backed refactor loop for Atomic. It researches the target area, asks built-in Ralph to create or update the initial PR, then lets a human reviewer repeatedly feed PR feedback into built-in Goal until the reviewer approves, pauses, or aborts.

## Starter pattern

This workflow uses **loop until done** with human review gates:

```text
research -> Ralph opens PR -> human PR gate -> Goal follow-up -> push -> human PR gate
                                      \-------------------------------/
```

## Inputs

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `request` | string | required | Generalized refactor request to research and implement. |
| `base_branch` | string | `origin/main` | Base branch for Ralph/Goal comparison. |
| `git_worktree_dir` | string | `""` | Optional reusable worktree for the initial and follow-up work. |
| `max_ralph_loops` | number | `5` | Maximum Ralph loops for the initial implementation. |
| `max_goal_turns` | number | `5` | Maximum Goal turns for each feedback pass. |

## Outputs

| Output | Description |
| --- | --- |
| `status` | Final loop status: `approved`, `needs_human`, or `failed`. |
| `pr_url` | Best-effort PR URL discovered from `gh` or Ralph output. |
| `research_path` | Research artifact path used by Ralph and Goal. |
| `iterations_completed` | Number of Goal follow-up rounds after the initial PR. |
| `final_report` | Markdown final report summarizing the run and handoff. |

## Usage

```text
/workflow dex-rich-man-loop request="Refactor the payment retry flow while preserving behavior" base_branch=origin/main
```

The workflow requires an interactive Atomic session because it uses human-in-the-loop PR gates. It also expects repository git tooling and, when available, the GitHub CLI (`gh`) for PR discovery.

## Artifacts

Run artifacts are written under:

```text
.atomic/workflows/runs/dex-rich-man-loop/<timestamp>/
```

The artifact directory contains the research report, Ralph prompt, per-iteration push reports, and the final report.
