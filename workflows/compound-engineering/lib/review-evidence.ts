import { readFile } from "node:fs/promises";
import type { ResolvedImplementationRunner, ReviewCriterion, ReviewEvidence, SeverityCounts } from "../helpers.js";

type SufficiencyCriterion = ReviewCriterion;
export type SeverityLevel = keyof Required<SeverityCounts>;

export const SEVERITY_LEVELS: readonly SeverityLevel[] = ["p0", "p1", "p2", "p3"];

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

export function emptySeverityCounts(): Required<SeverityCounts> {
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

const BLOCKED_POSITIVE_PATTERNS = [
  /\bblocked\b/,
  /\bblockers?\b/,
  /\bblocking\s+issues?\b/,
  /\bunable\s+to\s+review\b/,
  /\bmissing\s+dependenc(?:y|ies)\b/,
] as const;

const BLOCKED_NEGATIVE_PATTERNS = [
  /\bnot\s+blocked\b/,
  /\bno\s+blockers?\b/,
  /\bno\s+blocking\s+issues?\b/,
  /\bnot\s+unable\s+to\s+review\b/,
] as const;

const CONFLICTED_POSITIVE_PATTERNS = [
  /\bconflict(?:ed|ing)?\s+evidence\b/,
  /\bevidence\s+conflicts?\b/,
  /\bconflicts?\b/,
  /\bconflicted\b/,
] as const;

const CONFLICTED_NEGATIVE_PATTERNS = [
  /\bno\s+conflicting\s+evidence\b/,
  /\bno\s+conflicts?\b/,
  /\bnot\s+conflicted\b/,
  /\bno\s+evidence\s+conflicts?\b/,
] as const;

function hardStopEvidenceState(segments: readonly string[], positive: readonly RegExp[], negative: readonly RegExp[]): boolean | undefined {
  let found = false;
  for (const segment of segments) {
    for (const clause of segment.split(/,|\bbut\b/).map((part) => part.trim()).filter((part) => part.length > 0)) {
      if (matchesAnyPattern(clause, negative)) continue;
      if (matchesAnyPattern(clause, positive)) found = true;
    }
  }
  return found ? true : undefined;
}

export function parseEvidenceFromText(value: string): ReviewEvidence {
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
    conflicted: hardStopEvidenceState(segments, CONFLICTED_POSITIVE_PATTERNS, CONFLICTED_NEGATIVE_PATTERNS),
    validation_failed: validationFailed,
    blocked: hardStopEvidenceState(segments, BLOCKED_POSITIVE_PATTERNS, BLOCKED_NEGATIVE_PATTERNS),
  };
}

export type ChildRunGate =
  | { state: "approved"; parent_status?: undefined; reason: string; approved: true; status?: string }
  | { state: "non_approved"; parent_status: "needs_human"; reason: string; approved?: boolean; status?: string }
  | { state: "blocked"; parent_status: "blocked"; reason: string; approved?: boolean; status: string }
  | { state: "missing_approval"; parent_status: "needs_human"; reason: string; approved?: boolean; status?: string };

export type ChildReviewArtifact = {
  body: string;
  evidenceText: string;
  trace: Record<string, unknown>;
  reportPath?: string;
};

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function optionalNonEmptyString(value: unknown): string | undefined {
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
  if (runner === "goal") {
    if (normalizedStatus === undefined) {
      return { state: "missing_approval", parent_status: "needs_human", reason: "Child goal did not return status=complete.", approved, status };
    }
    if (normalizedStatus !== "complete") {
      return { state: "non_approved", parent_status: "needs_human", reason: `Child goal returned status=${status}; expected status=complete.`, approved, status };
    }
  } else if (normalizedStatus !== undefined && !childStatusIs(normalizedStatus, CHILD_SUCCESS_STATUSES)) {
    return { state: "non_approved", parent_status: "needs_human", reason: `Child ${runner} returned unknown status=${status}.`, approved, status };
  }

  return { state: "approved", reason: `Child ${runner} returned approved=true${runner === "goal" ? " and status=complete" : ""}.`, approved, status };
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
    if (typeof count === "number" && Number.isInteger(count) && count > 0) {
      lines.push(`${severity.toUpperCase()}: severity count reported ${count}`);
    } else if (typeof count === "number" && count === 0) {
      lines.push(`${severity.toUpperCase()}: none`);
    } else if (count !== undefined) {
      lines.push(`P1: malformed ${severity.toUpperCase()} severity count; expected a non-negative integer`);
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

  for (const key of ["ledger_path", "implementation_notes_path"] as const) {
    const artifactPath = optionalNonEmptyString(childOutput[key]);
    if (artifactPath === undefined) continue;
    try {
      return await loadReviewEvidenceArtifact(artifactPath, { source: key, path: artifactPath, loaded: true, declared_artifact_fallback: true });
    } catch (error) {
      const artifactErrorMessage = errorMessage(error);
      return {
        body: "",
        evidenceText: `blocked unable to review missing dependency: declared child ${key} unreadable: ${artifactPath}: ${artifactErrorMessage}`,
        trace: { source: key, path: artifactPath, loaded: false, declared_artifact_fallback: true, error: artifactErrorMessage, fail_closed: true },
      };
    }
  }

  return {
    body: "",
    evidenceText: "blocked unable to review missing dependency: child output did not include review_report_path, substantive review_report, ledger_path, or implementation_notes_path evidence",
    trace: { source: "missing_child_review_report", loaded: false, fail_closed: true },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
