import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { defineWorkflow, Type } from "@bastani/workflows";
import { deepResearchCodebase, ralph } from "@bastani/workflows/builtin";
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_MAX_IDIOMATIC_LOOPS,
  DEFAULT_MAX_RESEARCH_CONCURRENCY,
  DEFAULT_MAX_TRANSLATION_LOOPS,
  buildDeepResearchPrompt,
  buildIdiomaticCleanupPrompt,
  buildLiteralTranslationPrompt,
  buildMigrationReportPrompt,
  formatMigrationRequestReference,
  reportTitleSeed,
  text,
  type MigrationRequestReference,
  type RalphOutputSummary,
} from "./helpers.js";
import { writeMigrationReport } from "./report-output.js";

const WORKFLOW_NAME = "codebase-migration";

const execFileAsync = promisify(execFile);

const RALPH_OUTPUT_SCHEMAS = {
  result: Type.Optional(Type.String({ description: "Ralph pass result summary." })),
  plan_path: Type.Optional(Type.String({ description: "Path to Ralph's implementation plan." })),
  implementation_notes_path: Type.Optional(Type.String({ description: "Path to Ralph's implementation notes." })),
  pr_report: Type.Optional(Type.String({ description: "Ralph PR handoff/report text when returned." })),
  approved: Type.Optional(Type.Boolean({ description: "Whether Ralph's review approved this pass." })),
  iterations_completed: Type.Optional(Type.Number({ description: "Ralph loop iterations completed." })),
  review_report: Type.Optional(Type.String({ description: "Ralph review report text when returned." })),
  review_report_path: Type.Optional(Type.String({ description: "Path to Ralph's review report." })),
} as const;

const ralphOutputSchema = Type.Object(RALPH_OUTPUT_SCHEMAS, {
  additionalProperties: true,
  description: "Selected declared outputs from a Ralph child workflow pass.",
});

const RALPH_OUTPUT_KEYS = Object.keys(RALPH_OUTPUT_SCHEMAS) as Array<keyof typeof RALPH_OUTPUT_SCHEMAS>;

function childOutputs(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    return {};
  }

  const record = result as Record<string, unknown>;
  const nested = record.outputs;
  if (typeof nested === "object" && nested !== null) {
    return nested as Record<string, unknown>;
  }

  return record;
}

function selectedRalphOutputs(result: unknown): RalphOutputSummary {
  const outputs = childOutputs(result);
  const selected: Record<string, unknown> = {};
  for (const key of RALPH_OUTPUT_KEYS) {
    if (outputs[key] !== undefined) {
      selected[key] = outputs[key];
    }
  }

  return selected as RalphOutputSummary;
}

async function existingRequestSpecPath(value: string, cwd: string): Promise<string | undefined> {
  const candidate = value.trim();
  if (candidate.length === 0 || /\r|\n/.test(candidate)) {
    return undefined;
  }

  const resolved = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  try {
    const fileStat = await stat(resolved);
    return fileStat.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function migrationRequestReference(
  migrationRequest: string,
  cwd: string,
): Promise<MigrationRequestReference> {
  const path = await existingRequestSpecPath(migrationRequest, cwd);
  return formatMigrationRequestReference(migrationRequest, path ? "path" : "inline");
}

async function resolveGitTopLevel(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const gitRoot = text(stdout);
    if (gitRoot.length === 0) {
      throw new Error("git returned an empty top-level path");
    }

    return isAbsolute(gitRoot) ? gitRoot : resolve(cwd, gitRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `codebase-migration could not derive the effective shared worktree root from ctx.cwd (${cwd}). `
        + `When git_worktree_dir is non-empty, ctx.cwd must be inside the parent-bound Git worktree. git rev-parse --show-toplevel failed: ${message}`,
    );
  }
}

async function resolveEffectiveWorktreeDir(options: {
  requestedGitWorktreeDir: string;
  effectiveWorkflowCwd: string;
}): Promise<string> {
  if (text(options.requestedGitWorktreeDir).length === 0) {
    return "";
  }

  return resolveGitTopLevel(options.effectiveWorkflowCwd);
}

type WorkflowWorktreeBinding = {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
};

function workflowInputNames(workflow: unknown): Set<string> {
  if (typeof workflow !== "object" || workflow === null) {
    return new Set();
  }

  const record = workflow as { inputs?: unknown; inputSchema?: unknown };
  const names = new Set<string>();
  if (typeof record.inputs === "object" && record.inputs !== null) {
    for (const name of Object.keys(record.inputs)) {
      names.add(name);
    }
  }

  if (typeof record.inputSchema === "object" && record.inputSchema !== null) {
    const properties = (record.inputSchema as { properties?: unknown }).properties;
    if (typeof properties === "object" && properties !== null) {
      for (const name of Object.keys(properties)) {
        names.add(name);
      }
    }
  }

  return names;
}

function asWorktreeBinding(value: unknown): WorkflowWorktreeBinding | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const binding = value as { gitWorktreeDir?: unknown; baseBranch?: unknown };
  if (typeof binding.gitWorktreeDir !== "string") {
    return undefined;
  }

  return {
    gitWorktreeDir: binding.gitWorktreeDir,
    ...(typeof binding.baseBranch === "string" ? { baseBranch: binding.baseBranch } : {}),
  };
}

function workflowWorktreeBinding(workflow: unknown): WorkflowWorktreeBinding | undefined {
  if (typeof workflow !== "object" || workflow === null) {
    return undefined;
  }

  const record = workflow as { inputBindings?: unknown; worktree?: unknown };
  if (typeof record.inputBindings === "object" && record.inputBindings !== null) {
    const inputBindings = record.inputBindings as { worktree?: unknown; gitWorktreeDir?: unknown; baseBranch?: unknown };
    return asWorktreeBinding(inputBindings.worktree) ?? asWorktreeBinding(inputBindings);
  }

  return asWorktreeBinding(record.worktree);
}

function hasBoundGitWorktreeInput(workflow: unknown, inputNames: Set<string>): boolean {
  const worktreeBinding = workflowWorktreeBinding(workflow);
  return inputNames.has("git_worktree_dir")
    && worktreeBinding?.gitWorktreeDir === "git_worktree_dir";
}

function requireDeepResearchWorktreeInputs(options: {
  workflow: unknown;
  requestedGitWorktreeDir: string;
  effectiveWorktreeDir: string;
  baseBranch: string;
}): Record<string, unknown> {
  if (text(options.requestedGitWorktreeDir).length === 0) {
    return {};
  }

  const inputNames = workflowInputNames(options.workflow);
  if (!hasBoundGitWorktreeInput(options.workflow, inputNames)) {
    throw new Error(
      "codebase-migration reusable-worktree mode requires deep-research-codebase to declare git_worktree_dir "
        + "and bind it with worktreeFromInputs/inputBindings.worktree so research agents inspect the same checkout that Ralph edits. "
        + "The installed deep-research-codebase cannot guarantee worktree locality. Upgrade @bastani/workflows or run with empty git_worktree_dir.",
    );
  }

  return {
    git_worktree_dir: options.effectiveWorktreeDir,
    ...(inputNames.has("base_branch") ? { base_branch: options.baseBranch } : {}),
  };
}

function reportReadPaths(
  researchOutputs: Record<string, unknown>,
  literalOutputs: RalphOutputSummary,
  idiomaticOutputs: RalphOutputSummary,
): string[] {
  return [
    researchOutputs.research_doc_path,
    researchOutputs.artifact_dir,
    researchOutputs.manifest_path,
    literalOutputs.plan_path,
    literalOutputs.implementation_notes_path,
    literalOutputs.review_report_path,
    idiomaticOutputs.plan_path,
    idiomaticOutputs.implementation_notes_path,
    idiomaticOutputs.review_report_path,
  ].map((path) => text(path)).filter((path) => path.length > 0);
}

export default defineWorkflow(WORKFLOW_NAME)
  .description("Research and execute a large legacy-to-target-stack migration through deep-research-codebase plus two Ralph passes, then save a final handoff report.")
  .input("migration_request", Type.String({
    description: "Migration spec path or free-form migration prompt. Required and treated as the invariant charter for all stages.",
  }))
  .input("base_branch", Type.String({
    default: DEFAULT_BASE_BRANCH,
    description: "Branch/ref used for Ralph review comparison and reusable worktree creation.",
  }))
  .input("git_worktree_dir", Type.String({
    default: "",
    description: "Optional reusable Git worktree path. Empty runs in the invoking checkout; non-empty values use Atomic's Ralph-style reusable worktree binding.",
  }))
  .input("max_research_concurrency", Type.Number({
    default: DEFAULT_MAX_RESEARCH_CONCURRENCY,
    description: "How many research tasks can run at once. Higher can finish faster but uses more compute/API capacity.",
  }))
  .input("max_translation_loops", Type.Number({
    default: DEFAULT_MAX_TRANSLATION_LOOPS,
    description: "How many times Atomic may try to complete the initial code translation before stopping.",
  }))
  .input("max_idiomatic_loops", Type.Number({
    default: DEFAULT_MAX_IDIOMATIC_LOOPS,
    description: "How many times Atomic may refine the translated code for cleaner, more idiomatic results.",
  }))
  .worktreeFromInputs({
    gitWorktreeDir: "git_worktree_dir",
    baseBranch: "base_branch",
  })
  .output("result", Type.String({ description: "Final migration summary and next steps." }))
  .output("migration_report_path", Type.String({ description: "Path to the final developer-facing migration handoff report." }))
  .output("research_doc_path", Type.String({ description: "Path to the deep research report used for implementation." }))
  .output("research_artifact_dir", Type.Optional(Type.String({ description: "Deep research artifact directory when returned." })))
  .output("research_manifest_path", Type.Optional(Type.String({ description: "Deep research manifest path when returned." })))
  .output("literal_translation", ralphOutputSchema)
  .output("idiomatic_cleanup", ralphOutputSchema)
  .output("approved", Type.Optional(Type.Boolean({ description: "Whether the final idiomatic Ralph pass was approved." })))
  .output("worktree_dir", Type.String({ description: "Effective shared worktree root used by deep research and Ralph when reusable-worktree mode is active, or empty when the invoking checkout was used." }))
  .run(async (ctx) => {
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const migrationRequest = text(ctx.inputs.migration_request);
    if (migrationRequest.length === 0) {
      throw new Error("codebase-migration requires a non-empty migration_request input.");
    }

    const requestReference = await migrationRequestReference(migrationRequest, cwd);
    const baseBranch = text(ctx.inputs.base_branch, DEFAULT_BASE_BRANCH);
    const gitWorktreeDir = text(ctx.inputs.git_worktree_dir);
    const effectiveWorktreeDir = await resolveEffectiveWorktreeDir({
      requestedGitWorktreeDir: gitWorktreeDir,
      effectiveWorkflowCwd: cwd,
    });
    const deepResearchWorktreeInputs = requireDeepResearchWorktreeInputs({
      workflow: deepResearchCodebase,
      requestedGitWorktreeDir: gitWorktreeDir,
      effectiveWorktreeDir,
      baseBranch,
    });

    const research = await ctx.workflow(deepResearchCodebase, {
      stageName: "deep research migration surface",
      inputs: {
        prompt: buildDeepResearchPrompt(requestReference),
        max_concurrency: Number(ctx.inputs.max_research_concurrency ?? DEFAULT_MAX_RESEARCH_CONCURRENCY),
        ...deepResearchWorktreeInputs,
      },
    });
    const researchOutputs = childOutputs(research);
    const researchDocPath = text(researchOutputs.research_doc_path);
    if (researchDocPath.length === 0) {
      throw new Error("codebase-migration expected deep-research-codebase to return research_doc_path, but it was missing. Cannot continue to Ralph passes without the research handoff artifact.");
    }

    const literal = await ctx.workflow(ralph, {
      stageName: "literal translation pass",
      inputs: {
        prompt: buildLiteralTranslationPrompt({
          migrationRequest: requestReference,
          researchDocPath,
        }),
        base_branch: baseBranch,
        git_worktree_dir: effectiveWorktreeDir,
        max_loops: Number(ctx.inputs.max_translation_loops ?? DEFAULT_MAX_TRANSLATION_LOOPS),
      },
    });
    const literalOutputs = selectedRalphOutputs(literal);

    const idiomatic = await ctx.workflow(ralph, {
      stageName: "idiomatic cleanup pass",
      inputs: {
        prompt: buildIdiomaticCleanupPrompt({
          migrationRequest: requestReference,
          researchDocPath,
          literalOutputs,
        }),
        base_branch: baseBranch,
        git_worktree_dir: effectiveWorktreeDir,
        max_loops: Number(ctx.inputs.max_idiomatic_loops ?? DEFAULT_MAX_IDIOMATIC_LOOPS),
      },
    });
    const idiomaticOutputs = selectedRalphOutputs(idiomatic);

    const readPaths = reportReadPaths(researchOutputs, literalOutputs, idiomaticOutputs);
    const reportDraft = await ctx.task("migration handoff report", {
      reads: readPaths,
      prompt: buildMigrationReportPrompt({
        migrationRequest: requestReference,
        researchDocPath,
        researchArtifactDir: text(researchOutputs.artifact_dir),
        researchManifestPath: text(researchOutputs.manifest_path),
        literalOutputs,
        idiomaticOutputs,
      }),
    });

    const savedReport = await writeMigrationReport({
      cwd,
      summary: reportTitleSeed(requestReference),
      report: text((reportDraft as { text?: unknown }).text, text(reportDraft)),
    });

    const approved = typeof idiomaticOutputs.approved === "boolean" ? idiomaticOutputs.approved : undefined;
    const result = [
      `Codebase migration orchestration complete. Final report: ${savedReport.reportPath}`,
      `Research artifact: ${researchDocPath}`,
      approved === undefined ? "Final Ralph approval: unavailable" : `Final Ralph approval: ${approved ? "approved" : "not approved"}`,
      "Review the report, Ralph artifacts, repository diff, and validation evidence before committing or deploying.",
    ].join("\n");

    const workflowOutputs: Record<string, unknown> = {
      result,
      migration_report_path: savedReport.reportPath,
      research_doc_path: researchDocPath,
      literal_translation: literalOutputs,
      idiomatic_cleanup: idiomaticOutputs,
      worktree_dir: effectiveWorktreeDir,
    };
    const researchArtifactDir = text(researchOutputs.artifact_dir);
    const researchManifestPath = text(researchOutputs.manifest_path);
    if (researchArtifactDir.length > 0) {
      workflowOutputs.research_artifact_dir = researchArtifactDir;
    }
    if (researchManifestPath.length > 0) {
      workflowOutputs.research_manifest_path = researchManifestPath;
    }
    if (approved !== undefined) {
      workflowOutputs.approved = approved;
    }

    return workflowOutputs;
  })
  .compile();
