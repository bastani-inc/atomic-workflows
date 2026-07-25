# `open-claude-design`

Create and refine a browser-reviewed UI or design artifact, then export a rich HTML handoff.

- **Source:** [`./index.ts`](./index.ts)
- **Posture:** artifact-generating and interactive. It may create or reconcile `PRODUCT.md` and `DESIGN.md`, writes HTML and feedback artifacts, browses design references, and asks for live user feedback. It does not implement the final product UI.
- **Browser requirement:** the workflow needs the `playwright-cli` skill's browser for discovery and preview review. If unavailable, it exits before generation with paths and install guidance.
- **Use it for:** prototypes, wireframes, pages, components, themes, or design tokens that need a guided brief, strong references, and iterative visual review.

## Run examples

```text
/workflow open-claude-design prompt="Refresh the settings page hierarchy"
/workflow open-claude-design prompt="Design a billing page like Stripe's"
/workflow open-claude-design prompt="Generate spacing and color tokens"
/workflow open-claude-design prompt="Design a marketing landing page" discover_references=false
```

## Inputs

| Input | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prompt` | `text` | yes | — | What to design. The discovery stage turns it into a confirmed brief. |
| `discover_references` | `boolean` | no | `true` | Browse curated galleries and feed selected current references into generation. Set `false` to skip this pass. |
| `max_refinements` | `number` | no | `3` | Maximum `generate-N` / `user-feedback-N` iterations. |

Do not pass `output_type`, `reference`, or `design_system`. The `discovery` interview asks for the output type (`prototype`, `wireframe`, `page`, `component`, `theme`, or `tokens`) and references, then loads or creates project design context.

## Execution stages

1. A deterministic setup step checks that the `playwright-cli` command and browser are available.
2. `discovery` runs impeccable `shape` and `init`: it confirms the brief, output type, and references, then detects, creates, or reconciles `PRODUCT.md` and `DESIGN.md`.
3. `ds-locator`, `ds-analyzer`, and `ds-patterns` run in parallel to extract project design-system evidence and user-provided URL or file references.
4. `reference-discovery` runs when enabled. It browses Awwwards, recent.design, Dribbble, Monet, and Motionsites, captures strong real-page references, and asks which direction the user prefers.
5. `generate-N` writes or updates one self-contained `preview.html`.
6. `user-feedback-N` opens the preview through impeccable `live` or browser fallbacks. Captured notes, accepted live changes, and annotations feed only the next generation pass. No meaningful feedback approves export early.
7. `exporter` writes a rich self-contained `spec.html` with the approved preview and implementation guidance.
8. `final-display` opens or surfaces the spec. It does not ask for changes after export; rerun the workflow for another pass.

User references take priority over `DESIGN.md` and `PRODUCT.md` for visual traits; project context fills gaps and still governs product voice. Generate and feedback stages keep separate forked session histories.

## Outputs and artifacts

| Field | Meaning |
| --- | --- |
| `output_type` | Artifact kind chosen during discovery. |
| `design_system` | Project-derived design context used for generation. |
| `artifact` | Latest approved preview summary. |
| `handoff` | Final rich HTML spec and implementation handoff summary. |
| `approved_for_export` | Whether the last feedback stage requested no further changes before export. |
| `refinements_completed` | Number of generation passes completed. |
| `import_context` | User-reference context used during generation. |
| `run_id` | Per-run artifact id. |
| `artifact_dir` | Directory containing preview, spec, references, and feedback artifacts. |
| `preview_path` / `preview_file_url` | Absolute path and `file://` URL for `preview.html`. |
| `spec_path` / `spec_file_url` | Absolute path and `file://` URL for `spec.html`. |
| `playwright_cli_status` | Result of the initial browser-tool setup check. |

This workflow has no `result` output. Use `artifact` and `handoff` for generated content. It saves curated references to `references.md` and iteration feedback under `<artifact_dir>/feedback/`.

## Upstream provenance

This workflow comes from [`bastani-inc/atomic`](https://github.com/bastani-inc/atomic) at commit [`020310225e0901e6a5e1515968500b73542f52a8`](https://github.com/bastani-inc/atomic/commit/020310225e0901e6a5e1515968500b73542f52a8).

Registry policy preserves the upstream runtime TypeScript byte-for-byte except for recorded private Atomic SDK and type imports, which are rewritten to the public `@bastani/workflows` import surface. See [`../upstream-builtins-manifest.json`](../upstream-builtins-manifest.json) and the focused parity test for the exact files, rewrites, and hashes.
