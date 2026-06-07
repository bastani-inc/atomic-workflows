import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, Type } from "@bastani/workflows";
import { goal, ralph } from "@bastani/workflows/builtin";
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

const CHILD_OUTPUT_KEYS = [
  "result",
  "status",
  "message",
  "summary",
  "approved",
  "artifact_dir",
  "manifest_path",
  "plan_path",
  "implementation_notes_path",
  "ledger_path",
  "pr_report",
  "iterations_completed",
  "review_report",
  "review_report_path",
  "validation_output",
  "changed_files",
  "compound_engineering_evidence",
] as const;
const CHILD_OUTPUT_KEY_SET = new Set<string>(CHILD_OUTPUT_KEYS);

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

type SufficiencyCriterion = ReviewCriterion;
type SeverityLevel = keyof Required<SeverityCounts>;

const SEVERITY_LEVELS: readonly SeverityLevel[] = ["p0", "p1", "p2", "p3"];

type CriterionPolicy = {
  positive: readonly RegExp[];
  negative: readonly RegExp[];
};

const VALIDATION_NO_RUN_PATTERN = /\b(?:validation\s+commands?|tests?|test\s+commands?|commands?)\s+(?:run|ran)\s*:?\s*(?:none|no\s+commands?|zero|0|n\/a)\b|\bno\s+validation\s+(?:(?:was|were)\s+)?(?:run|ran|performed)\b|\bno\s+validation\s+commands?\s+(?:(?:was|were)\s+)?run\b|\bno\s+tests?\s+(?:(?:was|were)\s+)?run\b|\bno\s+commands?\s+(?:(?:was|were)\s+)?run\b|\bvalidation\s+(?:commands?\s+)?skipped\b|\bvalidation\b.{0,50}\bskipped\b|\bvalidation\s+not\s+(?:run|performed|backed|available)\b|\bvalidation\b.{0,50}\b(?:was|were)\s+not\s+(?:run|performed|available)\b|\btests?\b.{0,40}\bskipped\b|\btests?\s+(?:were\s+)?not\s+run\b/;
const CONTEXTUAL_VALIDATION_ERROR_PATTERN = /\b(?:reported\s+)?[1-9]\d*\s+errors\b|\berror\s+count\s*:?\s*[1-9]\d*\b|\berrors\s*:?\s*[1-9]\d*\b|\bfailed\s+with\s+errors\b/;
const VALIDATION_NEGATED_SUCCESS_PATTERN = /\b(?:not|never)\s+(?:(?:all|any|every)\s+(?:[\w-]+\s+){0,6})?(?:pass(?:ed|es|ing)?|successful|success|succeed(?:ed|s|ing)?)\b|\bunsuccessful\b/;
const VALIDATION_SUCCESS_PATTERN = /\b(?:passed|passes|passing|succeeded|successful|success|status\s*:?\s*0|code\s*:?\s*0|exit\s+(?:code|status)\s*:?\s*0|exited\s+with\s+(?:exit\s+)?(?:code|status)\s*:?\s*0|returned\s+(?:exit\s+)?(?:code|status)\s*:?\s*0)\b/;

const REVIEW_EVIDENCE_POLICIES = {
  independent: {
    positive: [/\bindependent(?:ly)?\b/, /\bseparate reviewer\b/, /\bfresh[-\s]context reviewer\b/],
    negative: [
      /\bnot\s+independent\b/,
      /\bno\s+(?:independent|separate|fresh[-\s]context)\s+review(?:er)?\b/,
      /\bwithout\s+(?:an?\s+)?(?:independent|separate|fresh[-\s]context)\s+review(?:er)?\b/,
      /\bself[-\s]review\b/,
    ],
  },
  acceptance_mapped: {
    positive: [
      /\b(?:map(?:ped)?|mapping|check(?:ed)?|verify|verified|trace(?:d)?|cover(?:ed)?|coverage)\b.{0,80}\b(?:acceptance(?:\s+criteria)?|approved\s+(?:plan|spec))\b/,
      /\b(?:acceptance(?:\s+criteria)?|approved\s+(?:plan|spec))\b.{0,80}\b(?:map(?:ped)?|mapping|check(?:ed)?|verify|verified|trace(?:d)?|cover(?:ed)?|coverage)\b/,
    ],
    negative: [
      /\bno\s+acceptance(?:\s+criteria)?\s+(?:mapping|mapped|traceability|coverage)\b/,
      /\bno\s+acceptance(?:\s+criteria)?\s+(?:(?:was|were)\s+)?(?:mapped|checked|verified|traced|covered|inspected)\b/,
      /\bnot\s+acceptance[-\s]mapped\b/,
      /\bacceptance\s+(?:mapping\s+)?(?:not\s+)?(?:missing|skipped|absent)\b/,
      /\b(?:acceptance(?:\s+criteria|\s+mapping)?|approved\s+(?:plan|spec)|spec)\b.{0,80}\b(?:not\s+(?:mapped|provided|performed|done|checked|verified|traced|covered|inspected)|(?:was|were)\s+not\s+(?:mapped|provided|performed|done|checked|verified|traced|covered|inspected)|unmapped|unchecked|unverified|untraced|uncovered|skipped|missing|absent|unavailable)\b/,
      /\b(?:did not|does not|not)\s+(?:map|mapped|check|checked|verify|verified|trace|traced|cover|covered|inspect|inspected)\b.{0,80}\b(?:acceptance|approved\s+(?:plan|spec)|spec)\b/,
      /\b(?:unchecked|unmapped|unverified|untraced|uncovered)\s+(?:acceptance(?:\s+criteria)?|approved\s+)?(?:spec|plan|criteria)\b/,
    ],
  },
  diff_aware: {
    positive: [/\bdiff\b/, /\bchanged files?\b/, /\bgit status\b/, /\bgit diff\b/],
    negative: [
      /\bdiff\s+(?:was\s+|were\s+)?not\s+(?:inspected|reviewed|checked)\b/,
      /\bnot\s+(?:inspect(?:ed)?|review(?:ed)?|check(?:ed)?)\b.{0,40}\bdiff\b/,
      /\b(?:did not|does not)\s+(?:inspect|review|check)\b.{0,40}\bdiff\b/,
      /\bdiff(?:\s+review)?\b.{0,40}\b(?:skipped|missing|absent|not\s+(?:inspected|reviewed|checked|performed)|(?:was|were)\s+not\s+(?:inspected|reviewed|checked|performed))\b/,
      /\b(?:unable|could not|cannot)\s+(?:to\s+)?(?:inspect|review|check)\b.{0,60}\b(?:current\s+)?(?:git\s+)?diff\b/,
      /\bcould not\s+inspect\s+changed files?\b/,
      /\bdiff\s+(?:was\s+)?unavailable\b/,
      /\bdiff\s+(?:could\s+not|cannot)\s+be\s+(?:inspected|reviewed|checked)\b/,
      /\bdiff\s+was\s+not\s+available\b/,
      /\bno\s+(?:git\s+)?diff\s+(?:was\s+)?available\b/,
      /\bchanged files?\s+(?:was\s+|were\s+)?(?:unavailable|not\s+(?:inspected|reviewed|checked|available))\b/,
      /\bno\s+(?:git\s+)?diff\b.{0,80}\b(?:inspected|reviewed|checked)\b/,
      /\bno\s+changed files?\b.{0,80}\b(?:inspected|reviewed|checked)\b/,
    ],
  },
  validation_backed: {
    positive: [
      /\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|test\s+command)\b.{0,80}\b(?:passed|passes|passing|succeeded|successful|success|status\s*:?\s*0|code\s*:?\s*0|exit\s+(?:code|status)\s*:?\s*0|exited\s+with\s+(?:exit\s+)?(?:code|status)\s*:?\s*0|returned\s+(?:exit\s+)?(?:code|status)\s*:?\s*0)\b/,
      /\b(?:passed|passes|passing|succeeded|successful|success|status\s*:?\s*0|code\s*:?\s*0|exit\s+(?:code|status)\s*:?\s*0|exited\s+with\s+(?:exit\s+)?(?:code|status)\s*:?\s*0|returned\s+(?:exit\s+)?(?:code|status)\s*:?\s*0)\b.{0,80}\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|test\s+command)\b/,
    ],
    negative: [
      VALIDATION_NO_RUN_PATTERN,
      /\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test)\b.{0,80}\b(?:failed|failures?|failing|errored|did\s+not\s+pass|does\s+not\s+pass|not\s+passing|non[-\s]?zero|(?:exit\s+)?(?:code|status)\s*:?\s*[1-9]\d*)\b/,
      /\b(?:failed|failures?|failing|errored|did\s+not\s+pass|does\s+not\s+pass|not\s+passing|non[-\s]?zero|(?:exit\s+)?(?:code|status)\s*:?\s*[1-9]\d*)\b.{0,80}\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test)\b/,
      /\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test)\b.{0,80}\b(?:reported\s+)?[1-9]\d*\s+errors\b/,
      /\b(?:reported\s+)?[1-9]\d*\s+errors\b.{0,80}\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test)\b/,
      /\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test)\b.{0,80}\b(?:error\s+count\s*:?\s*[1-9]\d*|errors\s*:?\s*[1-9]\d*|failed\s+with\s+errors)\b/,
      /\b(?:error\s+count\s*:?\s*[1-9]\d*|errors\s*:?\s*[1-9]\d*|failed\s+with\s+errors)\b.{0,80}\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test)\b/,
    ],
  },
  risk_aware: {
    positive: [/\brisk\b/, /\bresidual\b/, /\bsecurity\b/],
    negative: [
      /\bno\s+residual\s+risk\s+(?:assessment|review|analysis)\b/,
      /\bno\s+risk\s+(?:assessment|review|analysis)\b/,
      /\brisk\s+(?:assessment|review|analysis)\s+(?:not\s+)?(?:missing|skipped|absent)\b/,
      /\brisk\b.{0,50}\bunknown\b/,
      /\brisk\b.{0,50}\b(?:not\s+(?:assessed|reviewed|evaluated)|(?:was|were)\s+not\s+(?:assessed|reviewed|evaluated|performed))\b/,
      /\bnot\s+(?:risk|residual\s+risk)[-\s]aware\b/,
    ],
  },
  fresh: {
    positive: [
      /\b(?:review(?:ed)?|fresh|evidence)\b.{0,60}\bafter\s+(?:the\s+)?(?:final\s+diff|latest\s+change|current\s+diff)\b/,
      /\bafter\s+(?:the\s+)?(?:final\s+diff|latest\s+change|current\s+diff)\b.{0,60}\b(?:review(?:ed)?|fresh|evidence)\b/,
    ],
    negative: [
      /\bnot\s+fresh\b/,
      /\bstale\b/,
      /\b(?:review(?:ed)?|evidence)\b.{0,60}\b(?:predates|before)\b.{0,40}\b(?:final\s+diff|latest\s+change|current\s+diff)\b/,
      /\b(?:predates|before)\s+(?:the\s+)?(?:final\s+diff|latest\s+change|current\s+diff)\b/,
      /\bnot\s+(?:after\s+)?(?:the\s+)?latest\s+change\b/,
      /\bcurrent diff\b.{0,60}\bnot\s+(?:inspected|reviewed|checked)\b/,
    ],
  },
} as const satisfies Record<SufficiencyCriterion, CriterionPolicy>;

function reviewSegments(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\r\n.;]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function criterionEvidenceState(segments: readonly string[], policy: CriterionPolicy): boolean | undefined {
  if (segments.some((segment) => matchesAnyPattern(segment, policy.negative))) return false;
  if (segments.some((segment) => matchesAnyPattern(segment, policy.positive))) return true;
  return undefined;
}

const VALIDATION_SUBJECT_PATTERN = /\b(?:validation|tests?|commands?|bun\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|test\s+command)\b/;
const VALIDATION_RUN_CONTEXT_PATTERN = /\b(?:run|ran|completed|bun\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|test\s+command)\b/;
const NO_VALIDATION_FAILURE_PATTERN = /\b(?:no|zero|0)\s+(?:validation\s+)?(?:commands?\s+)?(?:failed|failures?|errors?)\b|\b(?:validation\s+)?(?:failures?|errors?)\s*:\s*(?:none|no|zero|0)\b|\b(?:no|zero|0)\s+tests?\s+(?:failed|failing)\b|\bwithout\s+(?:validation\s+|test\s+)?(?:failures?|errors?)\b/g;
const VALIDATION_FAILURE_PATTERN = /\b(?:failed|failures?|failing|errored|did\s+not\s+pass|does\s+not\s+pass|not\s+passing|non[-\s]?zero|(?:exit\s+)?(?:code|status)\s*:?\s*[1-9]\d*|exited\s+with\s+(?:exit\s+)?(?:code|status)\s*:?\s*[1-9]\d*|returned\s+(?:exit\s+)?(?:code|status)\s*:?\s*[1-9]\d*)\b|\b(?:reported\s+)?[1-9]\d*\s+errors\b|\berror\s+count\s*:?\s*[1-9]\d*\b|\berrors\s*:?\s*[1-9]\d*\b|\bfailed\s+with\s+errors\b/;

function removeNoValidationFailureAssertions(segment: string): string {
  return segment.replace(NO_VALIDATION_FAILURE_PATTERN, " ").trim();
}

function hasValidationRunContext(segment: string): boolean {
  return VALIDATION_SUBJECT_PATTERN.test(segment) && VALIDATION_RUN_CONTEXT_PATTERN.test(segment) && !VALIDATION_NO_RUN_PATTERN.test(segment);
}

function validationConditionHasContext(segment: string, previousSegment: string): boolean {
  return VALIDATION_SUBJECT_PATTERN.test(segment) || (previousSegment.length > 0 && hasValidationRunContext(previousSegment));
}

function hasValidationFailure(segments: readonly string[]): boolean {
  for (let index = 0; index < segments.length; index += 1) {
    const scrubbed = removeNoValidationFailureAssertions(segments[index]);
    if (scrubbed.length === 0) continue;

    const hasFailure = VALIDATION_FAILURE_PATTERN.test(scrubbed) || CONTEXTUAL_VALIDATION_ERROR_PATTERN.test(scrubbed);
    const hasNegatedSuccess = VALIDATION_NEGATED_SUCCESS_PATTERN.test(scrubbed);
    if (!hasFailure && !hasNegatedSuccess) continue;

    const previous = index > 0 ? removeNoValidationFailureAssertions(segments[index - 1]) : "";
    if (validationConditionHasContext(scrubbed, previous)) return true;
  }
  return false;
}

function validationEvidenceState(segments: readonly string[]): boolean | undefined {
  const scrubbedSegments = segments
    .map(removeNoValidationFailureAssertions)
    .filter((segment) => segment.length > 0);
  const validationPolicy = REVIEW_EVIDENCE_POLICIES.validation_backed;

  for (let index = 0; index < scrubbedSegments.length; index += 1) {
    const segment = scrubbedSegments[index];
    if (!VALIDATION_NEGATED_SUCCESS_PATTERN.test(segment)) continue;

    const previous = index > 0 ? scrubbedSegments[index - 1] : "";
    if (validationConditionHasContext(segment, previous)) return false;
  }

  if (scrubbedSegments.some((segment) => matchesAnyPattern(segment, validationPolicy.negative))) return false;
  if (scrubbedSegments.some((segment) => matchesAnyPattern(segment, validationPolicy.positive))) return true;

  for (let index = 1; index < scrubbedSegments.length; index += 1) {
    if (VALIDATION_SUCCESS_PATTERN.test(scrubbedSegments[index]) && hasValidationRunContext(scrubbedSegments[index - 1])) return true;
  }
  return undefined;
}

function emptySeverityCounts(): Required<SeverityCounts> {
  return { p0: 0, p1: 0, p2: 0, p3: 0 };
}

function severityFindingLines(value: string, severity: SeverityLevel): number {
  const findingPattern = new RegExp(`(?:^|\\s)(?:-\\s*)?(?:\\[${severity}\\]|${severity}\\s*(?::\\s*\\S|[-–—]\\s*\\S))`, "i");
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (/^#{1,6}\s*(?:p[0-3])\b/i.test(line)) return false;
      if (/^(?:-\s*)?(?:p[0-3]\s*:\s*)?(?:none(?:\s+(?:found|identified|reported))?|no\s+(?:findings?|issues?|blockers?)|n\/a|nothing)\.?$/i.test(line)) return false;
      return findingPattern.test(line);
    })
    .length;
}

export function parseEvidenceFromText(value: string): ReviewEvidence {
  const textValue = value.toLowerCase();
  const segments = reviewSegments(value);
  const validationFailed = hasValidationFailure(segments);
  const severity_counts = emptySeverityCounts();
  for (const severity of SEVERITY_LEVELS) {
    severity_counts[severity] = severityFindingLines(value, severity);
  }

  return {
    independent: criterionEvidenceState(segments, REVIEW_EVIDENCE_POLICIES.independent),
    acceptance_mapped: criterionEvidenceState(segments, REVIEW_EVIDENCE_POLICIES.acceptance_mapped),
    diff_aware: criterionEvidenceState(segments, REVIEW_EVIDENCE_POLICIES.diff_aware),
    validation_backed: validationFailed ? false : validationEvidenceState(segments),
    risk_aware: criterionEvidenceState(segments, REVIEW_EVIDENCE_POLICIES.risk_aware),
    fresh: criterionEvidenceState(segments, REVIEW_EVIDENCE_POLICIES.fresh),
    severity_counts,
    conflicted: /conflict(ed|ing)? evidence/.test(textValue),
    validation_failed: validationFailed,
    blocked: /blocked|unable to review|missing dependency/.test(textValue),
  };
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

function normalizedChildOutput(result: unknown): Record<string, unknown> {
  const outputs = childOutputs(result);
  const selected: Record<string, unknown> = {};
  for (const key of CHILD_OUTPUT_KEYS) {
    if (outputs[key] !== undefined) selected[key] = outputs[key];
  }

  const omittedChildOutputKeys = Object.keys(outputs)
    .filter((key) => !CHILD_OUTPUT_KEY_SET.has(key))
    .sort();
  if (omittedChildOutputKeys.length > 0) selected.omitted_child_output_keys = omittedChildOutputKeys;

  return outputRecord(selected);
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

function compactChildOutputForReceipt(childOutput: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(childOutput)) {
    compacted[key] = compactReceiptValue(value);
  }
  return outputRecord(compacted);
}

type ChildRunGate =
  | { state: "approved"; parent_status?: undefined; reason: string; approved: true; status?: string }
  | { state: "non_approved"; parent_status: "needs_human"; reason: string; approved?: boolean; status?: string }
  | { state: "blocked"; parent_status: "blocked"; reason: string; approved?: boolean; status: string }
  | { state: "missing_approval"; parent_status: "needs_human"; reason: string; approved?: boolean; status?: string };

type ChildReviewArtifact = {
  body: string;
  evidenceText: string;
  trace: Record<string, unknown>;
  reportPath?: string;
};

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  const stringValue = typeof value === "string" ? value.trim() : "";
  return stringValue.length > 0 ? stringValue : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CHILD_FAILURE_STATUSES = new Set(["blocked", "failed", "failure", "error", "errored"]);
const CHILD_NEEDS_HUMAN_STATUSES = new Set(["needs_human", "rejected", "stopped", "active", "pending", "running"]);
const CHILD_SUCCESS_STATUSES = new Set(["complete", "completed", "success", "succeeded", "passed"]);

function childStatusIs(status: string | undefined, statuses: ReadonlySet<string>): boolean {
  return status !== undefined && statuses.has(status);
}

export function gateChildRunCompletion(childOutput: Record<string, unknown>, runner: Exclude<ResolvedImplementationRunner, "handoff-only">): ChildRunGate {
  const approved = optionalBoolean(childOutput.approved);
  const status = optionalNonEmptyString(childOutput.status);
  const normalizedStatus = status?.toLowerCase();

  if (childStatusIs(normalizedStatus, CHILD_FAILURE_STATUSES)) {
    return { state: "blocked", parent_status: "blocked", reason: `Child ${runner} returned status=${status}.`, approved, status };
  }
  if (approved === false) {
    return { state: "non_approved", parent_status: "needs_human", reason: `Child ${runner} returned approved=false.`, approved, status };
  }
  if (childStatusIs(normalizedStatus, CHILD_NEEDS_HUMAN_STATUSES)) {
    return { state: "non_approved", parent_status: "needs_human", reason: `Child ${runner} returned status=${status}.`, approved, status };
  }
  if (approved !== true) {
    return { state: "missing_approval", parent_status: "needs_human", reason: `Child ${runner} did not return approved=true.`, approved, status };
  }
  if (normalizedStatus !== undefined && !childStatusIs(normalizedStatus, CHILD_SUCCESS_STATUSES)) {
    return { state: "non_approved", parent_status: "needs_human", reason: `Child ${runner} returned unknown status=${status}.`, approved, status };
  }

  return { state: "approved", reason: `Child ${runner} returned approved=true.`, approved, status };
}

type CompactReviewPointer = {
  kind: "output_saved_to" | "latest_review_round_artifact";
  path?: string;
};

const ATOMIC_FILE_ONLY_SUFFIX_PATTERN = /\s+\(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB),\s*\d+\s+lines?\)\.?(?:\s+Read this file if needed\.?)?$/i;

function unquoteMatchingPath(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) return value.slice(1, -1);
  return value;
}

function compactReviewPointerKind(label: string): CompactReviewPointer["kind"] {
  return /^latest review round artifact$/i.test(label) ? "latest_review_round_artifact" : "output_saved_to";
}

function parseCompactReviewPointer(value: string): CompactReviewPointer | undefined {
  const firstSubstantiveLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

  const match = firstSubstantiveLine.match(/^(output saved to|saved output to|saved to|latest review round artifact):\s*(.*)$/i);
  if (!match) return undefined;

  const kind = compactReviewPointerKind(match[1]);
  const target = match[2].trim();
  if (target.length === 0) return { kind };

  const path = unquoteMatchingPath(target.replace(ATOMIC_FILE_ONLY_SUFFIX_PATTERN, "").trim());
  return { kind, path };
}

function appendMultilineReviewArtifactField(lines: string[], label: string, value: string): void {
  lines.push(`${label}:`);
  lines.push(...value
    .replace(/\.\s+(?=P[0-3]\s*:)/gi, ".\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0));
}

function appendReviewArtifactField(lines: string[], label: string, value: unknown): void {
  if (typeof value === "number" || typeof value === "boolean") {
    lines.push(`${label}: ${String(value)}`);
    return;
  }
  if (typeof value !== "string") return;

  const trimmed = value.trim();
  if (trimmed.length === 0) return;

  if (label === "raw_text" || label === "overall_explanation") {
    appendMultilineReviewArtifactField(lines, label, trimmed);
  } else {
    lines.push(`${label}: ${trimmed}`);
  }

  if (label === "overall_correctness" && /\b(?:incorrect|wrong|not\s+correct|failed|failure)\b/i.test(trimmed)) {
    lines.push(`P1: overall_correctness ${trimmed}`);
  }
}

function prioritySeverity(value: unknown): SeverityLevel | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) return `p${value}` as SeverityLevel;
  const match = typeof value === "string" ? value.match(/\bp([0-3])\b|^\s*([0-3])\s*$/i) : undefined;
  const digit = match?.[1] ?? match?.[2];
  return digit ? `p${digit}` as SeverityLevel : undefined;
}

function appendReviewFinding(lines: string[], finding: Record<string, unknown>): void {
  const title = optionalNonEmptyString(finding.title);
  const body = optionalNonEmptyString(finding.body) ?? optionalNonEmptyString(finding.description);
  const priority = prioritySeverity(finding.priority ?? finding.severity);

  if (priority !== undefined) lines.push(`${priority.toUpperCase()}: ${title ?? body ?? "structured finding"}`);
  if (title !== undefined) lines.push(`finding_title: ${title}`);
  if (body !== undefined) lines.push(`finding_body: ${body}`);
  appendReviewArtifactField(lines, "priority", finding.priority ?? finding.severity);

  const codeLocation = finding.code_location;
  if (typeof codeLocation === "object" && codeLocation !== null) {
    const path = optionalNonEmptyString((codeLocation as Record<string, unknown>).absolute_file_path);
    if (path !== undefined) lines.push(`file: ${path}`);
  }
}

function appendSeverityCounts(lines: string[], value: Record<string, unknown>): void {
  for (const severity of SEVERITY_LEVELS) {
    const count = value[severity] ?? value[severity.toUpperCase()];
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      lines.push(`${severity.toUpperCase()}: severity count reported ${Math.floor(count)}`);
    } else if (typeof count === "number" && count === 0) {
      lines.push(`${severity.toUpperCase()}: none`);
    }
  }
}

function appendReviewArtifactJson(lines: string[], value: unknown, key = "root"): void {
  if (Array.isArray(value)) {
    for (const item of value) appendReviewArtifactJson(lines, item, key);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const record = value as Record<string, unknown>;
  if (key === "findings") {
    appendReviewFinding(lines, record);
  }

  for (const [childKey, childValue] of Object.entries(record)) {
    if (childKey === "findings" && Array.isArray(childValue)) {
      for (const finding of childValue) {
        if (typeof finding === "object" && finding !== null) appendReviewFinding(lines, finding as Record<string, unknown>);
      }
      continue;
    }
    if (childKey === "severity_counts" && typeof childValue === "object" && childValue !== null) {
      appendSeverityCounts(lines, childValue as Record<string, unknown>);
      continue;
    }
    if (/^(?:reviewer|overall_correctness|overall_explanation|raw_text|validation(?:_notes|_output|_summary|_results)?|commands_run|notes?)$/i.test(childKey)) {
      appendReviewArtifactField(lines, childKey, childValue);
      continue;
    }
    appendReviewArtifactJson(lines, childValue, childKey);
  }
}

export function reviewArtifactToEvidenceText(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const lines: string[] = [];
    appendReviewArtifactJson(lines, parsed);
    return lines.length > 0 ? lines.join("\n") : body;
  } catch {
    return body;
  }
}

async function loadReviewArtifactPath(path: string): Promise<string> {
  const body = await readFile(path, "utf8");
  if (body.trim().length === 0) throw new Error(`Child review artifact is empty: ${path}`);
  return body;
}

async function loadReviewEvidenceArtifact(path: string, trace: Record<string, unknown>): Promise<ChildReviewArtifact> {
  const body = await loadReviewArtifactPath(path);
  return {
    body,
    evidenceText: reviewArtifactToEvidenceText(body),
    reportPath: path,
    trace,
  };
}

export async function loadChildReviewArtifact(childOutput: Record<string, unknown>): Promise<ChildReviewArtifact> {
  const reviewReportPath = optionalNonEmptyString(childOutput.review_report_path);
  const inlineReviewReport = optionalNonEmptyString(childOutput.review_report);
  const inlineCompactPointer = inlineReviewReport !== undefined ? parseCompactReviewPointer(inlineReviewReport) : undefined;

  if (reviewReportPath !== undefined) {
    try {
      return await loadReviewEvidenceArtifact(reviewReportPath, { source: "review_report_path", path: reviewReportPath, loaded: true });
    } catch (error) {
      const reviewReportPathError = errorMessage(error);
      return {
        body: "",
        evidenceText: `blocked unable to review missing dependency: child review_report_path unreadable: ${reviewReportPath}: ${reviewReportPathError}`,
        trace: { source: "review_report_path", path: reviewReportPath, loaded: false, error: reviewReportPathError, fail_closed: true },
      };
    }
  }

  if (inlineReviewReport !== undefined) {
    if (inlineCompactPointer !== undefined) {
      if (inlineCompactPointer.path !== undefined) {
        try {
          return await loadReviewEvidenceArtifact(inlineCompactPointer.path, {
            source: "inline_review_report_pointer",
            path: inlineCompactPointer.path,
            loaded: true,
            compact_pointer: true,
            pointer_kind: inlineCompactPointer.kind,
          });
        } catch (error) {
          const pointerErrorMessage = errorMessage(error);
          return {
            body: "",
            evidenceText: `blocked unable to review missing dependency: compact child review_report pointer unreadable: ${inlineCompactPointer.path}: ${pointerErrorMessage}`,
            trace: { source: "inline_review_report_pointer", path: inlineCompactPointer.path, loaded: false, compact_pointer: true, pointer_kind: inlineCompactPointer.kind, error: pointerErrorMessage, fail_closed: true },
          };
        }
      }
      return {
        body: "",
        evidenceText: "blocked unable to review missing dependency: child review_report is only a compact file-only pointer without a readable path",
        trace: { source: "inline_review_report_pointer", loaded: false, compact_pointer: true, pointer_kind: inlineCompactPointer.kind, fail_closed: true },
      };
    }
    return {
      body: inlineReviewReport,
      evidenceText: reviewArtifactToEvidenceText(inlineReviewReport),
      trace: { source: "inline_review_report", loaded: true },
    };
  }

  return {
    body: "",
    evidenceText: "blocked unable to review missing dependency: child output did not include review_report_path or substantive review_report",
    trace: { source: "missing_child_review_report", loaded: false, fail_closed: true },
  };
}

const COMPOUND_ENGINEERING_EVIDENCE_KEY = "compound_engineering_evidence";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactErrorList(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, 20);
}

function hasSubstantiveEvidence(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

const PASSING_COMMAND_SUMMARY_PATTERN = /\b(?:pass(?:ed|es|ing)?|succeed(?:ed|s|ing)?|success(?:ful|fully)?|exit\s+(?:code|status)\s*:?\s*0|(?:exit_)?code\s*:?\s*0|status\s*:?\s*0|0\s+(?:failures?|errors?)|zero\s+(?:failures?|errors?)|no\s+(?:failures?|errors?)|all\s+tests?\s+passed)\b/i;
const FAILING_COMMAND_SUMMARY_PATTERN = /\b(?:fail(?:ed|s|ing|ures?)|errored|non[-\s]?zero|exit\s+(?:code|status)\s*:?\s*[1-9]\d*|(?:exit_)?code\s*:?\s*[1-9]\d*|status\s*:?\s*[1-9]\d*)\b/i;

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
    const exitCode = command.exit_code;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
      if (Math.trunc(exitCode) !== 0) return false;
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
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      errors.push(`severity_counts.${severity} must be a non-negative number`);
      return undefined;
    }
    counts[severity] = Math.floor(count);
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
      errors: [`${COMPOUND_ENGINEERING_EVIDENCE_KEY} must be an object`],
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

  if (typeof value.blocked === "boolean") evidence.blocked = value.blocked;
  if (typeof value.conflicted === "boolean") evidence.conflicted = value.conflicted;
  if (typeof value.validation_failed === "boolean") evidence.validation_failed = value.validation_failed;
  if (isRecord(value.validation_backed) && validationCommandsPass(value.validation_backed.commands) === false) {
    evidence.validation_backed = false;
    evidence.validation_failed = true;
    if (!missing.includes("validation_backed")) missing.push("validation_backed");
    errors.push("validation_backed.commands must all have zero exit codes or explicit passing summaries");
  }

  return { evidence, missing, errors: compactErrorList(errors) };
}

function findNamedEvidence(value: unknown, seen = new WeakSet<object>()): unknown | undefined {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, COMPOUND_ENGINEERING_EVIDENCE_KEY)) {
    return value[COMPOUND_ENGINEERING_EVIDENCE_KEY];
  }

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const childValue of values) {
    const found = findNamedEvidence(childValue, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseJsonCandidate(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractJsonEvidenceFromBody(body: string): unknown | undefined {
  const parsedBody = parseJsonCandidate(body);
  const direct = parsedBody !== undefined ? findNamedEvidence(parsedBody) : undefined;
  if (direct !== undefined) return direct;

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of body.matchAll(fencePattern)) {
    const parsedFence = parseJsonCandidate(match[1].trim());
    const fromFence = parsedFence !== undefined ? findNamedEvidence(parsedFence) : undefined;
    if (fromFence !== undefined) return fromFence;
  }

  return undefined;
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

async function loadStructuredChildEvidence(childOutput: Record<string, unknown>): Promise<StructuredEvidenceGate> {
  const directEvidence = childOutput[COMPOUND_ENGINEERING_EVIDENCE_KEY];
  if (directEvidence !== undefined) {
    const converted = structuredEvidenceToReviewEvidence(directEvidence);
    return {
      childEvidence: converted.evidence,
      trace: {
        source: "child_output",
        contract: COMPOUND_ENGINEERING_EVIDENCE_KEY,
        loaded: true,
        missing: converted.missing,
        errors: converted.errors,
      },
      missing: converted.missing,
      errors: converted.errors,
    };
  }

  const childReviewArtifact = await loadChildReviewArtifact(childOutput);
  if (childReviewArtifact.trace.fail_closed === true) {
    return {
      childEvidence: { blocked: true, severity_counts: emptySeverityCounts() },
      trace: {
        ...childReviewArtifact.trace,
        contract: COMPOUND_ENGINEERING_EVIDENCE_KEY,
        loaded: false,
        errors: ["child review artifact was missing or unreadable"],
      },
      missing: [...REVIEW_CRITERIA],
      errors: ["child review artifact was missing or unreadable"],
      childReviewArtifact,
    };
  }

  const artifactEvidence = extractJsonEvidenceFromBody(childReviewArtifact.body);
  if (artifactEvidence === undefined) {
    const missingError = `missing named ${COMPOUND_ENGINEERING_EVIDENCE_KEY} block in child review artifact`;
    return {
      childEvidence: { severity_counts: emptySeverityCounts() },
      trace: {
        ...childReviewArtifact.trace,
        contract: COMPOUND_ENGINEERING_EVIDENCE_KEY,
        loaded: false,
        errors: [missingError],
      },
      missing: [...REVIEW_CRITERIA],
      errors: [missingError],
      childReviewArtifact,
    };
  }

  const converted = structuredEvidenceToReviewEvidence(artifactEvidence);
  return {
    childEvidence: converted.evidence,
    trace: {
      ...childReviewArtifact.trace,
      contract: COMPOUND_ENGINEERING_EVIDENCE_KEY,
      loaded: true,
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
  .input("max_loops", Type.Number({ default: DEFAULT_MAX_LOOPS, description: "Maximum implementation/fix/review loops to include in handoff metadata." }))
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
  .output("implementation", Type.Optional(Type.Object({}, { additionalProperties: true, description: "Guarded handoff metadata or child-run summary." })))
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

    if (prompt.length === 0) {
      const message = "Blocked: prompt is required.";
      await writeFinalReport({ status: "blocked", mode, runner, prompt, message });
      await writeFinalManifest({ manifestPath, runId, startedAt, input: baseInput, finalReportPath, artifacts });
      return outputRecord({ status: "blocked", mode, runner, approved: false, artifact_dir: displayPath(artifactDir), manifest_path: displayPath(manifestPath), message });
    }

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
    const childOutput = normalizedChildOutput(childResult);
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

    const structuredGate = await loadStructuredChildEvidence(childOutput);
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

export { compoundEngineeringWorkflow };
export default compoundEngineeringWorkflow;
