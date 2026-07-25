# `deep-research-codebase`

Run broad, durable research when a task needs whole-repository context rather than a focused lookup.

- **Source:** [`./index.ts`](./index.ts)
- **Posture:** read-only analysis. The workflow reads the repository and external sources, then writes research reports and run artifacts. It does not implement code changes.
- **Use it for:** architecture maps, end-to-end behavior studies, migration discovery, and questions that span many subsystems.

## Run examples

```text
/workflow deep-research-codebase prompt="How do payment retries work end to end?"
/workflow deep-research-codebase prompt="Map the workflow runtime" max_partitions=8 max_concurrency=4
```

## Inputs

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prompt` | `text` | yes | — | Research question or investigation focus. |
| `max_partitions` | `number` | no | `100` | Maximum codebase partitions. The actual count scales at one partition per 10K lines of code and is capped by this value. |
| `max_concurrency` | `number` | no | `100` | Maximum workflow stages that run at once during research. |

## Execution stages

1. `codebase-scout` and `history-locator` run in parallel to map likely code paths and find prior research or decisions.
2. `history-analyzer` turns the history scan into useful context.
3. `partition` creates bounded, independent research slices.
4. First specialist wave: `locator-N` and `pattern-finder-N` map paths, symbols, conventions, and risks for each slice.
5. Second specialist wave: `analyzer-N` and `online-researcher-N` study behavior and relevant external APIs or docs.
6. `aggregator` resolves overlap and conflicts, preserves uncertainty, and writes the final report.

The specialist waves obey `max_concurrency`. Large handoffs stay in files so the final synthesis can use full evidence without one large inline transcript.

## Outputs and artifacts

| Field | Meaning |
| --- | --- |
| `result` | Final Markdown report text, matching `findings`. |
| `findings` | Final Markdown research report text. |
| `research_doc_path` | Public dated report under `research/<date>-<topic>.md`; a numeric suffix prevents overwrite. |
| `artifact_dir` | Hidden run directory under `research/.deep-research-<run-id>/`. |
| `manifest_path` | Manifest JSON inside the hidden artifact directory. |
| `partitions` | Codebase slices explored by specialists. |
| `explorer_count` | Number of partition explorer groups. |
| `specialist_count` | Number of specialist stages across both waves. |
| `max_concurrency` | Concurrency limit used by the run. |
| `history` | Prior-research overview included in the synthesis. |

The public report is suited for reading, sharing, or committing. The hidden directory keeps scout, history, and specialist evidence for audit.

## Upstream provenance

This workflow comes from [`bastani-inc/atomic`](https://github.com/bastani-inc/atomic) at commit [`020310225e0901e6a5e1515968500b73542f52a8`](https://github.com/bastani-inc/atomic/commit/020310225e0901e6a5e1515968500b73542f52a8).

Registry policy preserves the upstream runtime TypeScript byte-for-byte except for recorded private Atomic SDK and type imports, which are rewritten to the public `@bastani/workflows` import surface. See [`../upstream-builtins-manifest.json`](../upstream-builtins-manifest.json) and the focused parity test for the exact files, rewrites, and hashes.
