const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const DEFAULT_BABYSIT_PR_BASE_BRANCH = "origin/main";
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_POLL_TIMEOUT_SECONDS = 1_800;

export type PullRequestRefSource = "url" | "shorthand" | "bare";

export type PullRequestIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly source: PullRequestRefSource;
};

export type PrRefErrorCode =
  | "EmptyInput"
  | "InvalidFormat"
  | "BareNumberWithoutOrigin"
  | "UnsupportedHost"
  | "InvalidNumber";

export type PrRefError = {
  readonly code: PrRefErrorCode;
  readonly message: string;
};

export type PrRefParseResult =
  | { readonly ok: true; readonly identity: PullRequestIdentity }
  | { readonly ok: false; readonly error: PrRefError };

export type CheckState = "pending" | "success" | "neutral" | "failure" | "cancelled" | "unknown";

export type PullRequestLifecycleState = "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";

export type MergeabilityKind = "clean" | "blocked" | "dirty" | "conflicting" | "unknown";

export type MergeabilityState = {
  readonly kind: MergeabilityKind;
  readonly mergeable?: string | boolean | null;
  readonly merge_state_status?: string | null;
  readonly reason?: string;
};

export type CheckRecord = {
  readonly name: string;
  readonly state?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly bucket?: string | null;
  readonly link?: string | null;
  readonly head_sha?: string | null;
};

export type CheckSummary = {
  readonly state: CheckState;
  readonly required_scope: "all-checks" | "required-checks" | "required-plus-visible";
  readonly observed: boolean;
  readonly observed_count: number;
  readonly checks: readonly CheckRecord[];
  readonly failing: readonly CheckRecord[];
  readonly pending: readonly CheckRecord[];
  readonly unknown: readonly CheckRecord[];
};

export type ReviewThread = {
  readonly id: string;
  readonly source?: "inline";
  readonly path?: string;
  readonly line?: number;
  readonly body: string;
  readonly author: string;
  readonly resolved: boolean;
  readonly outdated?: boolean;
  readonly actionable: boolean;
  readonly reason?: string;
};

export type CommentSignal = {
  readonly id: string;
  readonly source: "comment" | "review";
  readonly body: string;
  readonly author: string;
  readonly actionable: boolean;
  readonly reason?: string;
};

export type GitStatusEntry = {
  readonly status: string;
  readonly path: string;
};

export type HeadRepositoryIdentity =
  | {
    readonly kind: "known";
    readonly owner: string;
    readonly repo: string;
    readonly full_name: string;
    readonly is_cross_repository: boolean;
  }
  | {
    readonly kind: "unknown";
    readonly reason: "missing_head_repository" | "missing_head_owner" | "inaccessible_fork" | "invalid_head_repo";
  };

export type RemediationReceiptChange =
  | { readonly change: "add" | "modify" | "delete"; readonly path: string }
  | { readonly change: "rename" | "copy"; readonly old_path: string; readonly new_path: string };

export type RemediationReceiptTest = {
  readonly command: string;
  readonly result: "passed" | "failed" | "skipped";
  readonly note?: string;
};

export type RemediationReceipt = {
  readonly changed_files: readonly RemediationReceiptChange[];
  readonly tests_run: readonly RemediationReceiptTest[];
  readonly residual_items: readonly string[];
  readonly addressed_comment_signal_ids?: readonly string[];
};

export type RemediationReceiptParseResult =
  | { readonly ok: true; readonly receipt: RemediationReceipt }
  | { readonly ok: false; readonly error: string };

export type RemediationOwnershipResult =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly error: string };

export type RemediationReceiptOutcomeResult =
  | { readonly ok: true; readonly passed_tests: readonly string[]; readonly skipped_tests: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly failed_tests: readonly string[]; readonly residual_items: readonly string[] };

export type ReceiptAddressedCommentSignalValidationResult =
  | { readonly ok: true; readonly addressed_comment_signal_ids: readonly string[] }
  | { readonly ok: false; readonly error: string };

export type PullRequestState = {
  readonly identity: PullRequestIdentity;
  readonly url: string;
  readonly base_ref: string;
  readonly head_ref: string;
  readonly head_repo: string;
  readonly head_repository: HeadRepositoryIdentity;
  readonly lifecycle_state: PullRequestLifecycleState;
  readonly maintainer_can_modify: boolean;
  readonly push_accessible?: boolean;
  readonly review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "UNKNOWN";
  readonly review_threads: readonly ReviewThread[];
  readonly comment_signals: readonly CommentSignal[];
  readonly addressed_comment_signal_ids?: readonly string[];
  readonly checks: CheckSummary;
  readonly head_sha: string;
  readonly mergeability?: MergeabilityState;
  readonly merge_conflict?: boolean;
  readonly ambiguous_feedback?: boolean;
  readonly ci_timed_out?: boolean;
  readonly non_fast_forward?: boolean;
  readonly blockers?: readonly string[];
};

export type IterationHistory = {
  readonly iterations_completed: number;
  readonly max_iterations: number;
  readonly consecutive_no_progress?: number;
};

export type LoopDecision =
  | { readonly kind: "clean"; readonly reason: string }
  | { readonly kind: "wait_for_ci"; readonly pending: readonly string[] }
  | { readonly kind: "remediate"; readonly feedback_count: number; readonly failing_checks: readonly string[] }
  | { readonly kind: "needs_human"; readonly reason: string; readonly remaining: readonly string[] }
  | { readonly kind: "exhausted"; readonly iterations_completed: number; readonly remaining: readonly string[] };

export type PreflightAction = "wait_for_ci" | "fix_failure" | "respond_to_review" | "done" | "ask_human";

export type PreflightDecision = {
  readonly action: PreflightAction;
  readonly confidence: "low" | "medium" | "high";
  readonly evidence: readonly string[];
  readonly next_stage: "poll_ci" | "checkout_and_remediate" | "final_report" | "human";
  readonly commands_run: readonly string[];
  readonly stop_reason: string;
  readonly local_validation: "not_run_not_needed" | "not_run_deferred_until_remediation";
  readonly loop_decision: LoopDecision;
};

export type BoundedNumberOptions = {
  readonly min?: number;
  readonly max?: number;
  readonly fallback: number;
};

function prRefError(code: PrRefErrorCode, message: string): PrRefParseResult {
  return { ok: false, error: { code, message } };
}

function validSlug(value: string): boolean {
  return GITHUB_SLUG_PATTERN.test(value) && !value.startsWith(".") && !value.endsWith(".");
}

function parsePositivePrNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function parseGitHubRemoteUrl(remoteUrl: string | undefined): { owner: string; repo: string } | undefined {
  const value = remoteUrl?.trim();
  if (!value) return undefined;

  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== "github.com") return undefined;
      const [owner = "", repoWithSuffix = "", extra = ""] = url.pathname.replace(/^\//, "").split("/");
      const repo = repoWithSuffix.replace(/\.git$/i, "");
      return extra.length === 0 && validSlug(owner) && validSlug(repo) ? { owner, repo } : undefined;
    } catch {
      return undefined;
    }
  }

  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)
    ?? value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return validSlug(owner) && validSlug(repo) ? { owner, repo } : undefined;
  }

  return undefined;
}

export function parsePullRequestRef(
  input: string | undefined,
  options: { readonly originUrl?: string } = {},
): PrRefParseResult {
  const value = input?.trim() ?? "";
  if (value.length === 0) {
    return prRefError("EmptyInput", "Pull request reference is required.");
  }

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return prRefError("InvalidFormat", "Pull request URL is not a valid URL.");
    }

    if (url.hostname.toLowerCase() !== "github.com") {
      return prRefError("UnsupportedHost", "Only github.com pull request URLs are supported.");
    }

    const [, owner = "", repo = "", segment = "", numberText = "", extra = ""] = url.pathname.split("/");
    if (segment !== "pull" || extra.length > 0 || !validSlug(owner) || !validSlug(repo)) {
      return prRefError("InvalidFormat", "Expected GitHub PR URL format: https://github.com/<owner>/<repo>/pull/<number>.");
    }

    const number = parsePositivePrNumber(numberText);
    if (number === undefined) {
      return prRefError("InvalidNumber", "Pull request number must be a positive safe integer.");
    }

    return { ok: true, identity: { owner, repo, number, source: "url" } };
  }

  const shorthand = value.match(/^([^\s/#]+\/[^\s/#]+)#(\d+)$/);
  if (shorthand) {
    const [owner, repo] = shorthand[1].split("/");
    const number = parsePositivePrNumber(shorthand[2]);
    if (!GITHUB_OWNER_REPO_PATTERN.test(shorthand[1]) || !validSlug(owner) || !validSlug(repo)) {
      return prRefError("InvalidFormat", "Expected shorthand PR format: <owner>/<repo>#<number>.");
    }
    if (number === undefined) {
      return prRefError("InvalidNumber", "Pull request number must be a positive safe integer.");
    }

    return { ok: true, identity: { owner, repo, number, source: "shorthand" } };
  }

  const bareNumber = parsePositivePrNumber(value);
  if (bareNumber !== undefined) {
    const remote = parseGitHubRemoteUrl(options.originUrl);
    if (!remote) {
      return prRefError("BareNumberWithoutOrigin", "Bare PR numbers require a resolvable GitHub origin remote.");
    }

    return {
      ok: true,
      identity: {
        owner: remote.owner,
        repo: remote.repo,
        number: bareNumber,
        source: "bare",
      },
    };
  }

  if (/^\d+$/.test(value)) {
    return prRefError("InvalidNumber", "Pull request number must be a positive safe integer.");
  }

  return prRefError("InvalidFormat", "Expected a GitHub PR URL, <owner>/<repo>#<number>, or bare PR number.");
}

export function normalizeBoundedInteger(value: unknown, options: BoundedNumberOptions): number {
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number)) return options.fallback;
  const integer = Math.floor(number);
  if (integer < min || integer > max) return options.fallback;
  return integer;
}

export function normalizeBaseBranchInput(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_BABYSIT_PR_BASE_BRANCH;
}

export function normalizeRequestedGitWorktreeDir(value: string | undefined): string {
  return value?.trim() ?? "";
}

function textList(values: readonly (string | undefined)[]): readonly string[] {
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

function normalizeCheckToken(value: string | boolean | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function actionableFeedbackText(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;

  return [
    /\bplease\s+(?:fix|change|update|address|resolve|handle|remove|add|rename|rework|look into|take a look at)\b/,
    /\b(?:should|could we|can we|would you)\s+(?:fix|change|update|address|resolve|handle|remove|add|rename|rework|avoid|prefer|consider)\b/,
    /\b(?:must|need(?:s)? to|required|requirement|blocker|action required)\b/,
    /\b(?:fix|bug|broken|failing|failure|fail(?:s|ed|ing)?|error|regression|incorrect|invalid|missing|crash|leak|race|todo|stale|outdated|merge conflict|conflict)\b/,
    /\b(?:nit|nits|nitpick|suggestion|consider|prefer|would prefer)\b/,
    /^(?:fix|change|update|address|resolve|handle|remove|add|rename|rework)\b/,
  ].some((pattern) => pattern.test(normalized));
}

export function normalizeMergeability(
  mergeable: string | boolean | null | undefined,
  mergeStateStatus: string | null | undefined,
): MergeabilityState {
  const mergeableToken = normalizeCheckToken(mergeable);
  const statusToken = normalizeCheckToken(mergeStateStatus);

  if ([mergeableToken, statusToken].some((token) => ["conflicting", "conflicts", "dirty"].includes(token))) {
    return {
      kind: statusToken === "dirty" ? "dirty" : "conflicting",
      mergeable: mergeable ?? null,
      merge_state_status: mergeStateStatus ?? null,
      reason: "GitHub reports that the PR cannot be merged cleanly.",
    };
  }

  if ([mergeableToken, statusToken].some((token) => ["blocked", "behind", "has_hooks", "unstable"].includes(token))) {
    return {
      kind: "blocked",
      mergeable: mergeable ?? null,
      merge_state_status: mergeStateStatus ?? null,
      reason: "GitHub reports mergeability is blocked.",
    };
  }

  if (mergeable === true || mergeableToken === "mergeable" || ["clean", "success"].includes(statusToken)) {
    return {
      kind: "clean",
      mergeable: mergeable ?? null,
      merge_state_status: mergeStateStatus ?? null,
    };
  }

  if ([mergeableToken, statusToken].some((token) => ["unknown", "", "null", "undefined"].includes(token))) {
    return {
      kind: "unknown",
      mergeable: mergeable ?? null,
      merge_state_status: mergeStateStatus ?? null,
      reason: "GitHub mergeability is unknown.",
    };
  }

  return {
    kind: "unknown",
    mergeable: mergeable ?? null,
    merge_state_status: mergeStateStatus ?? null,
    reason: "GitHub mergeability returned an unrecognized state.",
  };
}

export function normalizeReviewThreadNode(node: Record<string, unknown>, index = 0): ReviewThread | undefined {
  const comments = typeof node.comments === "object" && node.comments !== null
    ? (node.comments as Record<string, unknown>).nodes
    : undefined;
  const commentNodes = Array.isArray(comments) ? comments : [];
  const latestComment = [...commentNodes].reverse().find((comment) => typeof comment === "object" && comment !== null) as Record<string, unknown> | undefined;
  const body = String(latestComment?.body ?? node.body ?? "").trim();
  if (body.length === 0) return undefined;
  const author = typeof latestComment?.author === "object" && latestComment.author !== null && "login" in latestComment.author
    ? String((latestComment.author as { login?: unknown }).login ?? "unknown")
    : "unknown";
  const path = String(latestComment?.path ?? node.path ?? "").trim() || undefined;
  const lineValue = latestComment?.line ?? latestComment?.originalLine ?? node.line ?? node.originalLine;
  const line = typeof lineValue === "number" && Number.isSafeInteger(lineValue) && lineValue > 0 ? lineValue : undefined;
  const resolved = Boolean(node.isResolved ?? node.resolved ?? false);
  const outdated = Boolean(node.isOutdated ?? node.outdated ?? false);
  const actionable = !resolved && !outdated && actionableFeedbackText(body);

  return {
    id: String(node.id ?? latestComment?.id ?? `inline-${index}`),
    source: "inline",
    path,
    line,
    body,
    author,
    resolved,
    outdated,
    actionable,
    reason: actionable ? undefined : (resolved ? "Inline review thread is resolved." : outdated ? "Inline review thread is outdated." : "Inline review thread did not contain an obvious remediation request."),
  };
}

export function normalizeReviewThreadNodes(nodes: readonly unknown[]): readonly ReviewThread[] {
  return nodes.flatMap((node, index) => {
    if (typeof node !== "object" || node === null) return [];
    const thread = normalizeReviewThreadNode(node as Record<string, unknown>, index);
    return thread ? [thread] : [];
  });
}

export function normalizeCheckState(check: CheckRecord): CheckState {
  const tokens = [check.bucket, check.conclusion, check.state, check.status].map(normalizeCheckToken);

  if (tokens.some((token) => ["pending", "queued", "requested", "waiting", "in_progress", "expected"].includes(token))) {
    return "pending";
  }

  if (tokens.some((token) => ["failure", "failed", "timed_out", "startup_failure", "action_required", "error"].includes(token))) {
    return "failure";
  }

  if (tokens.some((token) => ["cancelled", "canceled", "stale"].includes(token))) {
    return "cancelled";
  }

  if (tokens.some((token) => ["skipped", "neutral"].includes(token))) {
    return "neutral";
  }

  if (tokens.some((token) => ["success", "successful", "pass", "passed"].includes(token))) {
    return "success";
  }

  return "unknown";
}

export function aggregateChecks(checks: readonly CheckRecord[]): CheckSummary {
  const pending: CheckRecord[] = [];
  const failing: CheckRecord[] = [];
  const unknown: CheckRecord[] = [];

  for (const check of checks) {
    switch (normalizeCheckState(check)) {
      case "pending":
        pending.push(check);
        break;
      case "failure":
      case "cancelled":
        failing.push(check);
        break;
      case "unknown":
        unknown.push(check);
        break;
      case "success":
      case "neutral":
        break;
    }
  }

  const observedCount = checks.length;
  let state: CheckState = observedCount > 0 ? "success" : "unknown";
  if (pending.length > 0) {
    state = "pending";
  } else if (failing.length > 0) {
    state = failing.some((check) => normalizeCheckState(check) === "failure") ? "failure" : "cancelled";
  } else if (unknown.length > 0) {
    state = "unknown";
  }

  return {
    state,
    required_scope: "all-checks",
    observed: observedCount > 0,
    observed_count: observedCount,
    checks: [...checks],
    failing,
    pending,
    unknown,
  };
}

function checkRecordKey(check: CheckRecord): string {
  return [check.name, check.link ?? "", check.state ?? "", check.status ?? "", check.conclusion ?? "", check.bucket ?? ""].join("\0");
}

function withCheckScope(summary: CheckSummary, requiredScope: CheckSummary["required_scope"]): CheckSummary {
  return { ...summary, required_scope: requiredScope };
}

export function mergeRequiredAndAllChecks(
  requiredChecks: CheckSummary | undefined,
  allChecks: CheckSummary | undefined,
): CheckSummary {
  if (!requiredChecks?.observed) return allChecks ?? aggregateChecks([]);
  if (!allChecks?.observed) return withCheckScope(requiredChecks, "required-checks");

  const visibleProblemChecks = [...allChecks.pending, ...allChecks.failing, ...allChecks.unknown];
  if (visibleProblemChecks.length === 0) return withCheckScope(requiredChecks, "required-checks");

  const merged = new Map<string, CheckRecord>();
  for (const check of [...requiredChecks.checks, ...visibleProblemChecks]) {
    merged.set(checkRecordKey(check), check);
  }

  return withCheckScope(aggregateChecks([...merged.values()]), "required-plus-visible");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string {
  return String(value ?? "").trim();
}

export function resolveHeadRepositoryIdentity(
  rawHeadRepository: unknown,
  rawHeadOwner: unknown,
  base: { readonly owner: string; readonly repo: string },
): HeadRepositoryIdentity {
  const headRepository = objectValue(rawHeadRepository);
  if (!headRepository) return { kind: "unknown", reason: "missing_head_repository" };

  const headOwner = objectValue(rawHeadOwner) ?? objectValue(headRepository.owner);
  if (!headOwner) return { kind: "unknown", reason: "missing_head_owner" };

  const owner = stringField(headOwner.login ?? headOwner.name);
  const repo = stringField(headRepository.name);
  const nameWithOwner = stringField(headRepository.nameWithOwner);
  const [nameWithOwnerOwner = "", nameWithOwnerRepo = ""] = nameWithOwner.split("/");
  const resolvedOwner = owner || nameWithOwnerOwner;
  const resolvedRepo = repo || nameWithOwnerRepo;

  if (!validSlug(resolvedOwner) || !validSlug(resolvedRepo)) {
    return { kind: "unknown", reason: "invalid_head_repo" };
  }

  const fullName = `${resolvedOwner}/${resolvedRepo}`;
  return {
    kind: "known",
    owner: resolvedOwner,
    repo: resolvedRepo,
    full_name: fullName,
    is_cross_repository: fullName.toLowerCase() !== `${base.owner}/${base.repo}`.toLowerCase(),
  };
}

export function liveReviewThreads(state: PullRequestState): readonly ReviewThread[] {
  return state.review_threads.filter((thread) => !thread.resolved && !thread.outdated);
}

export function actionableReviewThreads(state: PullRequestState): readonly ReviewThread[] {
  return liveReviewThreads(state).filter((thread) => thread.actionable);
}

export function addressedCommentSignalIds(state: Pick<PullRequestState, "addressed_comment_signal_ids">): ReadonlySet<string> {
  return new Set(state.addressed_comment_signal_ids ?? []);
}

export function actionableCommentSignals(state: PullRequestState): readonly CommentSignal[] {
  const addressed = addressedCommentSignalIds(state);
  return state.comment_signals.filter((signal) => signal.actionable && !addressed.has(signal.id));
}

export function remainingItemsForState(state: PullRequestState): readonly string[] {
  const reviewItems = liveReviewThreads(state).map((thread) => {
    const location = textList([thread.path, thread.line === undefined ? undefined : String(thread.line)]).join(":");
    const prefix = location.length > 0 ? `${location}: ` : "";
    const suffix = thread.actionable ? "" : " (unresolved inline review thread; needs human classification)";
    return `${prefix}${thread.body}${suffix}`;
  });
  const commentItems = actionableCommentSignals(state).map((signal) => {
    const source = signal.source === "review" ? "review summary" : "PR comment";
    return `Actionable ${source} from ${signal.author}: ${signal.body}`;
  });
  const failingChecks = state.checks.failing.map((check) => `CI failing: ${check.name}`);
  const pendingChecks = state.checks.pending.map((check) => `CI pending: ${check.name}`);
  const unknownChecks = state.checks.unknown.map((check) => `CI unknown: ${check.name}`);
  const absentChecks = state.checks.observed ? [] : ["CI unknown: no check records observed"];
  const blockers = state.blockers ?? [];

  return [...reviewItems, ...commentItems, ...failingChecks, ...pendingChecks, ...unknownChecks, ...absentChecks, ...blockers];
}

export function normalizePullRequestLifecycleState(value: unknown): PullRequestLifecycleState {
  const state = stringField(value).toUpperCase();
  if (state === "OPEN" || state === "CLOSED" || state === "MERGED") return state;
  return "UNKNOWN";
}

export function classifyPreflightDecision(
  state: PullRequestState,
  loopDecision: LoopDecision,
  options: { readonly commands_run?: readonly string[] } = {},
): PreflightDecision {
  const evidence = [
    `PR ${state.url}`,
    `headRefOid ${state.head_sha || "missing"}`,
    `lifecycle ${state.lifecycle_state}`,
    `checks ${state.checks.state} (${state.checks.observed_count} observed)`,
    `review decision ${state.review_decision}`,
    `actionable feedback ${actionableReviewThreads(state).length + actionableCommentSignals(state).length}`,
    `remaining items ${remainingItemsForState(state).length}`,
  ];
  const base = {
    evidence,
    commands_run: [...(options.commands_run ?? [])],
    loop_decision: loopDecision,
  };

  switch (loopDecision.kind) {
    case "clean":
      return {
        ...base,
        action: "done",
        confidence: "high",
        next_stage: "final_report",
        local_validation: "not_run_not_needed",
        stop_reason: "Observed PR state is clean; enough evidence was collected to finish without checkout or local validation.",
      };
    case "wait_for_ci":
      return {
        ...base,
        action: "wait_for_ci",
        confidence: "high",
        next_stage: "poll_ci",
        local_validation: "not_run_not_needed",
        stop_reason: "CI is pending; route to the bounded CI polling gate instead of inspecting locally.",
      };
    case "remediate":
      return {
        ...base,
        action: loopDecision.failing_checks.length > 0 ? "fix_failure" : "respond_to_review",
        confidence: "high",
        next_stage: "checkout_and_remediate",
        local_validation: "not_run_deferred_until_remediation",
        stop_reason: "Actionable CI/review work exists; stop preflight and let the remediation stage own checkout-local validation and fixes.",
      };
    case "exhausted":
      return {
        ...base,
        action: "ask_human",
        confidence: "high",
        next_stage: "human",
        local_validation: "not_run_not_needed",
        stop_reason: "The configured remediation budget is exhausted; route to human attention.",
      };
    case "needs_human":
      return {
        ...base,
        action: "ask_human",
        confidence: "high",
        next_stage: "human",
        local_validation: "not_run_not_needed",
        stop_reason: "A human-only blocker was found; enough evidence was collected to stop preflight.",
      };
  }
}

export function classifyPrReadiness(state: PullRequestState, history: IterationHistory): LoopDecision {
  const remaining = remainingItemsForState(state);
  const actionableFeedback = [...actionableReviewThreads(state), ...actionableCommentSignals(state)];
  const nonActionableLiveThreads = liveReviewThreads(state).filter((thread) => !thread.actionable);
  const failingCheckNames = state.checks.failing.map((check) => check.name);
  const pendingCheckNames = state.checks.pending.map((check) => check.name);

  if (state.lifecycle_state !== "OPEN") {
    const reason = state.lifecycle_state === "UNKNOWN"
      ? "The PR lifecycle state is unknown; only OPEN PRs may be babysat."
      : `The PR lifecycle state is ${state.lifecycle_state}; only OPEN PRs may be babysat.`;
    return { kind: "needs_human", reason, remaining };
  }

  if (state.head_repository.kind === "unknown") {
    return { kind: "needs_human", reason: `The PR head repository is unknown (${state.head_repository.reason}); refusing to guess a push target.`, remaining };
  }

  if (state.head_sha.trim().length === 0) {
    return { kind: "needs_human", reason: "GitHub did not report headRefOid for the PR head commit.", remaining };
  }

  if (state.push_accessible === false) {
    return { kind: "needs_human", reason: "No push access to the PR branch was confirmed.", remaining };
  }

  const mergeConflictNeedsRemediation = state.merge_conflict || state.mergeability?.kind === "conflicting" || state.mergeability?.kind === "dirty";

  if (state.non_fast_forward) {
    return { kind: "needs_human", reason: "The PR branch moved or rejected a fast-forward push.", remaining };
  }

  if (state.ambiguous_feedback) {
    return { kind: "needs_human", reason: "Review feedback is ambiguous and should not be remediated automatically.", remaining };
  }

  const requestedChangesWithLiveThreads = state.review_decision === "CHANGES_REQUESTED" && nonActionableLiveThreads.length > 0;
  if (nonActionableLiveThreads.length > 0 && !requestedChangesWithLiveThreads) {
    return { kind: "needs_human", reason: "Unresolved non-outdated inline review threads remain but were not safely classified as actionable.", remaining };
  }

  if (state.ci_timed_out) {
    return { kind: "needs_human", reason: "CI did not settle before the polling timeout.", remaining };
  }

  if ((history.consecutive_no_progress ?? 0) > 0 && remaining.length > 0) {
    return { kind: "needs_human", reason: "A remediation iteration made no progress while issues remain.", remaining };
  }

  if (history.iterations_completed >= history.max_iterations && remaining.length > 0) {
    return { kind: "exhausted", iterations_completed: history.iterations_completed, remaining };
  }

  if (state.checks.state === "pending") {
    return { kind: "wait_for_ci", pending: pendingCheckNames };
  }

  if (!state.checks.observed) {
    return { kind: "needs_human", reason: "No CI check records were observed, so the PR cannot be declared clean safely.", remaining };
  }

  if (state.checks.state === "unknown") {
    return { kind: "needs_human", reason: "One or more CI checks have unknown state.", remaining };
  }

  if (state.mergeability?.kind === "unknown") {
    return { kind: "needs_human", reason: "GitHub mergeability is unknown, so the PR cannot be declared clean safely.", remaining };
  }

  if (failingCheckNames.length > 0 || actionableFeedback.length > 0 || mergeConflictNeedsRemediation || requestedChangesWithLiveThreads) {
    return {
      kind: "remediate",
      feedback_count: actionableFeedback.length + (requestedChangesWithLiveThreads ? nonActionableLiveThreads.length : 0),
      failing_checks: failingCheckNames,
    };
  }

  if (state.review_decision === "CHANGES_REQUESTED") {
    return { kind: "needs_human", reason: "GitHub reports requested changes but no actionable thread was safely identified.", remaining };
  }

  if (state.review_decision === "REVIEW_REQUIRED") {
    return { kind: "needs_human", reason: "A human review is still required before the PR can be considered clean.", remaining };
  }

  if (state.mergeability?.kind === "blocked") {
    return { kind: "needs_human", reason: "GitHub reports mergeability is blocked.", remaining };
  }

  if (state.checks.observed && state.checks.state === "success") {
    return { kind: "clean", reason: "No actionable review feedback remains and all current checks are green." };
  }

  return { kind: "needs_human", reason: "The PR state could not be classified safely.", remaining };
}

export function parseGitStatusPorcelain(output: string): readonly GitStatusEntry[] {
  if (output.trim().length === 0) return [];
  const records = output.split("\0").filter(Boolean);
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    entries.push({ status, path });

    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (sourcePath) entries.push({ status, path: sourcePath });
      index += 1;
    }
  }

  return entries;
}

function receiptSearchRegion(content: string): string {
  const markerPattern = /(?:^|\n)\s*(?:final[-_\s]+)?remediation[-_\s]+receipt\s*:?\s*(?:\n|$)/gi;
  let lastMarkerEnd = -1;
  for (let match = markerPattern.exec(content); match !== null; match = markerPattern.exec(content)) {
    lastMarkerEnd = markerPattern.lastIndex;
  }
  return lastMarkerEnd >= 0 ? content.slice(lastMarkerEnd) : content;
}

function parseReceiptJsonObject(content: string): unknown | undefined {
  const searchRegion = receiptSearchRegion(content);
  const trimmed = searchRegion.trim();
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fencePattern.exec(searchRegion); match !== null; match = fencePattern.exec(searchRegion)) {
    candidates.push(match[1].trim());
  }
  candidates.push(trimmed);

  for (const candidate of candidates.reverse()) {
    if (!candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate, preferring the final marked/fenced receipt.
    }
  }

  return undefined;
}

export function normalizeRepoRelativePath(value: unknown): string | undefined {
  const raw = stringField(value);
  if (raw.length === 0 || raw.includes("\0") || raw.includes("\\")) return undefined;
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return undefined;
  const normalized = raw.split("/").filter((segment) => segment.length > 0).join("/");
  if (normalized.length === 0 || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  if (normalized !== raw.replace(/^\.\//, "")) return undefined;
  return normalized;
}

function parseReceiptChange(value: unknown, index: number): RemediationReceiptChange | string {
  const record = objectValue(value);
  if (!record) return `changed_files[${index}] is not an object`;
  const change = stringField(record.change).toLowerCase();

  if (["add", "modify", "delete"].includes(change)) {
    const path = normalizeRepoRelativePath(record.path);
    if (!path) return `changed_files[${index}].path is missing or unsafe`;
    return { change: change as "add" | "modify" | "delete", path };
  }

  if (["rename", "copy"].includes(change)) {
    const oldPath = normalizeRepoRelativePath(record.old_path);
    const newPath = normalizeRepoRelativePath(record.new_path);
    if (!oldPath || !newPath) return `changed_files[${index}] rename/copy paths are missing or unsafe`;
    if (oldPath === newPath) return `changed_files[${index}] rename/copy paths must differ`;
    return { change: change as "rename" | "copy", old_path: oldPath, new_path: newPath };
  }

  return `changed_files[${index}].change is not supported`;
}

function parseReceiptTest(value: unknown, index: number): RemediationReceiptTest | string {
  const record = objectValue(value);
  if (!record) return `tests_run[${index}] is not an object`;
  const command = stringField(record.command);
  const rawResult = stringField(record.result).toLowerCase();
  const exactResult = ["passed", "failed", "skipped"].includes(rawResult)
    ? rawResult as "passed" | "failed" | "skipped"
    : undefined;
  const embeddedNote = exactResult ? "" : rawResult.match(/^(passed|failed|skipped)\s*[:;,-]\s*(.+)$/i);
  const result = exactResult ?? (embeddedNote?.[1] as "passed" | "failed" | "skipped" | undefined);
  const noteParts = [stringField(record.note), embeddedNote?.[2] ? stringField(embeddedNote[2]) : ""].filter(Boolean);
  if (command.length === 0) return `tests_run[${index}].command is required`;
  if (!result) return `tests_run[${index}].result must be passed, failed, or skipped`;
  return { command, result, ...(noteParts.length > 0 ? { note: noteParts.join("; ") } : {}) };
}

function parseReceiptAddressedCommentSignalIds(value: unknown): readonly string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "addressed_comment_signal_ids must be an array when present";

  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") return `addressed_comment_signal_ids[${index}] must be a non-empty string`;
    const id = item.trim();
    if (id.length === 0) return `addressed_comment_signal_ids[${index}] must be a non-empty string`;
    ids.add(id);
  }

  return [...ids].sort();
}

export function parseRemediationReceiptContent(content: string): RemediationReceiptParseResult {
  const parsed = parseReceiptJsonObject(content);
  const record = objectValue(parsed);
  if (!record) return { ok: false, error: "Missing machine-checkable JSON remediation receipt." };

  if (!Array.isArray(record.changed_files) || !Array.isArray(record.tests_run) || !Array.isArray(record.residual_items)) {
    return { ok: false, error: "Remediation receipt must contain changed_files, tests_run, and residual_items arrays." };
  }

  const changedFiles: RemediationReceiptChange[] = [];
  for (const [index, value] of record.changed_files.entries()) {
    const change = parseReceiptChange(value, index);
    if (typeof change === "string") return { ok: false, error: change };
    changedFiles.push(change);
  }

  const testsRun: RemediationReceiptTest[] = [];
  for (const [index, value] of record.tests_run.entries()) {
    const test = parseReceiptTest(value, index);
    if (typeof test === "string") return { ok: false, error: test };
    testsRun.push(test);
  }

  const residualItems: string[] = [];
  for (const [index, value] of record.residual_items.entries()) {
    const item = stringField(value);
    if (item.length === 0) return { ok: false, error: `residual_items[${index}] must be a non-empty string` };
    residualItems.push(item);
  }

  const addressedCommentSignalIds = parseReceiptAddressedCommentSignalIds(record.addressed_comment_signal_ids);
  if (typeof addressedCommentSignalIds === "string") return { ok: false, error: addressedCommentSignalIds };

  return { ok: true, receipt: { changed_files: changedFiles, tests_run: testsRun, residual_items: residualItems, addressed_comment_signal_ids: addressedCommentSignalIds } };
}

export function remediationReceiptPaths(receipt: RemediationReceipt): readonly string[] {
  const paths = new Set<string>();
  for (const change of receipt.changed_files) {
    if ("path" in change) {
      paths.add(change.path);
    } else {
      paths.add(change.old_path);
      paths.add(change.new_path);
    }
  }
  return [...paths].sort();
}

export function validateRemediationReceiptOutcome(receipt: RemediationReceipt): RemediationReceiptOutcomeResult {
  const failedTests = receipt.tests_run
    .filter((test) => test.result === "failed")
    .map((test) => test.command);
  const residualItems = receipt.residual_items.map((item) => item.trim()).filter(Boolean);

  if (failedTests.length > 0 || residualItems.length > 0) {
    const reasons = [
      failedTests.length > 0 ? `failed validation reported by: ${failedTests.join(", ")}` : undefined,
      residualItems.length > 0 ? `residual work reported: ${residualItems.join("; ")}` : undefined,
    ].filter(Boolean).join("; ");
    return {
      ok: false,
      error: `Remediation receipt reported incomplete work (${reasons}).`,
      failed_tests: failedTests,
      residual_items: residualItems,
    };
  }

  return {
    ok: true,
    passed_tests: receipt.tests_run.filter((test) => test.result === "passed").map((test) => test.command),
    skipped_tests: receipt.tests_run.filter((test) => test.result === "skipped").map((test) => test.command),
  };
}

export function validateReceiptAddressedCommentSignalIds(
  state: Pick<PullRequestState, "comment_signals" | "addressed_comment_signal_ids">,
  receipt: Pick<RemediationReceipt, "addressed_comment_signal_ids">,
): ReceiptAddressedCommentSignalValidationResult {
  const receiptIds = receipt.addressed_comment_signal_ids ?? [];
  const alreadyAddressed = addressedCommentSignalIds(state);
  const actionableSignalIds = new Set(state.comment_signals.filter((signal) => signal.actionable).map((signal) => signal.id));
  const invalid: string[] = [];
  const already: string[] = [];

  for (const id of receiptIds) {
    if (!actionableSignalIds.has(id)) {
      invalid.push(id);
      continue;
    }
    if (alreadyAddressed.has(id)) already.push(id);
  }

  if (invalid.length > 0 || already.length > 0) {
    const reasons = [
      invalid.length > 0 ? `unknown or non-actionable current comment signal IDs: ${invalid.join(", ")}` : undefined,
      already.length > 0 ? `already-addressed comment signal IDs: ${already.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    return { ok: false, error: `Receipt addressed_comment_signal_ids are not valid for the current PR state (${reasons}).` };
  }

  return { ok: true, addressed_comment_signal_ids: [...receiptIds].sort() };
}

export function collectReceiptOwnedPaths(entries: readonly GitStatusEntry[], receipt: RemediationReceipt): RemediationOwnershipResult {
  const dirtyPaths = new Map<string, GitStatusEntry[]>();
  for (const entry of entries) {
    const path = normalizeRepoRelativePath(entry.path);
    if (!path) return { ok: false, error: `Git reported an unsafe dirty path: ${entry.path}` };
    const list = dirtyPaths.get(path) ?? [];
    list.push(entry);
    dirtyPaths.set(path, list);
  }

  const allowedReceiptPaths = new Set(remediationReceiptPaths(receipt));
  const stageableReceiptPaths = new Set<string>();
  const copySourcePaths = new Set<string>();
  const renameOrCopyPaths = new Set<string>();

  for (const change of receipt.changed_files) {
    if ("path" in change) {
      stageableReceiptPaths.add(change.path);
      continue;
    }

    if (change.change === "rename") {
      stageableReceiptPaths.add(change.old_path);
      stageableReceiptPaths.add(change.new_path);
      renameOrCopyPaths.add(change.old_path);
      renameOrCopyPaths.add(change.new_path);
      continue;
    }

    stageableReceiptPaths.add(change.new_path);
    copySourcePaths.add(change.old_path);
    renameOrCopyPaths.add(change.old_path);
    renameOrCopyPaths.add(change.new_path);
  }

  for (const path of dirtyPaths.keys()) {
    if (!allowedReceiptPaths.has(path)) return { ok: false, error: `Dirty path is absent from the remediation receipt: ${path}` };
  }

  for (const path of stageableReceiptPaths) {
    if (!dirtyPaths.has(path)) return { ok: false, error: `Receipt listed a path with no corresponding git diff: ${path}` };
  }

  for (const change of receipt.changed_files) {
    if (change.change === "rename") {
      const oldEntries = dirtyPaths.get(change.old_path) ?? [];
      const newEntries = dirtyPaths.get(change.new_path) ?? [];
      if (!oldEntries.some((entry) => /R/.test(entry.status)) || !newEntries.some((entry) => /R/.test(entry.status))) {
        return { ok: false, error: `Receipt rename does not match git rename status: ${change.old_path} -> ${change.new_path}` };
      }
    }

    if (change.change === "copy") {
      const sourceEntries = dirtyPaths.get(change.old_path) ?? [];
      const dirtySourceEntries = sourceEntries.filter((entry) => !/C/.test(entry.status));
      if (dirtySourceEntries.length > 0 && !stageableReceiptPaths.has(change.old_path)) {
        return { ok: false, error: `Receipt copy source has a separate dirty diff without its own receipt entry: ${change.old_path}` };
      }
    }
  }

  for (const [path, pathEntries] of dirtyPaths.entries()) {
    if (pathEntries.some((entry) => /[RC]/.test(entry.status)) && !renameOrCopyPaths.has(path)) {
      return { ok: false, error: `Git rename/copy path is not represented by a receipt rename/copy entry: ${path}` };
    }
    if (copySourcePaths.has(path) && !stageableReceiptPaths.has(path) && pathEntries.some((entry) => !/C/.test(entry.status))) {
      return { ok: false, error: `Copy source is dirty but is only listed as provenance: ${path}` };
    }
  }

  return { ok: true, paths: [...stageableReceiptPaths].sort() };
}

export function redactCommandOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@([^\s/@]+)/gi, "$1[REDACTED_CREDENTIALS]@$2")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_TOKEN]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_TOKEN]")
    .replace(/\b([A-Za-z0-9_.-]*(?:token|password|secret)[A-Za-z0-9_.-]*)\b\s*[:=]\s*(["']?)[^\s,"'{}]+\2/gi, (_match, key: string, quote: string) => `${key}=${quote}[REDACTED]${quote}`);
}
