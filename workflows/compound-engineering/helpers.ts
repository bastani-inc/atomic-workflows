import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const COMPOUND_MODES = ["auto", "brainstorm", "plan", "work", "review", "compound-only"] as const;
export type CompoundMode = (typeof COMPOUND_MODES)[number];
export type ResolvedCompoundMode = Exclude<CompoundMode, "auto">;

export const IMPLEMENTATION_RUNNERS = ["auto", "goal", "ralph", "handoff-only"] as const;
export type ImplementationRunner = (typeof IMPLEMENTATION_RUNNERS)[number];
export type ResolvedImplementationRunner = Exclude<ImplementationRunner, "auto">;

export const LEARNING_MODES = ["ask", "off", "lightweight", "full"] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];

export const MEMORY_SCOPES = ["repo", "none"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const WORKFLOW_STATUSES = [
  "complete",
  "approved",
  "handoff_ready",
  "review_only",
  "blocked",
  "needs_human",
  "rejected",
  "stopped",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const REVIEW_CRITERIA = [
  "independent",
  "acceptance_mapped",
  "diff_aware",
  "validation_backed",
  "risk_aware",
  "fresh",
] as const;
export type ReviewCriterion = (typeof REVIEW_CRITERIA)[number];

export type ReviewGateDecision = "sufficient" | "targeted_review" | "full_review" | "fixes_needed" | "needs_human" | "blocked";

export type SeverityCounts = {
  p0?: number;
  p1?: number;
  p2?: number;
  p3?: number;
};

export type ReviewEvidence = {
  independent?: boolean;
  acceptance_mapped?: boolean;
  diff_aware?: boolean;
  validation_backed?: boolean;
  risk_aware?: boolean;
  fresh?: boolean;
  severity_counts?: SeverityCounts;
  conflicted?: boolean;
  validation_failed?: boolean;
  blocked?: boolean;
};

export type ReviewEvidenceReduction = {
  decision: ReviewGateDecision;
  missing: ReviewCriterion[];
  severity_counts: Required<SeverityCounts>;
  reason: string;
};

export type ChildHandoff = {
  workflow: "goal" | "ralph" | "handoff-only";
  inputs: Record<string, unknown>;
  command?: string;
  safe_note: string;
};

export type SavedStageReport = {
  path: string;
  body: string;
  source: "saved-file" | "inline-fallback";
};

export function text(value: unknown, fallback = ""): string {
  const result = String(value ?? fallback).trim();
  return result.length > 0 ? result : fallback;
}

function unknownToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && "text" in value) {
    const textValue = (value as { text?: unknown }).text;
    if (typeof textValue === "string") return textValue;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isFileOnlySavedOutputReference(value: string): boolean {
  const firstSubstantiveLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

  return /^(?:output saved to|saved output to|saved to):\s*\S+/i.test(firstSubstantiveLine);
}

export async function loadSavedStageReport(path: string, stageResult: unknown): Promise<SavedStageReport> {
  try {
    const body = await readFile(path, "utf8");
    if (body.trim().length === 0) throw new Error(`Saved stage report is empty: ${path}`);
    return { path, body, source: "saved-file" };
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Saved stage report is unreadable: ${path}: ${message}`);
    }
    // Controlled fallback below keeps tests/mocks usable while still rejecting
    // compact file-only references as evidence.
  }

  const inlineBody = unknownToText(stageResult);
  if (inlineBody.trim().length > 0 && !isFileOnlySavedOutputReference(inlineBody)) {
    return { path, body: inlineBody, source: "inline-fallback" };
  }

  throw new Error(`Saved stage report is missing, empty, or only a compact output reference/file-only pointer: ${path}`);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return text(stdout);
}

async function resolveGitTopLevel(cwd: string): Promise<string> {
  try {
    const gitRoot = await git(["rev-parse", "--show-toplevel"], cwd);
    if (gitRoot.length === 0) throw new Error("git returned an empty top-level path");
    return isAbsolute(gitRoot) ? gitRoot : resolve(cwd, gitRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `compound-engineering could not derive the effective worktree root from ctx.cwd (${cwd}). `
        + `When git_worktree_dir is non-empty, ctx.cwd must be inside the parent-bound Git worktree. git rev-parse --show-toplevel failed: ${message}`,
    );
  }
}

export async function resolveEffectiveWorktreeRoot(requestedGitWorktreeDir: string, effectiveWorkflowCwd: string): Promise<string> {
  if (text(requestedGitWorktreeDir).length === 0) return "";
  return resolveGitTopLevel(effectiveWorkflowCwd);
}

export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isCompoundMode(value: unknown): value is CompoundMode {
  return COMPOUND_MODES.includes(value as CompoundMode);
}

export function isImplementationRunner(value: unknown): value is ImplementationRunner {
  return IMPLEMENTATION_RUNNERS.includes(value as ImplementationRunner);
}

export function isLearningMode(value: unknown): value is LearningMode {
  return LEARNING_MODES.includes(value as LearningMode);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return MEMORY_SCOPES.includes(value as MemoryScope);
}

function promptHasReviewKeyword(value: string): boolean {
  return /\b(review|audit|gate|security check|code review)\b/i.test(value);
}

function promptLooksLikePullRequestReference(value: string): boolean {
  return /^#?\d+$/.test(value)
    || /^https?:\/\/\S+\/pull\/\d+\b/i.test(value)
    || /^pr[:#\s]+\d+$/i.test(value);
}

function promptLooksLikeBranchRange(value: string): boolean {
  return /^[\w./-]+\.\.[\w./-]+$/.test(value);
}

export function promptLooksLikeReviewTarget(prompt: string): boolean {
  const value = prompt.trim();
  return promptHasReviewKeyword(value)
    || promptLooksLikePullRequestReference(value)
    || promptLooksLikeBranchRange(value);
}

export function promptLooksLikeLearningCapture(prompt: string): boolean {
  return /\b(learned|learning|lessons?|solution note|capture knowledge|update concepts|docs\/solutions|postmortem)\b/i.test(prompt);
}

export function promptLooksLikePlanOrSpecPath(prompt: string): "spec" | "plan" | "brainstorm" | undefined {
  const value = prompt.trim().replace(/^['"]|['"]$/g, "");
  if (/\s/.test(value) || value.length === 0) return undefined;
  if (/^(?:\.\/)?specs\/[^\0]+\.md$/i.test(value)) return "spec";
  if (/^(?:\.\/)?docs\/plans\/[^\0]+\.md$/i.test(value)) return "plan";
  if (/^(?:\.\/)?docs\/brainstorms\/[^\0]+\.md$/i.test(value)) return "brainstorm";
  return undefined;
}

export function promptLooksVagueOrProductShaped(prompt: string): boolean {
  const words = prompt.split(/\s+/).filter(Boolean);
  const productSignal = /\b(improve|better|onboarding|activation|experience|flow|idea|explore|maybe|help users|make it easier|product|strategy|roadmap)\b/i.test(prompt);
  const concreteSignal = /\b(api|endpoint|database|schema|migration|test|bug|error|auth|cli|config|typescript|react|sql|cache|worker|specs?\/)\b/i.test(prompt);
  return (words.length < 8 && !concreteSignal) || (productSignal && !concreteSignal);
}

export function resolveMode(promptInput: string, requestedMode: CompoundMode = "auto"): ResolvedCompoundMode {
  if (requestedMode !== "auto") return requestedMode;

  const prompt = text(promptInput);
  const pathKind = promptLooksLikePlanOrSpecPath(prompt);
  if (pathKind === "spec" || pathKind === "plan") return "work";
  if (pathKind === "brainstorm") return "plan";
  if (promptLooksLikeReviewTarget(prompt)) return "review";
  if (promptLooksLikeLearningCapture(prompt)) return "compound-only";
  if (promptLooksVagueOrProductShaped(prompt)) return "brainstorm";
  return "work";
}

export function resolveRunner(requestedRunner: ImplementationRunner = "auto"): ResolvedImplementationRunner {
  if (requestedRunner !== "auto") return requestedRunner;

  // Iteration 3 keeps automatic runner selection safe-by-default: automatic
  // selection never launches a code-changing child workflow. Only explicit
  // goal/ralph requests may run implementation after human approval.
  return "handoff-only";
}

export type ApprovalDecision = "approved" | "rejected" | "revise" | "stopped";

export function parseApprovalDecision(input: unknown): ApprovalDecision {
  const value = text(input).toLowerCase();
  if (/\b(stop|cancel|abort|quit)\b/.test(value)) return "stopped";
  if (/\b(reject|rejected|no|decline|do not proceed)\b/.test(value)) return "rejected";
  if (/\b(revise|revision|change|adjust|edit|needs work)\b/.test(value)) return "revise";
  if (/\b(approve|approved|yes|proceed|ship|looks good|lgtm)\b/.test(value)) return "approved";
  return "revise";
}

function countSeverity(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function hasMalformedSeverityCount(value: unknown): boolean {
  return value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0);
}

function hasMalformedSeverityCounts(counts: SeverityCounts | undefined): boolean {
  if (counts === undefined) return false;
  return hasMalformedSeverityCount(counts.p0)
    || hasMalformedSeverityCount(counts.p1)
    || hasMalformedSeverityCount(counts.p2)
    || hasMalformedSeverityCount(counts.p3);
}

export function normalizeSeverityCounts(counts: SeverityCounts = {}): Required<SeverityCounts> {
  return {
    p0: countSeverity(counts.p0),
    p1: countSeverity(counts.p1),
    p2: countSeverity(counts.p2),
    p3: countSeverity(counts.p3),
  };
}

export function missingReviewCriteria(evidence: ReviewEvidence): ReviewCriterion[] {
  return REVIEW_CRITERIA.filter((criterion) => evidence[criterion] !== true);
}

export function reduceReviewEvidence(evidence: ReviewEvidence): ReviewEvidenceReduction {
  const severity_counts = normalizeSeverityCounts(evidence.severity_counts);
  const missing = missingReviewCriteria(evidence);

  if (evidence.blocked === true) {
    return { decision: "blocked", missing, severity_counts, reason: "Review or validation is blocked by missing dependencies or unavailable evidence." };
  }
  if (evidence.conflicted === true) {
    return { decision: "needs_human", missing, severity_counts, reason: "Review evidence is conflicted and needs a human decision." };
  }
  if (hasMalformedSeverityCounts(evidence.severity_counts)) {
    return { decision: "needs_human", missing, severity_counts, reason: "Review severity counts are malformed; p0/p1/p2/p3 must be non-negative integers." };
  }
  if (severity_counts.p0 > 0 || severity_counts.p1 > 0) {
    return { decision: "fixes_needed", missing, severity_counts, reason: "Blocking P0/P1 findings remain." };
  }
  if (evidence.validation_failed === true) {
    return { decision: "needs_human", missing, severity_counts, reason: "Validation failed after implementation or fixes." };
  }
  if (missing.length === 0) {
    return { decision: "sufficient", missing, severity_counts, reason: "Review evidence satisfies all sufficiency criteria." };
  }
  if (missing.includes("fresh") || missing.length > 1) {
    return { decision: "full_review", missing, severity_counts, reason: "Evidence is stale or missing multiple required review dimensions." };
  }
  return { decision: "targeted_review", missing, severity_counts, reason: `Evidence is missing ${missing[0]}.` };
}

export function slugifyTopic(value: unknown, fallback = "compound-engineering"): string {
  const slug = text(value, fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
  return slug.length > 0 ? slug : fallback;
}

export function datedMarkdownPath(directory: string, topic: unknown, fallback: string, now = new Date()): string {
  return join(directory, `${today(now)}-${slugifyTopic(topic, fallback)}.md`);
}

export function normalizeCreatePr(value: unknown): boolean {
  return value === true;
}

function quoteWorkflowValue(value: unknown): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function buildChildWorkflowCommand(options: {
  runner: Exclude<ResolvedImplementationRunner, "handoff-only">;
  prompt: string;
  maxLoops: number;
  baseBranch: string;
  gitWorktreeDir: string;
  createPr: boolean;
}): string {
  if (options.runner === "goal") {
    return [
      "/workflow",
      "goal",
      `objective=${quoteWorkflowValue(options.prompt)}`,
      `max_turns=${options.maxLoops}`,
      `base_branch=${quoteWorkflowValue(options.baseBranch)}`,
    ].join(" ");
  }

  return [
    "/workflow",
    "ralph",
    `prompt=${quoteWorkflowValue(options.prompt)}`,
    `max_loops=${options.maxLoops}`,
    `base_branch=${quoteWorkflowValue(options.baseBranch)}`,
    `git_worktree_dir=${quoteWorkflowValue(options.gitWorktreeDir)}`,
    `create_pr=${options.createPr ? "true" : "false"}`,
  ].join(" ");
}

export function buildChildHandoff(options: {
  runner: ResolvedImplementationRunner;
  approvedPath: string;
  prompt: string;
  maxLoops: number;
  baseBranch: string;
  gitWorktreeDir: string;
  createPr: boolean;
}): ChildHandoff {
  const safe_note = "Iteration 3 launches explicit goal/ralph runners only after human approval; auto and handoff-only remain non-mutating.";
  if (options.runner === "handoff-only") {
    return {
      workflow: "handoff-only",
      inputs: {
        approved_path: options.approvedPath,
        prompt: options.prompt,
        max_loops: options.maxLoops,
        base_branch: options.baseBranch,
        git_worktree_dir: options.gitWorktreeDir,
        create_pr: false,
      },
      safe_note,
    };
  }

  const childPrompt = [
    `Implement the approved Compound Engineering plan/spec at ${options.approvedPath}. Original request: ${options.prompt}`,
    "",
    "After implementation and your own internal review, return only the child workflow's declared outputs and review artifacts. Do not rely on undeclared parent-specific child output keys.",
    "Place structured review evidence in the declared `review_report`/`review_report_path` artifact when the runner supports it; Goal should also return status=complete only when done.",
    "The artifact may include a compact JSON object named `review_evidence` with this JSON-serializable shape:",
    "{",
    "  independent: { satisfied: boolean, evidence?: string, source?: string },",
    "  acceptance_mapped: { satisfied: boolean, evidence?: string },",
    "  diff_aware: { satisfied: boolean, evidence?: string },",
    "  validation_backed: { satisfied: boolean, evidence?: string, commands?: [{ command?: string, exit_code?: number, summary?: string }] },",
    "  risk_aware: { satisfied: boolean, evidence?: string },",
    "  fresh: { satisfied: boolean, evidence?: string },",
    "  severity_counts: { p0: number, p1: number, p2: number, p3: number },",
    "  blocked?: boolean,",
    "  conflicted?: boolean,",
    "  validation_failed?: boolean",
    "}",
    "Every satisfied criterion must include explicit evidence text or, for validation, passing command summaries/zero exit codes. Set blocked/conflicted/validation_failed truthfully when applicable.",
  ].join("\n");
  const createPr = normalizeCreatePr(options.createPr);
  const inputs: Record<string, unknown> = options.runner === "goal"
    ? {
      objective: childPrompt,
      max_turns: options.maxLoops,
      base_branch: options.baseBranch,
    }
    : {
      prompt: childPrompt,
      max_loops: options.maxLoops,
      base_branch: options.baseBranch,
      git_worktree_dir: options.gitWorktreeDir,
      create_pr: createPr,
    };

  return {
    workflow: options.runner,
    inputs,
    command: buildChildWorkflowCommand({
      runner: options.runner,
      prompt: childPrompt,
      maxLoops: options.maxLoops,
      baseBranch: options.baseBranch,
      gitWorktreeDir: options.gitWorktreeDir,
      createPr,
    }),
    safe_note,
  };
}

function sanitizeRunId(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

export function timestampRunId(now = new Date()): string {
  return sanitizeRunId(now.toISOString().replace(/[:.]/g, "-"));
}

export function displayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function createArtifactRun(workflowName: string, startedAt: Date, cwd = process.cwd()): Promise<{ runId: string; artifactDir: string }> {
  const runId = timestampRunId(startedAt);
  const artifactDir = join(cwd, `.${workflowName}-${runId}`);
  await mkdir(artifactDir, { recursive: true });
  return { runId, artifactDir };
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function suffixedPath(path: string, suffix: number): string {
  const extension = extname(path);
  if (extension.length === 0) return `${path}-${suffix}`;
  return `${path.slice(0, -extension.length)}-${suffix}${extension}`;
}

async function writeNewFile(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isFileExistsError(error)) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

export async function nextAvailablePath(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  if (!await pathExists(path)) return path;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = suffixedPath(path, suffix);
    if (!await pathExists(candidate)) return candidate;
  }
}

export async function writeMarkdown(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const body = `${content.trimEnd()}\n`;
  if (await writeNewFile(path, body)) return path;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = suffixedPath(path, suffix);
    if (await writeNewFile(candidate, body)) return candidate;
  }
}

export async function writeJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}
