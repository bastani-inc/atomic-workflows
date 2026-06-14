import { join } from "node:path";
import { defineWorkflow, Type } from "@bastani/workflows";
import { goal, ralph } from "@bastani/workflows/builtin";
import {
  SEVERITY_LEVELS,
  emptySeverityCounts,
  gateChildRunCompletion,
  isRecord,
  loadChildReviewArtifact,
  optionalNonEmptyString,
  parseEvidenceFromText,
  type ChildReviewArtifact,
  type SeverityLevel,
} from "./lib/review-evidence.js";
import {
  buildChildHandoff,
  createArtifactRun,
  datedMarkdownPath,
  displayPath,
  isCompoundMode,
  isImplementationRunner,
  isLearningMode,
  isMemoryScope,
  loadSavedStageReport,
  nextAvailablePath,
  normalizeCreatePr,
  normalizeSeverityCounts,
  parseApprovalDecision,
  positiveInteger,
  REVIEW_CRITERIA,
  reduceReviewEvidence,
  resolveEffectiveWorktreeRoot,
  resolveMode,
  resolveRunner,
  text,
  writeJson,
  writeMarkdown,
  WORKFLOW_STATUSES,
  type CompoundMode,
  type ImplementationRunner,
  type LearningMode,
  type MemoryScope,
  type ResolvedCompoundMode,
  type ResolvedImplementationRunner,
  type ReviewCriterion,
  type ReviewEvidence,
  type SeverityCounts,
  type WorkflowStatus,
} from "./helpers.js";

const WORKFLOW_NAME = "compound-engineering";
const DEFAULT_MAX_LOOPS = 5;
const DEFAULT_BASE_BRANCH = "origin/main";
const FILE_ONLY_OUTPUT = "file-only" as const;
const EVERY_INC_CREDIT = "Inspired by EveryInc's MIT-licensed Compound Engineering Plugin process vocabulary: brainstorm → plan → work → review → compound learning.";

const GOAL_CHILD_OUTPUT_KEYS = [
  "result",
  "status",
  "approved",
  "goal_id",
  "objective",
  "ledger_path",
  "turns_completed",
  "iterations_completed",
  "receipts",
  "remaining_work",
  "review_report",
  "review_report_path",
] as const;

const RALPH_CHILD_OUTPUT_KEYS = [
  "result",
  "plan",
  "plan_path",
  "implementation_notes_path",
  "pr_report",
  "approved",
  "iterations_completed",
  "review_report",
  "review_report_path",
] as const;

function declaredChildOutputKeys(runner: Exclude<ResolvedImplementationRunner, "handoff-only">): readonly string[] {
  return runner === "goal" ? GOAL_CHILD_OUTPUT_KEYS : RALPH_CHILD_OUTPUT_KEYS;
}

const resolvedModeSchema = Type.Union([
  Type.Literal("brainstorm"),
  Type.Literal("plan"),
  Type.Literal("work"),
  Type.Literal("review"),
  Type.Literal("compound-only"),
]);

const resolvedRunnerSchema = Type.Union([
  Type.Literal("goal"),
  Type.Literal("ralph"),
  Type.Literal("handoff-only"),
]);

const statusSchema = Type.Union(WORKFLOW_STATUSES.map((status) => Type.Literal(status)));

function fileOnlyOutput(output: string): { output: string; outputMode: typeof FILE_ONLY_OUTPUT } {
  return { output, outputMode: FILE_ONLY_OUTPUT };
}

function artifactMarkdown(title: string, body: string): string {
  return [`# ${title}`, "", body.trim(), "", `Attribution: ${EVERY_INC_CREDIT}`].join("\n");
}

function manifestArtifacts(paths: ReadonlyMap<string, string>, manifestPath: string): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const [name, path] of paths) {
    artifacts[name] = displayPath(path);
  }
  artifacts.manifest = displayPath(manifestPath);
  return artifacts;
}



function childOutputs(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) return {};
  const record = result as Record<string, unknown>;
  const nested = record.outputs;
  return typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : record;
}

function omitUndefined(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => omitUndefined(item, seen) ?? null);
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = omitUndefined(childValue, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function outputRecord(value: Record<string, unknown>): Record<string, unknown> {
  return omitUndefined(value) as Record<string, unknown>;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizedChildOutput(result: unknown, runner: Exclude<ResolvedImplementationRunner, "handoff-only">): Record<string, unknown> {
  const outputs = childOutputs(result);
  const declaredKeys = declaredChildOutputKeys(runner);
  const declaredKeySet = new Set<string>(declaredKeys);
  const selected: Record<string, unknown> = {};
  for (const key of declaredKeys) {
    if (outputs[key] !== undefined) selected[key] = outputs[key];
  }

  const unknownChildOutputKeys = Object.keys(outputs)
    .filter((key) => !declaredKeySet.has(key))
    .sort();
  if (unknownChildOutputKeys.length > 0) selected.unknown_child_output_keys = unknownChildOutputKeys;

  return outputRecord(selected);
}

function childWorkflowExited(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { exited?: unknown }).exited === true;
}

type ChildAtomicExitStatus = "blocked" | "cancelled" | "skipped";

function childExitRecord(result: unknown): Record<string, unknown> {
  return typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
}

function childExitStatus(result: unknown): ChildAtomicExitStatus {
  const record = childExitRecord(result);
  const nestedExit = isRecord(record.exit) ? record.exit : undefined;
  const rawStatus = optionalNonEmptyString(record.status)
    ?? optionalNonEmptyString(record.exit_status)
    ?? optionalNonEmptyString(nestedExit?.status);
  const normalized = rawStatus?.toLowerCase();
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "skipped") return "skipped";
  return "blocked";
}

function childExitReason(result: unknown, fallback: string): string {
  const record = childExitRecord(result);
  const nestedExit = isRecord(record.exit) ? record.exit : undefined;
  return optionalNonEmptyString(record.exitReason)
    ?? optionalNonEmptyString(record.reason)
    ?? optionalNonEmptyString(record.exit_reason)
    ?? optionalNonEmptyString(nestedExit?.reason)
    ?? fallback;
}

function domainStatusForChildExit(exitStatus: ChildAtomicExitStatus): WorkflowStatus {
  return exitStatus === "cancelled" || exitStatus === "skipped" ? "stopped" : "blocked";
}

function exitWorkflow(ctx: unknown, outputs: Record<string, unknown>, exitStatus: unknown = outputs.status, exitReason: unknown = outputs.message): Record<string, unknown> {
  const exit = typeof ctx === "object" && ctx !== null ? (ctx as { exit?: unknown }).exit : undefined;
  if (typeof exit === "function") {
    return exit.call(ctx, {
      status: exitStatus,
      reason: text(exitReason),
      outputs,
    }) as Record<string, unknown>;
  }
  return outputs;
}

const MAX_RECEIPT_STRING_CHARS = 2000;
const MAX_RECEIPT_COLLECTION_ITEMS = 50;
const MAX_RECEIPT_OBJECT_KEYS = 50;

function compactTextSummary(value: string): Record<string, unknown> {
  return {
    summary: value.slice(0, MAX_RECEIPT_STRING_CHARS),
    original_chars: value.length,
    omitted_chars: Math.max(0, value.length - MAX_RECEIPT_STRING_CHARS),
  };
}

function compactReceiptValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return value.length > MAX_RECEIPT_STRING_CHARS ? compactTextSummary(value) : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const items = value.slice(0, MAX_RECEIPT_COLLECTION_ITEMS).map((item) => compactReceiptValue(item, depth + 1, seen) ?? null);
    if (value.length <= MAX_RECEIPT_COLLECTION_ITEMS) return items;

    return { items, original_items: value.length, omitted_items: value.length - MAX_RECEIPT_COLLECTION_ITEMS };
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (depth >= 2) {
    const textValue = textFromUnknown(value);
    return textValue.length > MAX_RECEIPT_STRING_CHARS ? compactTextSummary(textValue) : textValue;
  }

  const compacted: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const keptEntries = entries.slice(0, MAX_RECEIPT_OBJECT_KEYS);
  for (const [key, childValue] of keptEntries) {
    const compactedValue = compactReceiptValue(childValue, depth + 1, seen);
    if (compactedValue !== undefined) compacted[key] = compactedValue;
  }

  const omittedEntries = entries.slice(MAX_RECEIPT_OBJECT_KEYS);
  if (omittedEntries.length > 0) {
    const omittedKeys = omittedEntries.map(([key]) => key);
    compacted.original_keys = entries.length;
    compacted.omitted_key_count = omittedEntries.length;
    compacted.omitted_keys = omittedKeys.slice(0, MAX_RECEIPT_OBJECT_KEYS);
  }

  return compacted;
}

const OMITTED_INLINE_RECEIPT_OUTPUT_KEYS = new Set(["plan", "receipts"]);

function compactChildOutputForReceipt(childOutput: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  const omittedInlineChildOutputKeys: string[] = [];
  for (const [key, value] of Object.entries(childOutput)) {
    if (OMITTED_INLINE_RECEIPT_OUTPUT_KEYS.has(key)) {
      omittedInlineChildOutputKeys.push(key);
      continue;
    }
    compacted[key] = compactReceiptValue(value);
  }
  if (omittedInlineChildOutputKeys.length > 0) compacted.omitted_inline_child_output_keys = omittedInlineChildOutputKeys.sort();
  return outputRecord(compacted);
}



const LEGACY_COMPOUND_ENGINEERING_EVIDENCE_KEY = "compound_engineering_evidence";
const DECLARED_REVIEW_EVIDENCE_KEYS = ["review_evidence", "compound_review_evidence"] as const;

type StructuredEvidenceCommand = {
  command?: string;
  exit_code?: number;
  summary?: string;
};

type StructuredEvidenceCriterion = {
  satisfied: boolean;
  evidence?: string;
  source?: string;
  commands?: StructuredEvidenceCommand[];
};

type CompoundEngineeringEvidence = {
  independent: StructuredEvidenceCriterion;
  acceptance_mapped: StructuredEvidenceCriterion;
  diff_aware: StructuredEvidenceCriterion;
  validation_backed: StructuredEvidenceCriterion;
  risk_aware: StructuredEvidenceCriterion;
  fresh: StructuredEvidenceCriterion;
  severity_counts: Required<SeverityCounts>;
  blocked?: boolean;
  conflicted?: boolean;
  validation_failed?: boolean;
};

type StructuredEvidenceGate = {
  childEvidence: ReviewEvidence;
  trace: Record<string, unknown>;
  missing: ReviewCriterion[];
  errors: string[];
  childReviewArtifact?: ChildReviewArtifact;
};



function compactErrorList(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, 20);
}

function hasSubstantiveEvidence(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

const PASSING_COMMAND_SUMMARY_PATTERN = /\b(?:pass(?:ed|es|ing)?|succeed(?:ed|s|ing)?|success(?:ful|fully)?|exit\s+(?:code|status)\s*:?\s*0|(?:exit_)?code\s*:?\s*0|status\s*:?\s*0|0\s+(?:failures?|errors?)|zero\s+(?:failures?|errors?)|no\s+(?:failures?|errors?)|all\s+tests?\s+passed)\b/i;
const FAILING_COMMAND_SUMMARY_PATTERN = /\b(?:failed|fails|failing|errored|non[-\s]?zero|exit\s+(?:code|status)\s*:?\s*[1-9]\d*|(?:exit_)?code\s*:?\s*[1-9]\d*|status\s*:?\s*[1-9]\d*|[1-9]\d*\s+(?:failures?|errors?)|(?:failures?|errors?)\s*:?\s*[1-9]\d*)\b/i;

function commandSummaryPasses(summary: unknown): boolean {
  if (typeof summary !== "string") return false;
  const value = summary.trim();
  return value.length > 0 && PASSING_COMMAND_SUMMARY_PATTERN.test(value) && !FAILING_COMMAND_SUMMARY_PATTERN.test(value);
}

function validationCommandsPass(commands: unknown): boolean {
  if (commands === undefined) return true;
  if (!Array.isArray(commands)) return false;
  for (const command of commands) {
    if (!isRecord(command)) return false;
    if (Object.prototype.hasOwnProperty.call(command, "exit_code")) {
      const exitCode = command.exit_code;
      if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode !== 0) return false;
      continue;
    }
    if (!commandSummaryPasses(command.summary)) return false;
  }
  return true;
}

function structuredEvidenceHasSupport(criterion: ReviewCriterion, block: Record<string, unknown>): boolean {
  if (hasSubstantiveEvidence(block.evidence)) return true;
  return criterion === "validation_backed" && Array.isArray(block.commands) && block.commands.length > 0 && validationCommandsPass(block.commands);
}

function readSeverityCounts(value: unknown, errors: string[]): Required<SeverityCounts> | undefined {
  if (!isRecord(value)) {
    errors.push("severity_counts must be an object with p0, p1, p2, and p3 numbers");
    return undefined;
  }

  const counts: Partial<Required<SeverityCounts>> = {};
  for (const severity of SEVERITY_LEVELS) {
    const count = value[severity];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      errors.push(`severity_counts.${severity} must be a non-negative integer`);
      return undefined;
    }
    counts[severity] = count;
  }

  return counts as Required<SeverityCounts>;
}

function structuredEvidenceToReviewEvidence(value: unknown): { evidence: ReviewEvidence; missing: ReviewCriterion[]; errors: string[] } {
  const errors: string[] = [];
  const evidence: ReviewEvidence = {};
  const missing: ReviewCriterion[] = [];

  if (!isRecord(value)) {
    return {
      evidence,
      missing: [...REVIEW_CRITERIA],
      errors: ["review_evidence must be an object"],
    };
  }

  for (const criterion of REVIEW_CRITERIA) {
    const block = value[criterion];
    if (!isRecord(block)) {
      missing.push(criterion);
      errors.push(`${criterion} must be an object with satisfied boolean and evidence`);
      continue;
    }

    if (typeof block.satisfied !== "boolean") {
      missing.push(criterion);
      errors.push(`${criterion}.satisfied must be boolean`);
      continue;
    }

    if (block.satisfied !== true) {
      evidence[criterion] = false;
      missing.push(criterion);
      continue;
    }

    if (!structuredEvidenceHasSupport(criterion, block)) {
      missing.push(criterion);
      errors.push(`${criterion} is satisfied but lacks explicit evidence${criterion === "validation_backed" ? " or passing command summaries" : ""}`);
      continue;
    }

    evidence[criterion] = true;
  }

  const severity_counts = readSeverityCounts(value.severity_counts, errors);
  if (severity_counts !== undefined) evidence.severity_counts = severity_counts;

  for (const flag of ["blocked", "conflicted", "validation_failed"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, flag)) continue;
    if (typeof value[flag] === "boolean") {
      evidence[flag] = value[flag];
    } else {
      errors.push(`${flag} must be boolean when present`);
    }
  }
  if (isRecord(value.validation_backed) && validationCommandsPass(value.validation_backed.commands) === false) {
    evidence.validation_backed = false;
    evidence.validation_failed = true;
    if (!missing.includes("validation_backed")) missing.push("validation_backed");
    errors.push("validation_backed.commands must all have zero exit codes or explicit passing summaries");
  }

  return { evidence, missing, errors: compactErrorList(errors) };
}

type JsonEvidenceExtraction = {
  evidence?: unknown;
  legacyEvidenceFound: boolean;
};

function valueLooksLikeReviewEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return REVIEW_CRITERIA.some((criterion) => isRecord(value[criterion]))
    || isRecord(value.severity_counts);
}

function findDeclaredArtifactEvidence(value: unknown, seen = new WeakSet<object>()): JsonEvidenceExtraction {
  if (!isRecord(value) && !Array.isArray(value)) return { legacyEvidenceFound: false };
  if (seen.has(value)) return { legacyEvidenceFound: false };
  seen.add(value);

  let legacyEvidenceFound = false;
  if (isRecord(value)) {
    if (Object.prototype.hasOwnProperty.call(value, LEGACY_COMPOUND_ENGINEERING_EVIDENCE_KEY)) legacyEvidenceFound = true;
    for (const key of DECLARED_REVIEW_EVIDENCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        return { evidence: value[key], legacyEvidenceFound };
      }
    }
    if (valueLooksLikeReviewEvidence(value)) return { evidence: value, legacyEvidenceFound };
  }

  if (Array.isArray(value)) {
    for (const childValue of value) {
      const found = findDeclaredArtifactEvidence(childValue, seen);
      legacyEvidenceFound = legacyEvidenceFound || found.legacyEvidenceFound;
      if (found.evidence !== undefined) return { evidence: found.evidence, legacyEvidenceFound };
    }
  } else {
    for (const [key, childValue] of Object.entries(value)) {
      if (key === LEGACY_COMPOUND_ENGINEERING_EVIDENCE_KEY) {
        legacyEvidenceFound = true;
        continue;
      }
      const found = findDeclaredArtifactEvidence(childValue, seen);
      legacyEvidenceFound = legacyEvidenceFound || found.legacyEvidenceFound;
      if (found.evidence !== undefined) return { evidence: found.evidence, legacyEvidenceFound };
    }
  }
  return { legacyEvidenceFound };
}

function parseJsonCandidate(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

type NativeReviewRoundGate = {
  childEvidence: ReviewEvidence;
  trace: Record<string, unknown>;
  missing: ReviewCriterion[];
  errors: string[];
};

function nativeReviewEvidence(severity_counts: Required<SeverityCounts>): ReviewEvidence {
  return {
    independent: true,
    acceptance_mapped: true,
    diff_aware: true,
    validation_backed: true,
    risk_aware: true,
    fresh: true,
    severity_counts,
  };
}

function isNativeReviewRoundCandidate(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, "reviews")
    && (Object.prototype.hasOwnProperty.call(value, "turn") || Object.prototype.hasOwnProperty.call(value, "iteration"));
}

function reviewerErrorIsPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  return !(typeof value === "string" && value.trim().length === 0);
}

function nativeFindingSeverity(value: unknown): SeverityLevel | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) return `p${value}` as SeverityLevel;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(?:p)?([0-3])$/i);
  return match ? `p${match[1]}` as SeverityLevel : undefined;
}

function readNativeDecisionFindings(value: unknown, errors: string[], reviewIndex: number): Required<SeverityCounts> {
  const counts = emptySeverityCounts();
  if (value === undefined) return counts;
  if (!Array.isArray(value)) {
    errors.push(`reviews[${reviewIndex}].decision.findings must be an array when present`);
    return counts;
  }

  for (let findingIndex = 0; findingIndex < value.length; findingIndex += 1) {
    const finding = value[findingIndex];
    if (!isRecord(finding)) {
      errors.push(`reviews[${reviewIndex}].decision.findings[${findingIndex}] must be an object`);
      continue;
    }
    const severityValue = finding.priority ?? finding.severity;
    const severity = nativeFindingSeverity(severityValue);
    if (severity === undefined) {
      errors.push(`reviews[${reviewIndex}].decision.findings[${findingIndex}] has unknown or malformed severity`);
      continue;
    }
    counts[severity] += 1;
  }
  return counts;
}

function mergeSeverityCounts(target: Required<SeverityCounts>, source: Required<SeverityCounts>): void {
  for (const severity of SEVERITY_LEVELS) target[severity] += source[severity];
}

function findNativeReviewRound(value: unknown, seen = new WeakSet<object>()): Record<string, unknown> | undefined {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (isNativeReviewRoundCandidate(value)) return value;
  if (Array.isArray(value)) {
    for (const childValue of value) {
      const found = findNativeReviewRound(childValue, seen);
      if (found !== undefined) return found;
    }
  } else {
    for (const [key, childValue] of Object.entries(value)) {
      if (key === LEGACY_COMPOUND_ENGINEERING_EVIDENCE_KEY) continue;
      const found = findNativeReviewRound(childValue, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function parseNativeReviewRound(value: Record<string, unknown>, runner: Exclude<ResolvedImplementationRunner, "handoff-only">): NativeReviewRoundGate {
  const errors: string[] = [];
  const severity_counts = emptySeverityCounts();
  const sourceKind = runner === "goal" ? "native_goal_review_round" : "native_ralph_review_round";

  if (Object.prototype.hasOwnProperty.call(value, "stop_review_loop") && value.stop_review_loop !== true) {
    errors.push("stop_review_loop must be true when present");
  }
  if (reviewerErrorIsPresent(value.reviewer_error)) {
    errors.push("native review round contains reviewer_error");
  }

  if (!Array.isArray(value.reviews) || value.reviews.length === 0) {
    errors.push("native review round must include a non-empty reviews array");
  } else {
    for (let reviewIndex = 0; reviewIndex < value.reviews.length; reviewIndex += 1) {
      const review = value.reviews[reviewIndex];
      if (!isRecord(review)) {
        errors.push(`reviews[${reviewIndex}] must be an object`);
        continue;
      }
      if (optionalNonEmptyString(review.reviewer) === undefined) {
        errors.push(`reviews[${reviewIndex}].reviewer must be a non-empty string`);
      }
      if (reviewerErrorIsPresent(review.reviewer_error)) {
        errors.push(`reviews[${reviewIndex}] contains reviewer_error`);
      }
      if (Object.prototype.hasOwnProperty.call(review, "stop_review_loop") && review.stop_review_loop !== true) {
        errors.push(`reviews[${reviewIndex}].stop_review_loop must be true when present`);
      }
      const decision = review.decision;
      if (!isRecord(decision)) {
        errors.push(`reviews[${reviewIndex}].decision must be an object`);
        continue;
      }
      if (reviewerErrorIsPresent(decision.reviewer_error)) {
        errors.push(`reviews[${reviewIndex}].decision contains reviewer_error`);
      }
      if (Object.prototype.hasOwnProperty.call(decision, "stop_review_loop") && decision.stop_review_loop !== true) {
        errors.push(`reviews[${reviewIndex}].decision.stop_review_loop must be true when present`);
      }
      if (typeof decision.overall_correctness !== "string" || decision.overall_correctness.trim().toLowerCase() !== "patch is correct") {
        errors.push(`reviews[${reviewIndex}].decision.overall_correctness must be \"patch is correct\"`);
      }
      mergeSeverityCounts(severity_counts, readNativeDecisionFindings(decision.findings, errors, reviewIndex));
    }
  }

  const childEvidence = nativeReviewEvidence(severity_counts);
  return {
    childEvidence,
    trace: {
      contract: "native_builtin_review_round",
      source_kind: sourceKind,
      loaded: errors.length === 0,
      turn: value.turn,
      iteration: value.iteration,
      review_count: Array.isArray(value.reviews) ? value.reviews.length : 0,
      missing: errors.length > 0 ? [...REVIEW_CRITERIA] : [],
      errors: compactErrorList(errors),
    },
    missing: errors.length > 0 ? [...REVIEW_CRITERIA] : [],
    errors: compactErrorList(errors),
  };
}

function extractNativeReviewRoundFromBody(body: string, runner: Exclude<ResolvedImplementationRunner, "handoff-only">): NativeReviewRoundGate | undefined {
  const parsedBody = parseJsonCandidate(body);
  const directNative = parsedBody !== undefined ? findNativeReviewRound(parsedBody) : undefined;
  if (directNative !== undefined) return parseNativeReviewRound(directNative, runner);

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of body.matchAll(fencePattern)) {
    const parsedFence = parseJsonCandidate(match[1].trim());
    const fencedNative = parsedFence !== undefined ? findNativeReviewRound(parsedFence) : undefined;
    if (fencedNative !== undefined) return parseNativeReviewRound(fencedNative, runner);
  }

  return undefined;
}

function extractJsonEvidenceFromBody(body: string): JsonEvidenceExtraction {
  const parsedBody = parseJsonCandidate(body);
  const direct = parsedBody !== undefined ? findDeclaredArtifactEvidence(parsedBody) : { legacyEvidenceFound: false };
  if (direct.evidence !== undefined) return direct;

  let legacyEvidenceFound = direct.legacyEvidenceFound;
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of body.matchAll(fencePattern)) {
    const parsedFence = parseJsonCandidate(match[1].trim());
    const fromFence = parsedFence !== undefined ? findDeclaredArtifactEvidence(parsedFence) : { legacyEvidenceFound: false };
    legacyEvidenceFound = legacyEvidenceFound || fromFence.legacyEvidenceFound;
    if (fromFence.evidence !== undefined) return { evidence: fromFence.evidence, legacyEvidenceFound };
  }

  return { legacyEvidenceFound };
}

function structuredEvidenceNeedsHumanReduction(gate: StructuredEvidenceGate, fallback: ReviewEvidenceReduction): ReviewEvidenceReduction {
  if (fallback.decision === "sufficient" && gate.errors.length > 0) {
    return {
      decision: "needs_human",
      missing: gate.missing,
      severity_counts: normalizeSeverityCounts(gate.childEvidence.severity_counts),
      reason: `Structured child evidence is incomplete or malformed: ${gate.errors.join("; ")}.`,
    };
  }
  return fallback;
}

async function loadStructuredChildEvidence(childOutput: Record<string, unknown>, runner: Exclude<ResolvedImplementationRunner, "handoff-only">): Promise<StructuredEvidenceGate> {
  const childReviewArtifact = await loadChildReviewArtifact(childOutput);
  if (childReviewArtifact.trace.fail_closed === true) {
    return {
      childEvidence: { blocked: true, severity_counts: emptySeverityCounts() },
      trace: {
        ...childReviewArtifact.trace,
        contract: "declared_child_review_artifact",
        loaded: false,
        errors: ["child review artifact was missing or unreadable"],
      },
      missing: [...REVIEW_CRITERIA],
      errors: ["child review artifact was missing or unreadable"],
      childReviewArtifact,
    };
  }

  const nativeReviewRound = extractNativeReviewRoundFromBody(childReviewArtifact.body, runner);
  if (nativeReviewRound !== undefined) {
    return {
      childEvidence: nativeReviewRound.childEvidence,
      trace: {
        ...childReviewArtifact.trace,
        ...nativeReviewRound.trace,
      },
      missing: nativeReviewRound.missing,
      errors: nativeReviewRound.errors,
      childReviewArtifact,
    };
  }

  const artifactEvidence = extractJsonEvidenceFromBody(childReviewArtifact.body);
  if (artifactEvidence.evidence === undefined) {
    const missingError = artifactEvidence.legacyEvidenceFound
      ? "legacy compound_engineering_evidence was ignored; child review artifact must use declared review_report/review_report_path content with review_evidence"
      : "missing review_evidence object in child review artifact";
    return {
      childEvidence: { severity_counts: emptySeverityCounts() },
      trace: {
        ...childReviewArtifact.trace,
        contract: "declared_child_review_artifact",
        loaded: false,
        legacy_compound_engineering_evidence_ignored: artifactEvidence.legacyEvidenceFound,
        errors: [missingError],
      },
      missing: [...REVIEW_CRITERIA],
      errors: [missingError],
      childReviewArtifact,
    };
  }

  const converted = structuredEvidenceToReviewEvidence(artifactEvidence.evidence);
  return {
    childEvidence: converted.evidence,
    trace: {
      ...childReviewArtifact.trace,
      contract: "declared_child_review_artifact",
      loaded: true,
      legacy_compound_engineering_evidence_ignored: artifactEvidence.legacyEvidenceFound,
      missing: converted.missing,
      errors: converted.errors,
    },
    missing: converted.missing,
    errors: converted.errors,
    childReviewArtifact,
  };
}

function runnerSafetyNote(requestedRunner: ImplementationRunner, runner: ResolvedImplementationRunner): string {
  if (requestedRunner === "auto") return "auto resolved to handoff-only for iteration 3";
  if (runner === "handoff-only") return "handoff-only is non-mutating";
  return "explicit runner may launch only after approval";
}

async function writeFinalManifest(options: {
  manifestPath: string;
  runId: string;
  startedAt: Date;
  input: Record<string, unknown>;
  finalReportPath: string;
  artifacts: ReadonlyMap<string, string>;
}): Promise<void> {
  await writeJson(options.manifestPath, {
    runId: options.runId,
    startedAt: options.startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    input: options.input,
    finalReportPath: displayPath(options.finalReportPath),
    artifacts: manifestArtifacts(options.artifacts, options.manifestPath),
  });
}

async function writeCompactFinalReport(options: {
  path: string;
  status: WorkflowStatus;
  mode: ResolvedCompoundMode;
  runner: ResolvedImplementationRunner;
  prompt: string;
  message: string;
  paths: ReadonlyMap<string, string>;
  implementation?: Record<string, unknown>;
}): Promise<string> {
  const implementationBlock = options.implementation
    ? `\n\n## Implementation handoff\n\n\`\`\`json\n${JSON.stringify(options.implementation, null, 2)}\n\`\`\``
    : "";
  const pathLines = [...options.paths]
    .map(([name, path]) => `- ${name}: ${displayPath(path)}`)
    .join("\n");

  return writeMarkdown(options.path, artifactMarkdown("Compound Engineering final report", [
    `Status: ${options.status}`,
    `Mode: ${options.mode}`,
    `Runner: ${options.runner}`,
    "",
    "## Request",
    options.prompt,
    "",
    "## Summary",
    options.message,
    "",
    "## Artifacts",
    pathLines || "- No additional artifacts.",
    implementationBlock,
  ].join("\n")));
}

const reviewEvidenceCriterionSchema = Type.Object({
  satisfied: Type.Boolean(),
  evidence: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  commands: Type.Optional(Type.Array(Type.Object({
    command: Type.Optional(Type.String()),
    exit_code: Type.Optional(Type.Integer()),
    summary: Type.Optional(Type.String()),
  }, { additionalProperties: false }))),
}, { additionalProperties: false });

const severityCountsSchema = Type.Object({
  p0: Type.Integer(),
  p1: Type.Integer(),
  p2: Type.Integer(),
  p3: Type.Integer(),
}, { additionalProperties: false });

const normalizedReviewEvidenceSchema = Type.Object({
  independent: reviewEvidenceCriterionSchema,
  acceptance_mapped: reviewEvidenceCriterionSchema,
  diff_aware: reviewEvidenceCriterionSchema,
  validation_backed: reviewEvidenceCriterionSchema,
  risk_aware: reviewEvidenceCriterionSchema,
  fresh: reviewEvidenceCriterionSchema,
  severity_counts: severityCountsSchema,
  blocked: Type.Optional(Type.Boolean()),
  conflicted: Type.Optional(Type.Boolean()),
  validation_failed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false, description: "Structured review evidence read from declared child review_report/review_report_path artifacts." });

const implementationLeafSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Object({}, { additionalProperties: true })])),
  Type.Object({}, { additionalProperties: true }),
]);

const implementationSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("guarded_handoff"),
    requested_runner: Type.String(),
    resolved_runner: resolvedRunnerSchema,
    workflow: resolvedRunnerSchema,
    inputs: Type.Object({}, { additionalProperties: implementationLeafSchema }),
    safe_note: Type.String(),
    child_workflow_launched: Type.Boolean(),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("child_workflow_receipt"),
    requested_runner: Type.String(),
    resolved_runner: resolvedRunnerSchema,
    workflow: resolvedRunnerSchema,
    inputs: Type.Object({}, { additionalProperties: implementationLeafSchema }),
    safe_note: Type.String(),
    child_workflow_launched: Type.Boolean(),
    child_exited: Type.Optional(Type.Boolean()),
    outputs: Type.Object({}, { additionalProperties: implementationLeafSchema }),
    evidence: Type.Optional(Type.Object({}, { additionalProperties: implementationLeafSchema })),
    gate_child_run_completion: Type.Object({}, { additionalProperties: implementationLeafSchema }),
    gate_review_evidence: Type.Optional(Type.Object({}, { additionalProperties: implementationLeafSchema })),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("worktree_root_resolution_failed"),
    requested_runner: Type.String(),
    resolved_runner: resolvedRunnerSchema,
    workflow: resolvedRunnerSchema,
    requested_git_worktree_dir: Type.String(),
    safe_note: Type.String(),
    child_workflow_launched: Type.Boolean(),
  }, { additionalProperties: false }),
], { description: "Typed implementation receipt union; dynamic child details are constrained to leaf objects." });

void normalizedReviewEvidenceSchema;

const compoundEngineeringWorkflow = defineWorkflow("compound-engineering")
  .description("Safe Compound Engineering loop: classify intake, scout memory, brainstorm/plan, require approval, run explicit implementation runners, gate review evidence, and optionally capture learning.")
  .input("prompt", Type.String({ description: "Idea, spec/plan path, work request, review target, or learning-capture request." }))
  .input("mode", Type.Union([
    Type.Literal("auto"),
    Type.Literal("brainstorm"),
    Type.Literal("plan"),
    Type.Literal("work"),
    Type.Literal("review"),
    Type.Literal("compound-only"),
  ], { default: "auto", description: "auto, brainstorm, plan, work, review, or compound-only." }))
  .input("runner", Type.Union([
    Type.Literal("auto"),
    Type.Literal("goal"),
    Type.Literal("ralph"),
    Type.Literal("handoff-only"),
  ], { default: "auto", description: "auto, goal, ralph, or handoff-only. Iteration 3 auto resolves to handoff-only; explicit goal/ralph run after approval." }))
  .input("max_loops", Type.Integer({ default: DEFAULT_MAX_LOOPS, description: "Maximum implementation/fix/review loops to include in handoff metadata." }))
  .input("base_branch", Type.String({ default: DEFAULT_BASE_BRANCH, description: "Base branch for implementation/review handoff." }))
  .input("git_worktree_dir", Type.String({ default: "", description: "Optional reusable worktree directory for implementation handoff." }))
  .input("create_pr", Type.Boolean({ default: false, description: "Strict true authorizes PR creation in handoff inputs; default false." }))
  .input("learning_mode", Type.Union([
    Type.Literal("ask"),
    Type.Literal("off"),
    Type.Literal("lightweight"),
    Type.Literal("full"),
  ], { default: "ask", description: "ask, off, lightweight, or full." }))
  .input("memory_scope", Type.Union([
    Type.Literal("repo"),
    Type.Literal("none"),
  ], { default: "repo", description: "repo or none." }))
  .worktreeFromInputs({
    gitWorktreeDir: "git_worktree_dir",
    baseBranch: "base_branch",
  })
  .output("status", statusSchema)
  .output("mode", resolvedModeSchema)
  .output("runner", resolvedRunnerSchema)
  .output("approved", Type.Boolean({ description: "Whether the workflow reached an approved or complete safe exit." }))
  .output("artifact_dir", Type.String({ description: "Hidden per-run artifact directory." }))
  .output("manifest_path", Type.String({ description: "Path to manifest JSON." }))
  .output("message", Type.String({ description: "Compact user-facing summary." }))
  .output("brainstorm_path", Type.Optional(Type.String({ description: "Saved brainstorm brief path." })))
  .output("plan_path", Type.Optional(Type.String({ description: "Saved plan path." })))
  .output("spec_path", Type.Optional(Type.String({ description: "Saved spec path." })))
  .output("approved_spec_path", Type.Optional(Type.String({ description: "Approved plan/spec path." })))
  .output("implementation", Type.Optional(implementationSchema))
  .output("review_report_path", Type.Optional(Type.String({ description: "Saved normalized review/evidence report path." })))
  .output("learning_doc_path", Type.Optional(Type.String({ description: "Saved docs/solutions learning artifact path." })))
  .run(async (ctx) => {
    const startedAt = new Date();
    const cwd = text((ctx as { cwd?: unknown }).cwd, process.cwd());
    const prompt = text(ctx.inputs.prompt);
    const requestedMode: CompoundMode = isCompoundMode(ctx.inputs.mode) ? ctx.inputs.mode : "auto";
    const requestedRunner: ImplementationRunner = isImplementationRunner(ctx.inputs.runner) ? ctx.inputs.runner : "auto";
    const learningMode: LearningMode = isLearningMode(ctx.inputs.learning_mode) ? ctx.inputs.learning_mode : "ask";
    const memoryScope: MemoryScope = isMemoryScope(ctx.inputs.memory_scope) ? ctx.inputs.memory_scope : "repo";
    const mode = resolveMode(prompt, requestedMode);
    const runner = resolveRunner(requestedRunner);
    const maxLoops = positiveInteger(ctx.inputs.max_loops, DEFAULT_MAX_LOOPS);
    const baseBranch = text(ctx.inputs.base_branch, DEFAULT_BASE_BRANCH);
    const gitWorktreeDir = text(ctx.inputs.git_worktree_dir);
    const createPr = normalizeCreatePr(ctx.inputs.create_pr);

    if (prompt.length === 0) {
      return exitWorkflow(ctx, outputRecord({
        status: "blocked",
        mode,
        runner,
        approved: false,
        artifact_dir: "",
        manifest_path: "",
        message: "Blocked: prompt is required.",
      }));
    }

    const { runId, artifactDir } = await createArtifactRun(WORKFLOW_NAME, startedAt, cwd);
    const artifacts = new Map<string, string>();
    const addArtifact = (name: string, path: string): string => {
      artifacts.set(name, path);
      return path;
    };
    const prepareArtifactPath = async (name: string, desiredPath: string): Promise<string> => addArtifact(name, await nextAvailablePath(desiredPath));
    const writeArtifactMarkdown = async (name: string, desiredPath: string, content: string): Promise<string> => addArtifact(name, await writeMarkdown(desiredPath, content));
    const manifestPath = join(artifactDir, "manifest.json");
    let finalReportPath = join(cwd, datedMarkdownPath(WORKFLOW_NAME, prompt, "final-report", startedAt));
    const writeFinalReport = async (options: Omit<Parameters<typeof writeCompactFinalReport>[0], "path" | "paths">): Promise<string> => {
      finalReportPath = await prepareArtifactPath("final-report", finalReportPath);
      finalReportPath = await writeCompactFinalReport({ ...options, path: finalReportPath, paths: artifacts });
      return addArtifact("final-report", finalReportPath);
    };

    const baseInput = {
      prompt,
      requested_mode: requestedMode,
      mode,
      requested_runner: requestedRunner,
      runner,
      max_loops: maxLoops,
      base_branch: baseBranch,
      git_worktree_dir: gitWorktreeDir,
      create_pr: createPr,
      learning_mode: learningMode,
      memory_scope: memoryScope,
    };

    const captureLearningArtifact = async (options: {
      reads: string[];
      summary: string;
      uiPrompt: string;
    }): Promise<{ selectedLearningMode: LearningMode; learningDocPath?: string }> => {
      let selectedLearningMode = learningMode;
      if (learningMode === "ask") {
        selectedLearningMode = await ctx.ui.select(
          options.uiPrompt,
          ["lightweight", "full", "off"] as const,
        ) as LearningMode;
      }

      if (selectedLearningMode === "off") return { selectedLearningMode };

      const learningDocPath = await prepareArtifactPath("learning-doc", join(cwd, datedMarkdownPath("docs/solutions", prompt, "learning", startedAt)));
      await ctx.task("capture-learning", {
        reads: options.reads,
        prompt: `Capture a ${selectedLearningMode} solved-problem learning note.\n\nRequest:\n${prompt}\n\n${options.summary}\n\nUse available artifacts as background. Include problem, context, solution/lesson, validation/evidence if known, and when to reuse the lesson. Do not include secrets, raw environment dumps, credentials, or unnecessary transcripts. Do not edit CONCEPTS.md or other discoverability anchors in iteration 3; produce only this docs/solutions Markdown artifact.\n\n${EVERY_INC_CREDIT}`,
        ...fileOnlyOutput(learningDocPath),
      });

      return { selectedLearningMode, learningDocPath };
    };

    await writeArtifactMarkdown("intake", join(artifactDir, "00-intake.md"), artifactMarkdown("Compound Engineering intake", [
      `Resolved mode: ${mode}`,
      `Resolved runner: ${runner}`,
      `Safe runner note: ${runnerSafetyNote(requestedRunner, runner)}`,
      `Create PR: ${createPr}`,
      "",
      "## Prompt",
      prompt,
    ].join("\n")));

    let contextPath = await prepareArtifactPath("memory-context", join(artifactDir, "01-memory-context.md"));
    if (memoryScope === "repo") {
      await ctx.task("scout-memory-and-context", {
        prompt: `Scout only lightweight repo memory for a Compound Engineering run.\n\nPrompt:\n${prompt}\n\nMode: ${mode}\n\nLook for high-signal anchors if present: STRATEGY.md, CONCEPTS.md, docs/brainstorms/, docs/plans/, docs/solutions/, research/docs/, specs/, README files, and similar workflow artifacts. Do not modify files. Summarize useful context, unresolved ambiguities, and any referenced file/path that appears missing.\n\n${EVERY_INC_CREDIT}`,
        ...fileOnlyOutput(contextPath),
      });
    } else {
      contextPath = await writeArtifactMarkdown("memory-context", contextPath, artifactMarkdown("Memory context", "memory_scope=none; repo memory scout skipped."));
    }

    if (mode === "review") {
      const reviewPath = await nextAvailablePath(join(cwd, datedMarkdownPath(WORKFLOW_NAME, `${prompt} review`, "review", startedAt)));
      const review = await ctx.task("review-only-evidence-report", {
        reads: [contextPath],
        prompt: `Run a read-only Compound Engineering review for this target.\n\nTarget/request:\n${prompt}\n\nRead memory context at ${displayPath(contextPath)}. Infer whether the target is a branch range, PR, path, or current repo. Use safe local read-only evidence only. Do not modify files, install dependencies, create commits, post comments, or create a PR.\n\nWrite a compact report with: scope, evidence inspected, findings by P0/P1/P2/P3, validation commands available/run/skipped, review sufficiency dimensions (independent, acceptance-mapped, diff-aware, validation-backed, risk-aware, fresh), and residual risks.`,
        ...fileOnlyOutput(reviewPath),
      });
      let reviewBody = "blocked unable to review missing dependency";
      let reviewReportPath: string | undefined;
      let reportLoadError: string | undefined;
      try {
        const loadedReview = await loadSavedStageReport(reviewPath, review);
        reviewBody = loadedReview.body;
        if (loadedReview.source === "saved-file") reviewReportPath = addArtifact("review-report", reviewPath);
      } catch (error) {
        reportLoadError = error instanceof Error ? error.message : String(error);
        reviewBody = `blocked unable to review missing dependency: ${reportLoadError}`;
      }
      const reduction = reduceReviewEvidence(parseEvidenceFromText(reviewBody));
      const approved = reduction.decision === "sufficient";
      let status: WorkflowStatus = "needs_human";
      if (approved) {
        status = "review_only";
      } else if (reduction.decision === "blocked") {
        status = "blocked";
      }

      const loadErrorMessage = reportLoadError ? ` (${reportLoadError})` : "";
      const message = approved
        ? `Review-only report produced; evidence gate decision: ${reduction.decision}.`
        : `Review-only evidence gate returned ${reduction.decision}: ${reduction.reason}${loadErrorMessage}`;
      await writeFinalReport({ status, mode, runner, prompt, message });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: baseInput, finalReportPath, artifacts });
      return outputRecord({
        status,
        mode,
        runner,
        approved,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        message,
        review_report_path: reviewReportPath ? displayPath(reviewReportPath) : undefined,
      });
    }

    if (mode === "compound-only") {
      const { selectedLearningMode, learningDocPath } = await captureLearningArtifact({
        reads: [contextPath],
        uiPrompt: "Capture a Compound Engineering learning artifact for this request?",
        summary: `Repo memory context: ${displayPath(contextPath)}. This is a learning-only Compound Engineering run.`,
      });
      const message = learningDocPath
        ? `Learning artifact written to ${displayPath(learningDocPath)}.`
        : "Learning capture skipped by mode selection.";
      const status: WorkflowStatus = learningDocPath ? "complete" : "needs_human";
      await writeFinalReport({ status, mode, runner, prompt, message });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, selected_learning_mode: selectedLearningMode }, finalReportPath, artifacts });
      return outputRecord({
        status,
        mode,
        runner,
        approved: learningDocPath !== undefined,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        message,
        learning_doc_path: learningDocPath ? displayPath(learningDocPath) : undefined,
      });
    }

    let brainstormPath: string | undefined;
    if (mode === "brainstorm") {
      brainstormPath = await prepareArtifactPath("brainstorm", join(cwd, datedMarkdownPath("docs/brainstorms", prompt, "brainstorm", startedAt)));
      await ctx.task("brainstorm-requirements", {
        reads: [contextPath],
        prompt: `Create a concise Compound Engineering brainstorm brief for this request.\n\nPrompt:\n${prompt}\n\nRead memory context at ${displayPath(contextPath)}. Ask no questions in this stage; record unresolved questions explicitly instead. Include user/problem, desired outcome, options, recommendation, assumptions, non-goals, and what would make the work concrete enough to plan.\n\n${EVERY_INC_CREDIT}`,
        ...fileOnlyOutput(brainstormPath),
      });
    }

    let planPath = join(cwd, datedMarkdownPath("docs/plans", prompt, "plan", startedAt));
    let specPath = await prepareArtifactPath("spec", join(cwd, datedMarkdownPath("specs", prompt, "spec", startedAt)));
    const plan = await ctx.task("draft-plan-or-spec", {
      reads: [contextPath, ...(brainstormPath ? [brainstormPath] : [])],
      prompt: `Draft a plan/spec for the Compound Engineering approval gate.\n\nMode: ${mode}\nOriginal request:\n${prompt}\n\nRead available artifacts:\n- Memory context: ${displayPath(contextPath)}${brainstormPath ? `\n- Brainstorm brief: ${displayPath(brainstormPath)}` : ""}\n\nWrite a compact Markdown plan/spec suitable for human approval. Include status Draft, scope, acceptance criteria, implementation approach, validation plan, review/evidence requirements, risks, non-goals, and explicit note that implementation must not start until approval. If the prompt references an existing spec/plan path, treat it as source material and still produce this approval artifact.\n\n${EVERY_INC_CREDIT}`,
      ...fileOnlyOutput(specPath),
    });
    planPath = await writeArtifactMarkdown("plan", planPath, artifactMarkdown("Compound Engineering plan", `This companion plan points to the generated approval spec.\n\nSpec path: ${displayPath(specPath)}\n\nDraft summary:\n${plan.text}`));

    let approvalDecision = parseApprovalDecision(await ctx.ui.select(
      `Approve this Compound Engineering plan/spec before any implementation handoff?\n\nSpec: ${displayPath(specPath)}\nPlan: ${displayPath(planPath)}\n\nChoose Approve only if the scope and validation plan are acceptable.`,
      ["Approve", "Revise", "Reject", "Stop"] as const,
    ));
    let revisions = 0;

    while (approvalDecision === "revise" && revisions < maxLoops) {
      revisions += 1;
      const revisionRequest = await ctx.ui.input(`What should change before approval? Revision ${revisions}/${maxLoops}.`);
      const previousSpecPath = specPath;
      specPath = await prepareArtifactPath("spec", specPath);
      await ctx.task(`revise-plan-or-spec-${revisions}`, {
        reads: [previousSpecPath, planPath, contextPath],
        prompt: `Revise the Compound Engineering approval spec in place conceptually and write the new full Markdown artifact.\n\nExisting spec: ${displayPath(previousSpecPath)}\nExisting plan: ${displayPath(planPath)}\nRevision request:\n${text(revisionRequest, "No specific revision text provided.")}\n\nPreserve the no-implementation-before-approval guardrail.`,
        ...fileOnlyOutput(specPath),
      });
      approvalDecision = parseApprovalDecision(await ctx.ui.select(
        `Review the revised Compound Engineering spec.\n\nSpec: ${displayPath(specPath)}\n\nApprove before implementation handoff?`,
        ["Approve", "Revise", "Reject", "Stop"] as const,
      ));
    }

    if (approvalDecision === "revise") approvalDecision = "stopped";

    if (approvalDecision !== "approved") {
      const status: WorkflowStatus = approvalDecision === "rejected" ? "rejected" : "stopped";
      const message = status === "rejected"
        ? "Plan/spec rejected; no implementation handoff emitted."
        : "Approval loop stopped or exhausted; no implementation handoff emitted.";
      await writeFinalReport({ status, mode, runner, prompt, message });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, approval_decision: approvalDecision, revisions }, finalReportPath, artifacts });
      return outputRecord({
        status,
        mode,
        runner,
        approved: false,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        message,
        brainstorm_path: brainstormPath ? displayPath(brainstormPath) : undefined,
        plan_path: displayPath(planPath),
        spec_path: displayPath(specPath),
      });
    }

    const approvedSpecPath = specPath;
    let effectiveGitWorktreeDir = gitWorktreeDir;
    if (runner === "ralph") {
      try {
        effectiveGitWorktreeDir = await resolveEffectiveWorktreeRoot(gitWorktreeDir, cwd);
      } catch (error) {
        const message = `Plan/spec approved, but Ralph worktree root resolution failed: ${error instanceof Error ? error.message : String(error)}`;
        const implementation = outputRecord({
          kind: "worktree_root_resolution_failed",
          requested_runner: requestedRunner,
          resolved_runner: runner,
          workflow: runner,
          requested_git_worktree_dir: gitWorktreeDir,
          safe_note: "Ralph was not launched because a non-empty git_worktree_dir must resolve to a Git worktree root from ctx.cwd.",
          child_workflow_launched: false,
        });
        await writeFinalReport({ status: "blocked", mode, runner, prompt, message, implementation });
        await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, approval_decision: approvalDecision, revisions }, finalReportPath, artifacts });
        return outputRecord({
          status: "blocked",
          mode,
          runner,
          approved: false,
          artifact_dir: displayPath(artifactDir),
          manifest_path: displayPath(manifestPath),
          message,
          brainstorm_path: brainstormPath ? displayPath(brainstormPath) : undefined,
          plan_path: displayPath(planPath),
          spec_path: displayPath(specPath),
          approved_spec_path: displayPath(approvedSpecPath),
          implementation,
        });
      }
    }
    const handoff = buildChildHandoff({
      runner,
      approvedPath: displayPath(approvedSpecPath),
      prompt,
      maxLoops,
      baseBranch,
      gitWorktreeDir: effectiveGitWorktreeDir,
      createPr,
    });

    if (runner === "handoff-only") {
      const implementation = outputRecord({
        kind: "guarded_handoff",
        requested_runner: requestedRunner,
        resolved_runner: runner,
        workflow: handoff.workflow,
        inputs: handoff.inputs,
        safe_note: handoff.safe_note,
        child_workflow_launched: false,
      });
      const status: WorkflowStatus = mode === "work" || requestedRunner !== "handoff-only" ? "handoff_ready" : "approved";
      const message = "Plan/spec approved. Iteration 3 stopped safely with handoff-only metadata and did not implement code.";

      await writeFinalReport({ status, mode, runner, prompt, message, implementation });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, approval_decision: approvalDecision, revisions }, finalReportPath, artifacts });

      return outputRecord({
        status,
        mode,
        runner,
        approved: true,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        message,
        brainstorm_path: brainstormPath ? displayPath(brainstormPath) : undefined,
        plan_path: displayPath(planPath),
        spec_path: displayPath(specPath),
        approved_spec_path: displayPath(approvedSpecPath),
        implementation,
      });
    }

    const childInputs = handoff.inputs;
    const childResult = await ctx.workflow(runner === "goal" ? goal : ralph, {
      stageName: `${runner} implementation`,
      inputs: childInputs,
    });
    if (childWorkflowExited(childResult)) {
      const childOutput = normalizedChildOutput(childResult, runner);
      const receiptChildOutput = compactChildOutputForReceipt(childOutput);
      const exitStatus = childExitStatus(childResult);
      const domainStatus = domainStatusForChildExit(exitStatus);
      const exitReason = childExitReason(childResult, `${runner} child workflow exited before returning declared completion evidence.`);
      const childExitGate = {
        state: "child_exited",
        parent_status: domainStatus,
        reason: exitReason,
        exited: true,
        exit_status: exitStatus,
        exit_reason: exitReason,
      };
      const implementation = outputRecord({
        kind: "child_workflow_receipt",
        requested_runner: requestedRunner,
        resolved_runner: runner,
        workflow: runner,
        inputs: childInputs,
        safe_note: handoff.safe_note,
        child_workflow_launched: true,
        child_exited: true,
        outputs: receiptChildOutput,
        gate_child_run_completion: childExitGate,
      });
      const message = `Plan/spec approved and ${runner} child workflow exited (${exitStatus}) before returning declared completion evidence.`;
      const output = outputRecord({
        status: domainStatus,
        mode,
        runner,
        approved: false,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        message,
        brainstorm_path: brainstormPath ? displayPath(brainstormPath) : undefined,
        plan_path: displayPath(planPath),
        spec_path: displayPath(specPath),
        approved_spec_path: displayPath(approvedSpecPath),
        implementation,
      });
      await writeFinalReport({ status: domainStatus, mode, runner, prompt, message, implementation });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, approval_decision: approvalDecision, revisions }, finalReportPath, artifacts });
      return exitWorkflow(ctx, output, exitStatus, exitReason);
    }

    const childOutput = normalizedChildOutput(childResult, runner);
    const receiptChildOutput = compactChildOutputForReceipt(childOutput);
    const childGate = gateChildRunCompletion(childOutput, runner);
    let reviewReportPath: string | undefined;

    if (childGate.state !== "approved") {
      const status = childGate.parent_status;
      const implementation = outputRecord({
        kind: "child_workflow_receipt",
        requested_runner: requestedRunner,
        resolved_runner: runner,
        workflow: runner,
        inputs: childInputs,
        safe_note: handoff.safe_note,
        child_workflow_launched: true,
        outputs: receiptChildOutput,
        gate_child_run_completion: childGate,
      });
      const message = status === "blocked"
        ? `Plan/spec approved and ${runner} child workflow ran, but child completion gate returned blocked: ${childGate.reason}`
        : `Plan/spec approved and ${runner} child workflow ran, but child completion gate requires human review: ${childGate.reason}`;

      await writeFinalReport({ status, mode, runner, prompt, message, implementation });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, approval_decision: approvalDecision, revisions }, finalReportPath, artifacts });

      return outputRecord({
        status,
        mode,
        runner,
        approved: false,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        message,
        brainstorm_path: brainstormPath ? displayPath(brainstormPath) : undefined,
        plan_path: displayPath(planPath),
        spec_path: displayPath(specPath),
        approved_spec_path: displayPath(approvedSpecPath),
        implementation,
      });
    }

    const structuredGate = await loadStructuredChildEvidence(childOutput, runner);
    const childReviewArtifact = structuredGate.childReviewArtifact;
    if (childReviewArtifact?.reportPath !== undefined) reviewReportPath = addArtifact("child-review-report", childReviewArtifact.reportPath);
    const childEvidence = structuredGate.childEvidence;
    const initialReduction = reduceReviewEvidence(childEvidence);
    const reduction = structuredEvidenceNeedsHumanReduction(structuredGate, initialReduction);

    let status: WorkflowStatus = "needs_human";
    if (reduction.decision === "sufficient") {
      status = "complete";
    } else if (reduction.decision === "blocked") {
      status = "blocked";
    }
    const implementation = outputRecord({
      kind: "child_workflow_receipt",
      requested_runner: requestedRunner,
      resolved_runner: runner,
      workflow: runner,
      inputs: childInputs,
      safe_note: handoff.safe_note,
      child_workflow_launched: true,
      outputs: receiptChildOutput,
      evidence: {
        child: childEvidence,
        structured_child: structuredGate.trace,
        child_review_artifact: childReviewArtifact?.trace,
      },
      gate_child_run_completion: childGate,
      gate_review_evidence: reduction,
    });
    let selectedLearningMode: LearningMode | undefined;
    let learningDocPath: string | undefined;
    if (status === "complete") {
      const learning = await captureLearningArtifact({
        reads: [contextPath, approvedSpecPath, ...(reviewReportPath ? [reviewReportPath] : [])],
        uiPrompt: "Review evidence is sufficient. Capture a Compound Engineering learning artifact for this validated implementation?",
        summary: `Validated implementation summary:\n- Runner: ${runner}\n- Approved spec: ${displayPath(approvedSpecPath)}\n- Review decision: ${reduction.decision}\n- Review reason: ${reduction.reason}\n- Child review report: ${reviewReportPath ? displayPath(reviewReportPath) : "structured child output"}`,
      });
      selectedLearningMode = learning.selectedLearningMode;
      learningDocPath = learning.learningDocPath;
    }

    let learningMessage = "";
    if (status === "complete") {
      learningMessage = learningDocPath
        ? ` Learning artifact written to ${displayPath(learningDocPath)}.`
        : ` Learning capture skipped (${selectedLearningMode ?? "not requested"}).`;
    }
    const structuredGapMessage = structuredGate.errors.length > 0 || structuredGate.missing.length > 0
      ? ` Missing structured evidence criteria: ${structuredGate.missing.length > 0 ? structuredGate.missing.join(", ") : "none"}. ${structuredGate.errors.length > 0 ? `Structured evidence errors: ${structuredGate.errors.join("; ")}.` : ""}`
      : "";
    const message = status === "complete"
      ? `Plan/spec approved, ${runner} child workflow ran, and structured review evidence gate is sufficient.${learningMessage}`
      : `Plan/spec approved and ${runner} child workflow ran, but structured review evidence gate returned ${reduction.decision}: ${reduction.reason}${structuredGapMessage}`;

    await writeFinalReport({ status, mode, runner, prompt, message, implementation });
    await writeFinalManifest({ manifestPath, runId, startedAt, input: { ...baseInput, approval_decision: approvalDecision, revisions, selected_learning_mode: selectedLearningMode }, finalReportPath, artifacts });

    return outputRecord({
      status,
      mode,
      runner,
      approved: status === "complete",
      artifact_dir: displayPath(artifactDir),
      manifest_path: displayPath(manifestPath),
      message,
      brainstorm_path: brainstormPath ? displayPath(brainstormPath) : undefined,
      plan_path: displayPath(planPath),
      spec_path: displayPath(specPath),
      approved_spec_path: displayPath(approvedSpecPath),
      implementation,
      review_report_path: reviewReportPath ? displayPath(reviewReportPath) : undefined,
      learning_doc_path: learningDocPath ? displayPath(learningDocPath) : undefined,
    });
  })
  .compile();

export default compoundEngineeringWorkflow;
