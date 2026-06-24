# Registry workflows

This folder contains the Atomic workflows shipped by `atomic-workflows`.

Each workflow has its own subfolder with an `index.ts` entrypoint and local documentation. The package manifest exposes only `./workflows/*/index.ts`, which keeps shared helpers and tests out of Atomic workflow discovery while still supporting git installs via `atomic install git:github.com/bastani-inc/atomic-workflows`.

| Workflow | Source | Details |
| --- | --- | --- |
| `babysit-pr` | [`babysit-pr/index.ts`](./babysit-pr/index.ts) | [`babysit-pr/README.md`](./babysit-pr/README.md) |
| `codebase-migration` | [`codebase-migration/index.ts`](./codebase-migration/index.ts) | [`codebase-migration/README.md`](./codebase-migration/README.md) |
| `descent` | [`descent/index.ts`](./descent/index.ts) | [`descent/README.md`](./descent/README.md) |
| `review-board` | [`review-board/index.ts`](./review-board/index.ts) | [`review-board/README.md`](./review-board/README.md) |
| `security-gate` | [`security-gate/index.ts`](./security-gate/index.ts) | [`security-gate/README.md`](./security-gate/README.md) |
| `spec-driven-development` | [`spec-driven-development/index.ts`](./spec-driven-development/index.ts) | [`spec-driven-development/README.md`](./spec-driven-development/README.md) |

Workflow-specific helper code and tests live next to the workflow files they support. The `babysit-pr` PR shepherd keeps remediation children on read/edit/write tools without shell access and caps CI/post-push sleep intervals to the remaining `poll_timeout` budget.

## List and inspect

From an Atomic chat session:

```text
/workflow list
/workflow inputs babysit-pr
/workflow inputs codebase-migration
/workflow inputs descent
/workflow inputs review-board
/workflow inputs security-gate
/workflow inputs spec-driven-development
```

## Final reports and artifacts

Reporting workflows write their final Markdown report to disk and return compact metadata instead of returning the full report inline.

Reporting workflows save final reports under project-root output folders:

```text
./babysit-pr/YYYY-MM-DD-<ai-generated-topic>(-N).md
./migrations/YYYY-MM-DD-<migration-topic>(-N).md
./review-board/YYYY-MM-DD-<ai-generated-topic>(-N).md
./security-gate/YYYY-MM-DD-<ai-generated-topic>(-N).md
```

Intermediate workflow outputs are preserved under hidden run-specific artifact directories such as `./.babysit-pr-<run-id>/`, `./.review-board-<run-id>/`, and `./.security-gate-<run-id>/`. Each artifact directory includes markdown stage outputs created by that run and a `manifest.json` recording the run id, timestamps, user input, final report path, and actual artifact paths. Some workflows may intentionally create a smaller artifact set when they short-circuit.

The return object includes `summary`, `report_path`, `filename_summary`, `artifact_dir`, `manifest_path`, and `stages`.

## `settings.json` filters

Atomic installs workflow packages as a whole package. If a package contains multiple workflows, install the package once and filter which workflows load in `settings.json`.

Load every workflow from this package:

```json
{
  "packages": [
    "git:github.com/bastani-inc/atomic-workflows"
  ]
}
```

Load only `review-board` and `security-gate`:

```json
{
  "packages": [
    {
      "source": "git:github.com/bastani-inc/atomic-workflows",
      "workflows": [
        "workflows/review-board/index.ts",
        "workflows/security-gate/index.ts"
      ]
    }
  ]
}
```

Exclude one workflow while keeping the rest:

```json
{
  "packages": [
    {
      "source": "git:github.com/bastani-inc/atomic-workflows",
      "workflows": [
        "!workflows/security-gate/index.ts"
      ]
    }
  ]
}
```

Disable all workflows from this package while keeping the package entry:

```json
{
  "packages": [
    {
      "source": "git:github.com/bastani-inc/atomic-workflows",
      "workflows": []
    }
  ]
}
```

See the workflow package setup docs: <https://docs.bastani.ai/workflows#package-setup>.
