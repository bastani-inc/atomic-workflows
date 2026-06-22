# Contributing workflows

Thanks for helping improve the Atomic Workflows Registry. Community submissions are welcome when they provide reusable, well-documented workflow recipes for developer jobs.

## What makes a good registry workflow

A good contribution should:

1. **Explain the value.** Start with the developer job the workflow solves, why it should be a workflow instead of a one-off prompt, and where the workflow creates leverage.
2. **Be explicit about posture.** State whether the workflow is read-only, report-only, approval-gated, or code-changing through another workflow such as Ralph.
3. **Design for clarity and token usage.** Prefer focused stages, compact handoffs, saved artifacts, and concise final metadata over large inline transcripts.
4. **Document inputs and outputs.** Include command examples, required inputs, generated files, artifact folders, status values, and any safety or failure behavior.
5. **Make it a useful template.** Keep the TypeScript readable enough that another developer can copy it, trim it, extend it, or optimize it for their own team.

## Workflow directory shape

Recommended structure:

```text
workflows/<workflow-name>/
  index.ts      # workflow({ ... }) entrypoint discovered by the package manifest
  README.md     # user-facing usage, posture, inputs, stages, and outputs
  helpers.ts    # optional workflow-local helpers
```

Keep helper code workflow-local unless there is a strong reason to share it. Workflow-specific tests should live next to the workflow helpers they cover.

## Adding a workflow

When adding a workflow:

1. Create `workflows/<workflow-name>/index.ts`.
2. Add a `workflows/<workflow-name>/README.md` with usage, posture, inputs, execution stages, outputs, and artifact behavior.
3. Update [`workflows/README.md`](./workflows/README.md) so the workflow appears in the registry index.
4. Add or update tests when helper logic is introduced or changed.
5. Run the test suite before submitting:

```bash
bun test
```

The package manifest discovers `./workflows/*/index.ts`, so new workflow folders become installable through the same registry install command.

## Useful authoring references

- Atomic: <https://github.com/flora131/atomic>
- Docs: <https://docs.bastani.ai/>
- Workflow package setup: <https://docs.bastani.ai/workflows#package-setup>
