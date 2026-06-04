export const DEFAULT_BASE_BRANCH = "origin/main";
export const DEFAULT_MAX_RESEARCH_CONCURRENCY = 100;
export const DEFAULT_MAX_TRANSLATION_LOOPS = 10;
export const DEFAULT_MAX_IDIOMATIC_LOOPS = 10;

export type MigrationRequestKind = "path" | "inline";

export interface MigrationRequestReference {
  kind: MigrationRequestKind;
  value: string;
  promptBlock: string;
}

export interface LiteralTranslationPromptOptions {
  migrationRequest: MigrationRequestReference;
  researchDocPath: string;
}

export interface RalphOutputSummary {
  result?: unknown;
  plan_path?: unknown;
  implementation_notes_path?: unknown;
  review_report?: unknown;
  review_report_path?: unknown;
  pr_report?: unknown;
  approved?: unknown;
  iterations_completed?: unknown;
}

export interface IdiomaticCleanupPromptOptions {
  migrationRequest: MigrationRequestReference;
  researchDocPath: string;
  literalOutputs: RalphOutputSummary;
}

export interface MigrationReportPromptOptions {
  migrationRequest: MigrationRequestReference;
  researchDocPath: string;
  researchArtifactDir?: string;
  researchManifestPath?: string;
  literalOutputs: RalphOutputSummary;
  idiomaticOutputs: RalphOutputSummary;
}

export function text(value: unknown, fallback = ""): string {
  const result = String(value ?? fallback).trim();
  return result.length > 0 ? result : fallback;
}

export function formatMigrationRequestReference(
  migrationRequest: string,
  kind: MigrationRequestKind = "inline",
): MigrationRequestReference {
  const value = text(migrationRequest);
  if (kind === "path") {
    return {
      kind,
      value,
      promptBlock: [
        `Migration request/spec path: ${value}`,
        `Read the migration request/spec at \`${value}\` and treat it as the invariant migration charter for every stage.`,
        "Do not copy the full spec into outputs unless a concise excerpt is necessary for review context.",
      ].join("\n"),
    };
  }

  return {
    kind,
    value,
    promptBlock: [
      "Migration request/spec provided inline. Treat this as the invariant migration charter for every stage:",
      "```text",
      value,
      "```",
    ].join("\n"),
  };
}

export const STARTER_MIGRATION_RESEARCH_PROMPT = `You are performing senior-engineering discovery for a large codebase migration.

Build a concrete migration inventory before any implementation starts. Identify the legacy/source stack, target stack, runtime boundaries, build and deployment systems, external contracts, data models, auth/session behavior, routing/API surfaces, background jobs, configuration, tests, fixtures, generated code, and operational assumptions.

Create a file-by-file migration map where possible. For each major component, explain current behavior, dependencies, target-stack translation considerations, validation strategy, risk, sequencing, and unknowns. Call out behavior that must be preserved exactly during a first literal translation pass and areas that are candidates for later idiomatic cleanup or safe deduplication.

Prefer artifact paths and concise references over large inline excerpts. Cite repository files and commands used as evidence.`;

export function buildDeepResearchPrompt(migrationRequest: MigrationRequestReference): string {
  return [
    STARTER_MIGRATION_RESEARCH_PROMPT,
    "",
    "Migration charter:",
    migrationRequest.promptBlock,
    "",
    "Research deliverable requirements:",
    "- Inventory routing, APIs, data models, persistence, auth, authorization, config, build tooling, tests, deployment, and external integrations.",
    "- Map legacy/source files to likely target-stack files and note behavior-preserving translation hazards.",
    "- Identify focused validation commands and fixtures Ralph should run during implementation.",
    "- Separate literal-translation constraints from later idiomatic cleanup opportunities.",
    "- Produce a durable research_doc_path artifact for downstream Ralph passes.",
  ].join("\n");
}

export function buildLiteralTranslationPrompt(options: LiteralTranslationPromptOptions): string {
  return [
    "Run the literal 1:1 translation pass for this migration.",
    "",
    "Invariant migration charter:",
    options.migrationRequest.promptBlock,
    "",
    `Primary research artifact: ${options.researchDocPath}`,
    `Read the deep-research report at \`${options.researchDocPath}\` before planning or editing. Use it as the source of file mapping, behavioral requirements, and validation commands.`,
    "",
    "Pass 1 constraints:",
    "- Preserve existing behavior and public contracts over elegance.",
    "- Translate files/modules 1:1 where practical (for example, old/source file to equivalent target-stack file) so reviewers can trace parity.",
    "- Intentionally keep duplicated code, awkward structure, and mechanical translations when that reduces behavior risk.",
    "- Do not perform broad idiomatic refactors, deduplication, architectural reshaping, dependency swaps, or unrelated cleanup yet.",
    "- Keep large research/report handoffs path-based; cite artifact paths rather than pasting full reports.",
    "- Run focused validation discovered during research and record exact commands, failures, skipped checks, and rationale.",
    "- Use Ralph’s normal pull-request handoff behavior when the literal translation is ready.",
    "- Do not deploy or run destructive git cleanup.",
  ].join("\n");
}

function optionalOutputLine(label: string, value: unknown): string | undefined {
  const rendered = text(value);
  return rendered.length > 0 ? `- ${label}: ${rendered}` : undefined;
}

export function formatRalphArtifacts(outputs: RalphOutputSummary): string {
  const lines = [
    optionalOutputLine("plan_path", outputs.plan_path),
    optionalOutputLine("implementation_notes_path", outputs.implementation_notes_path),
    optionalOutputLine("review_report_path", outputs.review_report_path),
    optionalOutputLine("pr_report", outputs.pr_report),
    optionalOutputLine("approved", outputs.approved),
    optionalOutputLine("iterations_completed", outputs.iterations_completed),
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join("\n") : "- No structured Ralph artifact paths were returned; inspect the literal pass result/output in the parent run.";
}

export function buildIdiomaticCleanupPrompt(options: IdiomaticCleanupPromptOptions): string {
  return [
    "Run the idiomatic target-stack cleanup pass for this migration.",
    "",
    "Invariant migration charter:",
    options.migrationRequest.promptBlock,
    "",
    `Primary research artifact: ${options.researchDocPath}`,
    `Read the deep-research report at \`${options.researchDocPath}\` and the literal pass artifacts before planning or editing.`,
    "",
    "Literal translation pass artifacts/output paths:",
    formatRalphArtifacts(options.literalOutputs),
    "",
    "Pass 2 constraints:",
    "- Start from the literal translation already present in the same checkout/worktree.",
    "- Convert the result to idiomatic target-stack structure, naming, error handling, dependency use, and tests where safe.",
    "- Deduplicate only when behavior remains preserved and reviewability does not suffer.",
    "- Keep parity with the original migration charter and research findings; do not expand scope.",
    "- Run lint/type-check/focused tests discovered during research and any relevant target-stack validation, fixing failures when feasible.",
    "- Record behavior parity notes, validation evidence, remaining gaps, and review guidance.",
    "- Use Ralph’s normal pull-request handoff behavior when the implementation is ready.",
    "- Do not deploy or run destructive git cleanup.",
  ].join("\n");
}

export function buildMigrationReportPrompt(options: MigrationReportPromptOptions): string {
  const readPaths = [
    options.researchDocPath,
    options.researchArtifactDir,
    options.researchManifestPath,
    text(options.literalOutputs.plan_path),
    text(options.literalOutputs.implementation_notes_path),
    text(options.literalOutputs.review_report_path),
    text(options.idiomaticOutputs.plan_path),
    text(options.idiomaticOutputs.implementation_notes_path),
    text(options.idiomaticOutputs.review_report_path),
  ].filter((path) => path.length > 0);

  return [
    "Write the final developer-facing migration handoff report in Markdown.",
    "",
    "Invariant migration charter:",
    options.migrationRequest.promptBlock,
    "",
    "Use artifact paths as the source of detailed evidence instead of relying on inline transcripts:",
    ...readPaths.map((path) => `- ${path}`),
    "",
    "Literal translation pass outputs:",
    formatRalphArtifacts(options.literalOutputs),
    "",
    "Idiomatic cleanup pass outputs:",
    formatRalphArtifacts(options.idiomaticOutputs),
    "",
    "Include these sections:",
    "1. Executive summary",
    "2. Migration scope and target stack",
    "3. Research source and artifact index",
    "4. File/component mapping",
    "5. Literal translation pass summary",
    "6. Idiomatic cleanup and safe deduplication summary",
    "7. Behavior parity notes",
    "8. Validation evidence with exact commands/results/skips",
    "9. Operational/deployment notes",
    "10. Rollback/fallback plan",
    "11. Known gaps and follow-up work",
    "12. PR review guide",
    "",
    "Do not claim tests passed unless artifacts show that evidence. Do not include credentials, secrets, or full environment dumps. The workflow runtime will save this report to disk after this stage.",
  ].join("\n");
}

export function reportTitleSeed(migrationRequest: MigrationRequestReference): string {
  if (migrationRequest.kind === "path") {
    return migrationRequest.value.split(/[\\/]/).filter(Boolean).at(-1) ?? "migration";
  }

  return migrationRequest.value;
}
