import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { relative, resolve, sep, join } from "node:path";
import { promisify } from "node:util";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import {
  DEFAULT_BABYSIT_PR_BASE_BRANCH,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  type CheckRecord,
  type CheckSummary,
  type CommentSignal,
  type GitStatusEntry,
  type LoopDecision,
  type PreflightDecision,
  type PullRequestIdentity,
  type PullRequestState,
  type RemediationReceipt,
  type ReviewThread,
  actionableFeedbackText,
  aggregateChecks,
  mergeRequiredAndAllChecks,
  classifyPrReadiness,
  classifyPreflightDecision,
  collectReceiptOwnedPaths,
  normalizeBaseBranchInput,
  normalizeBoundedInteger,
  normalizeMergeability,
  normalizePullRequestLifecycleState,
  normalizeRequestedGitWorktreeDir,
  normalizeReviewThreadNodes,
  parseGitStatusPorcelain,
  parsePullRequestRef,
  parseRemediationReceiptContent,
  redactCommandOutput,
  validateReceiptAddressedCommentSignalIds,
  validateRemediationReceiptOutcome,
  remainingItemsForState,
  resolveHeadRepositoryIdentity,
} from "./helpers.js";
import { reportSummaryText, writeWorkflowReport } from "./report-output.js";
import {
  createWorkflowArtifactRun,
  displayPath,
  jsonArtifact,
  manifestArtifactPaths,
  markdownArtifact,
  writeJsonArtifact,
  writeMarkdownArtifact,
  writeWorkflowManifest,
} from "./workflow-artifacts.js";

const execFileAsync = promisify(execFile);
const WORKFLOW_NAME = "babysit-pr";
const WORKFLOW_ARTIFACT_ROOT_PREFIX = `.${WORKFLOW_NAME}-`;
const WORKFLOW_REPORT_ROOT = WORKFLOW_NAME;
const FILE_ONLY_OUTPUT = "file-only" as const;

type CommandReceipt = {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly rawStdout?: string;
};

type CommitReceipt = {
  readonly sha: string;
  readonly shortSha: string;
  readonly message: string;
  readonly parentSha: string;
};

type PushReceipt = {
  readonly target: string;
  readonly branch: string;
  readonly commit: string;
};

type WorkspaceStatusEntry = GitStatusEntry;

type IterationLedger = {
  readonly iteration: number;
  readonly decision: LoopDecision;
  readonly stateArtifact: string;
  readonly ciArtifact: string;
  readonly remediationArtifact?: string;
  readonly receiptArtifact?: string;
  readonly commit?: CommitReceipt;
  readonly push?: PushReceipt;
};

type BabysitLedger = {
  readonly input: Record<string, unknown>;
  readonly identity: PullRequestIdentity;
  readonly prUrl: string;
  readonly headRepository?: PullRequestState["head_repository"];
  readonly status: "clean" | "exhausted" | "needs_human";
  readonly iterations: readonly IterationLedger[];
  readonly commitsPushed: readonly string[];
  readonly remainingItems: readonly string[];
  readonly stages: readonly string[];
};

function text(value: unknown, fallback = ""): string {
  const result = String(value ?? fallback).trim();
  return result.length > 0 ? result : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntilDeadline(deadlineMs: number, pollIntervalSeconds: number): Promise<"slept" | "expired"> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return "expired";
  await sleep(Math.min(pollIntervalSeconds * 1_000, remainingMs));
  return "slept";
}

async function command(name: string, args: readonly string[], cwd: string, options: { readonly rawStdout?: boolean } = {}): Promise<CommandReceipt> {
  try {
    const result = await execFileAsync(name, [...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    return {
      command: redactCommandOutput(`${name} ${args.join(" ")}`),
      stdout: redactCommandOutput(stdout.trim()),
      stderr: redactCommandOutput(stderr.trim()),
      ...(options.rawStdout ? { rawStdout: stdout } : {}),
    };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown };
    const details = redactCommandOutput([
      String(err.message ?? `${name} failed`),
      String(err.stdout ?? ""),
      String(err.stderr ?? ""),
    ].filter(Boolean).join("\n"));
    throw new Error(`${redactCommandOutput(`${name} ${args.join(" ")}`)} failed: ${details}`);
  }
}

async function commandRaw(name: string, args: readonly string[], cwd: string): Promise<string> {
  return (await command(name, args, cwd, { rawStdout: true })).rawStdout ?? "";
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  return (await command("git", args, cwd)).stdout;
}

async function gitRaw(args: readonly string[], cwd: string): Promise<string> {
  return commandRaw("git", args, cwd);
}

async function gh(args: readonly string[], cwd: string): Promise<string> {
  return (await command("gh", args, cwd)).stdout;
}

async function ghRaw(args: readonly string[], cwd: string): Promise<string> {
  return commandRaw("gh", args, cwd);
}

async function ghJson<T>(args: readonly string[], cwd: string): Promise<T> {
  return JSON.parse(await ghRaw(args, cwd)) as T;
}

async function originUrl(cwd: string): Promise<string | undefined> {
  try {
    return await gitRaw(["remote", "get-url", "origin"], cwd);
  } catch {
    return undefined;
  }
}

async function ghAuthAvailable(cwd: string): Promise<boolean> {
  try {
    await command("gh", ["auth", "status", "--hostname", "github.com"], cwd);
    return true;
  } catch {
    return false;
  }
}

function loginOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "login" in value) {
    return String((value as { login?: unknown }).login ?? "unknown");
  }
  return "unknown";
}

function stableCommentSignalId(source: CommentSignal["source"], record: Record<string, unknown>, index: number): string {
  const stableId = text(record.id) || text(record.node_id) || text(record.databaseId) || text(record.url);
  return stableId.length > 0 ? `${source}-${stableId}` : `${source}-${index}`;
}

function topLevelCommentSignals(view: Record<string, unknown>): CommentSignal[] {
  const comments = Array.isArray(view.comments) ? view.comments : [];
  const latestReviews = Array.isArray(view.latestReviews) ? view.latestReviews : [];
  const signals: CommentSignal[] = [];

  for (const [index, comment] of comments.entries()) {
    if (typeof comment !== "object" || comment === null) continue;
    const record = comment as Record<string, unknown>;
    const body = text(record.body);
    if (body.length === 0) continue;
    const actionable = actionableFeedbackText(body);
    signals.push({
      id: stableCommentSignalId("comment", record, index),
      source: "comment",
      body,
      author: loginOf(record.author),
      actionable,
      reason: actionable ? undefined : "PR comment is supplemental and did not contain an obvious remediation request.",
    });
  }

  for (const [index, review] of latestReviews.entries()) {
    if (typeof review !== "object" || review === null) continue;
    const record = review as Record<string, unknown>;
    const state = text(record.state).toUpperCase();
    const body = text(record.body);
    if (body.length === 0) continue;
    const actionable = (state === "CHANGES_REQUESTED" || state === "COMMENTED") && actionableFeedbackText(body);
    signals.push({
      id: stableCommentSignalId("review", record, index),
      source: "review",
      body,
      author: loginOf(record.author),
      actionable,
      reason: actionable ? undefined : "Review summary is supplemental; inline lifecycle-backed threads determine remediation blockers.",
    });
  }

  return signals;
}

async function fetchReviewThreads(identity: PullRequestIdentity, cwd: string): Promise<ReviewThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              originalLine
              comments(first: 100) {
                nodes {
                  id
                  body
                  path
                  line
                  originalLine
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `;
  const threads: ReviewThread[] = [];
  let cursor = "";

  for (let page = 0; page < 20; page += 1) {
    const graphqlArgs = [
      "api",
      "graphql",
      "-f",
      `owner=${identity.owner}`,
      "-f",
      `repo=${identity.repo}`,
      "-F",
      `number=${identity.number}`,
      "-f",
      `query=${query}`,
    ];
    if (cursor.length > 0) graphqlArgs.splice(-2, 0, "-f", `cursor=${cursor}`);
    const response = await ghJson<Record<string, unknown>>(graphqlArgs, cwd);
    const repository = typeof response.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>).repository
      : undefined;
    const pullRequest = typeof repository === "object" && repository !== null
      ? (repository as Record<string, unknown>).pullRequest
      : undefined;
    const reviewThreads = typeof pullRequest === "object" && pullRequest !== null
      ? (pullRequest as Record<string, unknown>).reviewThreads
      : undefined;
    const pageInfo = typeof reviewThreads === "object" && reviewThreads !== null
      ? (reviewThreads as Record<string, unknown>).pageInfo
      : undefined;
    const nodes = typeof reviewThreads === "object" && reviewThreads !== null && Array.isArray((reviewThreads as Record<string, unknown>).nodes)
      ? (reviewThreads as { nodes: unknown[] }).nodes
      : [];

    threads.push(...normalizeReviewThreadNodes(nodes));

    const hasNextPage = typeof pageInfo === "object" && pageInfo !== null && Boolean((pageInfo as Record<string, unknown>).hasNextPage);
    const endCursor = typeof pageInfo === "object" && pageInfo !== null ? text((pageInfo as Record<string, unknown>).endCursor) : "";
    if (!hasNextPage || endCursor.length === 0) return threads;
    cursor = endCursor;
  }

  throw new Error("fetch_review_threads stopped after 20 pages to avoid unsafe pagination.");
}

function statusRollupChecks(view: Record<string, unknown>): CheckRecord[] {
  const rollup = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [];
  return rollup.map((entry, index) => {
    const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      name: text(record.name, `check-${index + 1}`),
      state: text(record.state),
      status: text(record.status),
      conclusion: text(record.conclusion),
      bucket: text(record.bucket),
      link: text(record.detailsUrl ?? record.link),
    } satisfies CheckRecord;
  });
}

const PR_CHECK_FIELDS = "name,state,bucket,link,startedAt,completedAt,workflow";

async function ghPrChecks(identity: PullRequestIdentity, cwd: string, options: { readonly required?: boolean } = {}): Promise<CheckSummary | undefined> {
  const args = [
    "pr",
    "checks",
    String(identity.number),
    "--repo",
    `${identity.owner}/${identity.repo}`,
    ...(options.required ? ["--required"] : []),
    "--json",
    PR_CHECK_FIELDS,
  ];

  try {
    const result = await execFileAsync("gh", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    const checks = JSON.parse(String(result.stdout ?? "")) as unknown;
    return aggregateChecks(Array.isArray(checks) ? checks as CheckRecord[] : []);
  } catch (error) {
    const stdout = String((error as { stdout?: unknown }).stdout ?? "").trim();
    if (stdout.length === 0) return undefined;
    try {
      const checks = JSON.parse(stdout) as unknown;
      return aggregateChecks(Array.isArray(checks) ? checks as CheckRecord[] : []);
    } catch {
      return undefined;
    }
  }
}

async function prChecks(identity: PullRequestIdentity, cwd: string): Promise<CheckSummary> {
  const requiredChecks = await ghPrChecks(identity, cwd, { required: true });
  const allChecks = await ghPrChecks(identity, cwd);
  return mergeRequiredAndAllChecks(requiredChecks, allChecks);
}

async function fetchPrState(identity: PullRequestIdentity, cwd: string): Promise<PullRequestState> {
  const view = await ghJson<Record<string, unknown>>([
    "pr",
    "view",
    String(identity.number),
    "--repo",
    `${identity.owner}/${identity.repo}`,
    "--json",
    "url,number,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,maintainerCanModify,reviewDecision,latestReviews,comments,statusCheckRollup,mergeable,mergeStateStatus",
  ], cwd);
  const checkedRuns = await prChecks(identity, cwd);
  const inlineReviewThreads = await fetchReviewThreads(identity, cwd);
  const checks = checkedRuns.observed ? checkedRuns : aggregateChecks(statusRollupChecks(view));
  const headRepository = resolveHeadRepositoryIdentity(view.headRepository, view.headRepositoryOwner, identity);
  const oid = text(view.headRefOid);
  const mergeability = normalizeMergeability(
    typeof view.mergeable === "string" || typeof view.mergeable === "boolean" || view.mergeable === null ? view.mergeable : undefined,
    typeof view.mergeStateStatus === "string" || view.mergeStateStatus === null ? view.mergeStateStatus : undefined,
  );

  return {
    identity,
    url: text(view.url, `https://github.com/${identity.owner}/${identity.repo}/pull/${identity.number}`),
    base_ref: text(view.baseRefName, DEFAULT_BABYSIT_PR_BASE_BRANCH),
    head_ref: text(view.headRefName),
    head_repo: headRepository.kind === "known" ? headRepository.full_name : "unknown/unknown",
    head_repository: headRepository,
    lifecycle_state: normalizePullRequestLifecycleState(view.state),
    maintainer_can_modify: Boolean(view.maintainerCanModify ?? true),
    review_decision: text(view.reviewDecision, "UNKNOWN") as PullRequestState["review_decision"],
    review_threads: inlineReviewThreads,
    comment_signals: topLevelCommentSignals(view),
    checks,
    head_sha: oid,
    mergeability,
    merge_conflict: mergeability.kind === "conflicting" || mergeability.kind === "dirty",
    blockers: mergeability.reason && mergeability.kind !== "clean" ? [mergeability.reason] : undefined,
  };
}

function withAddressedCommentSignals(state: PullRequestState, addressedIds: ReadonlySet<string>): PullRequestState {
  return {
    ...state,
    addressed_comment_signal_ids: [...addressedIds].sort(),
  };
}

function markReceiptCommentSignalsAddressed(signalIds: readonly string[], addressedIds: Set<string>): void {
  for (const id of signalIds) addressedIds.add(id);
}

async function waitForCiToSettle(
  identity: PullRequestIdentity,
  initial: PullRequestState,
  cwd: string,
  pollIntervalSeconds: number,
  pollTimeoutSeconds: number,
): Promise<PullRequestState> {
  const deadline = Date.now() + pollTimeoutSeconds * 1_000;
  let current = initial;

  while (current.lifecycle_state === "OPEN" && current.checks.state === "pending") {
    if ((await sleepUntilDeadline(deadline, pollIntervalSeconds)) === "expired" || Date.now() >= deadline) break;
    current = await fetchPrState(identity, cwd);
  }

  if (current.lifecycle_state !== "OPEN") return current;

  if (current.checks.state === "pending") {
    return { ...current, ci_timed_out: true };
  }

  return current;
}

async function checkoutPrBranch(identity: PullRequestIdentity, cwd: string): Promise<void> {
  await gh(["pr", "checkout", String(identity.number), "--repo", `${identity.owner}/${identity.repo}`], cwd);
}

function gitPath(value: string): string {
  return value.split(sep).join("/");
}

function relativeGitPath(cwd: string, targetPath: string): string {
  return gitPath(relative(resolve(cwd), resolve(targetPath))).replace(/^\.\//, "");
}

async function workspaceStatus(cwd: string): Promise<WorkspaceStatusEntry[]> {
  return [...parseGitStatusPorcelain(await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd))];
}

function isPathInside(candidate: string, owner: string): boolean {
  return candidate === owner || candidate.startsWith(`${owner}/`);
}

function isWorkflowArtifactPath(path: string): boolean {
  const [root = ""] = path.split("/", 1);
  return root.startsWith(WORKFLOW_ARTIFACT_ROOT_PREFIX) && root.length > WORKFLOW_ARTIFACT_ROOT_PREFIX.length;
}

function isWorkflowOwnedPath(path: string, ownedRoots: readonly string[]): boolean {
  return isWorkflowArtifactPath(path) || ownedRoots.some((root) => root.length > 0 && isPathInside(path, root));
}

function workflowOwnedRoots(cwd: string, artifactDir: string): readonly string[] {
  return [...new Set([relativeGitPath(cwd, artifactDir), WORKFLOW_REPORT_ROOT]
    .filter((root) => root.length > 0 && root !== ".."))];
}

async function nonWorkflowWorkspaceStatus(cwd: string, artifactDir: string): Promise<WorkspaceStatusEntry[]> {
  const ownedRoots = workflowOwnedRoots(cwd, artifactDir);
  return (await workspaceStatus(cwd)).filter((entry) => !isWorkflowOwnedPath(entry.path, ownedRoots));
}

async function guardCleanWorkspace(cwd: string, artifactDir: string): Promise<void> {
  const dirty = await nonWorkflowWorkspaceStatus(cwd, artifactDir);
  if (dirty.length > 0) {
    throw new Error(`Workspace has pre-existing changes outside workflow artifacts: ${dirty.map((entry) => entry.path).join(", ")}`);
  }
}

async function stashPreExistingWorkspaceChanges(cwd: string, artifactDir: string, message: string): Promise<readonly string[]> {
  const dirty = await nonWorkflowWorkspaceStatus(cwd, artifactDir);
  const paths = [...new Set(dirty.map((entry) => entry.path))].sort();
  if (paths.length === 0) return [];
  await git(["stash", "push", "--include-untracked", "-m", message, "--", ...paths], cwd);
  return paths;
}

async function validateReceiptOwnedWorkspace(cwd: string, artifactDir: string, receipt: RemediationReceipt): Promise<void> {
  const dirty = await nonWorkflowWorkspaceStatus(cwd, artifactDir);
  if (dirty.length === 0) return;
  const ownership = collectReceiptOwnedPaths(dirty, receipt);
  if (!ownership.ok) throw new Error(`validate_receipt_owned_workspace rejected dirty remediation changes: ${ownership.error}`);
}

async function parseRemediationReceipt(remediationPath: string): Promise<RemediationReceipt> {
  const parsed = parseRemediationReceiptContent(await readFile(remediationPath, "utf8"));
  if (!parsed.ok) {
    throw new Error(`parse_remediation_receipt rejected the remediation output: ${parsed.error}`);
  }
  return parsed.receipt;
}

async function verifyLocalHeadMatchesPrHead(cwd: string, state: PullRequestState, context: string): Promise<string> {
  if (!state.head_sha) {
    throw new Error(`${context} refused to continue because GitHub headRefOid is missing.`);
  }
  const currentHead = await git(["rev-parse", "HEAD"], cwd);
  if (currentHead !== state.head_sha) {
    throw new Error(`${context} refused to continue because local HEAD ${currentHead} does not match latest observed PR headRefOid ${state.head_sha}.`);
  }
  return currentHead;
}


async function syncAfterPush(
  identity: PullRequestIdentity,
  pushedCommitSha: string,
  cwd: string,
  pollIntervalSeconds: number,
  pollTimeoutSeconds: number,
): Promise<PullRequestState> {
  const deadline = Date.now() + pollTimeoutSeconds * 1_000;
  let observedPushedCommit = false;
  let current = await fetchPrState(identity, cwd);

  while (Date.now() < deadline) {
    if (current.lifecycle_state !== "OPEN") return current;

    if (current.head_sha === pushedCommitSha) {
      observedPushedCommit = true;
      if (current.checks.observed && current.checks.state !== "pending") return current;
    } else if (observedPushedCommit) {
      throw new Error(`sync_after_push observed the pushed commit ${pushedCommitSha}, but the PR head later moved to ${current.head_sha}.`);
    }

    if ((await sleepUntilDeadline(deadline, pollIntervalSeconds)) === "expired" || Date.now() >= deadline) break;
    current = await fetchPrState(identity, cwd);
  }

  if (current.head_sha !== pushedCommitSha) {
    throw new Error(`sync_after_push timed out before GitHub reported pushed commit ${pushedCommitSha} as the PR head.`);
  }

  return {
    ...current,
    ci_timed_out: true,
    blockers: current.checks.observed
      ? current.blockers
      : [...(current.blockers ?? []), "No CI check records appeared for the pushed commit before the polling timeout."],
  };
}

function markdownPrState(state: PullRequestState, decision: LoopDecision): string {
  return [
    `# PR state for ${state.url}`,
    "",
    `- Lifecycle state: ${state.lifecycle_state}`,
    `- Base: ${state.base_ref}`,
    `- Head: ${state.head_repository.kind === "known" ? state.head_repository.full_name : `unknown (${state.head_repository.reason})`}:${state.head_ref}`,
    `- Review decision: ${state.review_decision}`,
    `- Mergeability: ${state.mergeability?.kind ?? "unknown"}`,
    `- Checks: ${state.checks.state}`,
    `- Comment/review signals: ${state.comment_signals.length}`,
    `- Decision: ${decision.kind}`,
    "",
    "## Remaining items",
    ...remainingItemsForState(state).map((item) => `- ${item}`),
  ].join("\n");
}

function finalStatusFromDecision(decision: LoopDecision): BabysitLedger["status"] {
  switch (decision.kind) {
    case "clean":
      return "clean";
    case "exhausted":
      return "exhausted";
    default:
      return "needs_human";
  }
}

function preflightNeedsCheckout(decision: PreflightDecision): boolean {
  return decision.action === "fix_failure" || decision.action === "respond_to_review";
}

function preflightSummary(decision: PreflightDecision): string {
  return `preflight action=${decision.action}; next_stage=${decision.next_stage}; stop_reason=${decision.stop_reason}`;
}

function renderFinalReport(ledger: BabysitLedger): string {
  const lines = [
    `# babysit-pr report`,
    "",
    `Status: ${ledger.status}`,
    `PR: ${ledger.prUrl}`,
    `Head repository: ${ledger.headRepository?.kind === "known" ? ledger.headRepository.full_name : ledger.headRepository ? `unknown (${ledger.headRepository.reason})` : "not fetched"}`,
    `Iterations completed: ${ledger.iterations.length}`,
    "",
    "## Commits pushed",
    ...(ledger.commitsPushed.length > 0 ? ledger.commitsPushed.map((commit) => `- ${commit}`) : ["- None"]),
    "",
    "## Remaining human items",
    ...(ledger.remainingItems.length > 0 ? ledger.remainingItems.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Iteration ledger",
  ];

  for (const entry of ledger.iterations) {
    lines.push(
      "",
      `### Iteration ${entry.iteration}`,
      `- Decision: ${entry.decision.kind}`,
      `- State artifact: ${displayPath(entry.stateArtifact)}`,
      `- CI artifact: ${displayPath(entry.ciArtifact)}`,
    );
    if (entry.remediationArtifact) lines.push(`- Remediation artifact: ${displayPath(entry.remediationArtifact)}`);
    if (entry.receiptArtifact) lines.push(`- Remediation receipt: ${displayPath(entry.receiptArtifact)}`);
    if (entry.commit) lines.push(`- Commit: ${entry.commit.shortSha} (${entry.commit.message})`);
    if (entry.push) lines.push(`- Pushed: ${entry.push.commit} to ${entry.push.target}/${entry.push.branch}`);
  }

  lines.push(
    "",
    "## Trusted remediation posture",
    "- The remediation stage is trusted with shell access and may run tests, package scripts, git, and gh using local credentials.",
    "- The parent workflow observes trusted remediation output, records receipts, syncs PR state, and reports remaining work.",
  );

  return lines.join("\n");
}

export default workflow({
  name: WORKFLOW_NAME,
  description: "Shepherd a GitHub pull request through review feedback and CI until clean or human attention is needed.",
  inputs: {
    "pr": Type.String({ description: "PR URL, owner/repo#number, or bare PR number resolved from origin." }),
    "max_iterations": Type.Number({ default: DEFAULT_MAX_ITERATIONS, description: "Maximum remediation passes before exhausted." }),
    "base_branch": Type.String({ default: DEFAULT_BABYSIT_PR_BASE_BRANCH, description: "Default base for worktree creation and local diff context." }),
    "poll_interval": Type.Number({ default: DEFAULT_POLL_INTERVAL_SECONDS, description: "Seconds between CI polling attempts." }),
    "poll_timeout": Type.Number({ default: DEFAULT_POLL_TIMEOUT_SECONDS, description: "Maximum seconds to wait for pending checks or post-push sync; sleep intervals are capped to the remaining budget." }),
    "git_worktree_dir": Type.String({ default: "", description: "Optional reusable worktree root for the mutable PR checkout." }),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" },
  outputs: {
    "summary": Type.String({ description: "Short summary of the saved babysit-pr report." }),
    "status": Type.Union([
      Type.Literal("clean"),
      Type.Literal("exhausted"),
      Type.Literal("needs_human"),
    ], { description: "Final babysit-pr status." }),
    "pr_url": Type.String({ description: "Canonical GitHub PR URL." }),
    "iterations_completed": Type.Number({ description: "Number of loop iterations completed." }),
    "commits_pushed": Type.Array(Type.String(), { description: "Commit SHAs pushed to the PR branch by this run." }),
    "remaining_items": Type.Array(Type.String(), { description: "Items left for a human after workflow exit." }),
    "report_path": Type.String({ description: "Path to the saved final babysit-pr report." }),
    "filename_summary": Type.String({ description: "Short filename-safe topic summary used for the report." }),
    "artifact_dir": Type.String({ description: "Per-run artifact directory containing babysit-pr artifacts." }),
    "manifest_path": Type.String({ description: "Path to the workflow artifact manifest JSON." }),
    "stages": Type.Array(Type.String(), { description: "Stage names completed during the babysit-pr run." }),
  },
  run: async (ctx) => {
    const workflowCwd = ctx.cwd ?? process.cwd();
    const prInput = text(ctx.inputs.pr);
    const maxIterations = normalizeBoundedInteger(ctx.inputs.max_iterations, { min: 1, max: 50, fallback: DEFAULT_MAX_ITERATIONS });
    const baseBranch = normalizeBaseBranchInput(text(ctx.inputs.base_branch));
    const pollInterval = normalizeBoundedInteger(ctx.inputs.poll_interval, { min: 1, max: 300, fallback: DEFAULT_POLL_INTERVAL_SECONDS });
    const pollTimeout = normalizeBoundedInteger(ctx.inputs.poll_timeout, { min: 1, max: 7_200, fallback: DEFAULT_POLL_TIMEOUT_SECONDS });
    const gitWorktreeDir = normalizeRequestedGitWorktreeDir(text(ctx.inputs.git_worktree_dir));
    const parsed = parsePullRequestRef(prInput, { originUrl: await originUrl(workflowCwd) });
    if (!parsed.ok) throw new Error(`Invalid babysit-pr input (${parsed.error.code}): ${parsed.error.message}`);

    const startedAt = new Date();
    const { runId, artifactDir } = await createWorkflowArtifactRun(WORKFLOW_NAME, startedAt, workflowCwd);
    const artifactPathsByName = new Map<string, string>();
    const addArtifact = (name: string, path: string): string => {
      artifactPathsByName.set(name, path);
      return path;
    };
    const writeRegisteredJsonArtifact = async (name: string, path: string, value: unknown): Promise<string> => {
      await writeJsonArtifact(path, value);
      return addArtifact(name, path);
    };
    const writeRegisteredMarkdownArtifact = async (name: string, path: string, value: string): Promise<string> => {
      await writeMarkdownArtifact(path, value);
      return addArtifact(name, path);
    };
    const stages: string[] = [];
    const commitsPushed: string[] = [];
    const iterations: IterationLedger[] = [];
    let status: BabysitLedger["status"] = "needs_human";
    let remainingItems: readonly string[] = [];
    let prUrl = `https://github.com/${parsed.identity.owner}/${parsed.identity.repo}/pull/${parsed.identity.number}`;
    const recordedInput = { pr: prUrl, max_iterations: maxIterations, base_branch: baseBranch, poll_interval: pollInterval, poll_timeout: pollTimeout, git_worktree_dir: gitWorktreeDir };
    let lastHeadRepository: PullRequestState["head_repository"] | undefined;

    const intakePath = jsonArtifact(artifactDir, "00-pr-intake.json");
    await writeRegisteredJsonArtifact("pr-intake", intakePath, {
      input: recordedInput,
      identity: parsed.identity,
      startedAt: startedAt.toISOString(),
    });

    const preflightDecisionPath = jsonArtifact(artifactDir, "00-preflight-decision.json");
    const writePreflightDecision = async (name: string, path: string, decision: PreflightDecision): Promise<void> => {
      await writeRegisteredJsonArtifact(name, path, decision);
    };

    if (!(await ghAuthAvailable(workflowCwd))) {
      const authDecision: PreflightDecision = {
        action: "ask_human",
        confidence: "high",
        evidence: [`PR ${prUrl}`, "GitHub CLI authentication is unavailable."],
        next_stage: "human",
        commands_run: ["gh auth status --hostname github.com"],
        stop_reason: "GitHub CLI auth is required before observing PR state; stop preflight and ask a human to authenticate.",
        local_validation: "not_run_not_needed",
        loop_decision: { kind: "needs_human", reason: "GitHub CLI authentication is unavailable.", remaining: ["GitHub CLI authentication is unavailable."] },
      };
      await writePreflightDecision("preflight-decision", preflightDecisionPath, authDecision);
      await ctx.stage("babysit-pr-preflight").complete(preflightSummary(authDecision));
      stages.push("babysit-pr-preflight");
      const report = await writeWorkflowReport({
        workflowName: WORKFLOW_NAME,
        summary: "needs human github auth",
        cwd: workflowCwd,
        report: `# babysit-pr report\n\nStatus: needs_human\nPR: ${prUrl}\n\nGitHub CLI authentication is unavailable. Run \`gh auth status\` and authenticate before retrying.`,
      });
      const manifestPath = join(artifactDir, "manifest.json");
      await writeWorkflowManifest(manifestPath, {
        runId,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        input: recordedInput,
        finalStatus: "needs_human",
        pr: parsed.identity,
        commitsPushed: [],
        finalReportPath: displayPath(report.reportPath),
        artifacts: manifestArtifactPaths(artifactPathsByName, manifestPath),
      });
      return {
        summary: "needs human github auth",
        status: "needs_human",
        pr_url: prUrl,
        iterations_completed: 0,
        commits_pushed: [],
        remaining_items: ["GitHub CLI authentication is unavailable."],
        report_path: report.reportPath,
        filename_summary: report.filenameSummary,
        artifact_dir: displayPath(artifactDir),
        manifest_path: displayPath(manifestPath),
        stages,
      };
    }

    let shouldCheckoutAndRemediate = false;
    try {
      const preflightStateJsonPath = jsonArtifact(artifactDir, "00-preflight-pr-state.json");
      const preflightStateMarkdownPath = markdownArtifact(artifactDir, "00-preflight-pr-state.md");
      const preflightCiPath = jsonArtifact(artifactDir, "00-preflight-ci-state.json");
      let preflightState = withAddressedCommentSignals(await fetchPrState(parsed.identity, workflowCwd), new Set<string>());
      prUrl = preflightState.url;
      lastHeadRepository = preflightState.head_repository;
      let preflightLoopDecision = classifyPrReadiness(preflightState, {
        iterations_completed: 0,
        max_iterations: maxIterations,
        consecutive_no_progress: 0,
      });
      let preflightDecision = classifyPreflightDecision(preflightState, preflightLoopDecision, {
        commands_run: [
          "gh auth status --hostname github.com",
          "gh pr view --json url,number,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,maintainerCanModify,reviewDecision,latestReviews,comments,statusCheckRollup,mergeable,mergeStateStatus",
          "gh pr checks --required --json name,state,bucket,link,startedAt,completedAt,workflow",
          "gh pr checks --json name,state,bucket,link,startedAt,completedAt,workflow",
          "gh api graphql reviewThreads",
        ],
      });
      await writeRegisteredJsonArtifact("preflight-pr-state-json", preflightStateJsonPath, preflightState);
      await writeRegisteredJsonArtifact("preflight-ci-state", preflightCiPath, preflightState.checks);
      await writePreflightDecision("preflight-decision", preflightDecisionPath, preflightDecision);
      await writeRegisteredMarkdownArtifact("preflight-pr-state", preflightStateMarkdownPath, markdownPrState(preflightState, preflightLoopDecision));
      await ctx.stage("babysit-pr-preflight").complete(preflightSummary(preflightDecision));
      stages.push("babysit-pr-preflight");

      if (preflightDecision.action === "wait_for_ci") {
        const postCiStateJsonPath = jsonArtifact(artifactDir, "00-preflight-post-ci-pr-state.json");
        const postCiStateMarkdownPath = markdownArtifact(artifactDir, "00-preflight-post-ci-pr-state.md");
        const postCiDecisionPath = jsonArtifact(artifactDir, "00-preflight-post-ci-decision.json");
        preflightState = withAddressedCommentSignals(await waitForCiToSettle(parsed.identity, preflightState, workflowCwd, pollInterval, pollTimeout), new Set<string>());
        prUrl = preflightState.url;
        lastHeadRepository = preflightState.head_repository;
        preflightLoopDecision = classifyPrReadiness(preflightState, {
          iterations_completed: 0,
          max_iterations: maxIterations,
          consecutive_no_progress: 0,
        });
        preflightDecision = classifyPreflightDecision(preflightState, preflightLoopDecision, {
          commands_run: ["bounded CI poll via gh pr view/checks until checks settle or poll_timeout expires"],
        });
        await writeRegisteredJsonArtifact("preflight-post-ci-pr-state-json", postCiStateJsonPath, preflightState);
        await writePreflightDecision("preflight-post-ci-decision", postCiDecisionPath, preflightDecision);
        await writeRegisteredMarkdownArtifact("preflight-post-ci-pr-state", postCiStateMarkdownPath, markdownPrState(preflightState, preflightLoopDecision));
        await ctx.stage("babysit-pr-ci-poll").complete(preflightSummary(preflightDecision));
        stages.push("babysit-pr-ci-poll");
      }

      if (preflightNeedsCheckout(preflightDecision)) {
        shouldCheckoutAndRemediate = true;
      } else {
        status = finalStatusFromDecision(preflightLoopDecision);
        remainingItems = "remaining" in preflightLoopDecision ? preflightLoopDecision.remaining : remainingItemsForState(preflightState);
      }
    } catch (error) {
      const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
      const syncDecision: PreflightDecision = {
        action: "ask_human",
        confidence: "high",
        evidence: [`PR ${prUrl}`, `GitHub/CLI preflight sync failed: ${message}`],
        next_stage: "human",
        commands_run: ["gh pr view/checks/reviewThreads"],
        stop_reason: "Preflight could not fetch the required PR state; stop instead of falling back to local inspection.",
        local_validation: "not_run_not_needed",
        loop_decision: { kind: "needs_human", reason: "Preflight PR state sync failed.", remaining: [`GitHub/CLI preflight sync failed: ${message}`] },
      };
      await writePreflightDecision("preflight-decision", preflightDecisionPath, syncDecision);
      await ctx.stage("babysit-pr-preflight").complete(preflightSummary(syncDecision));
      stages.push("babysit-pr-preflight");
      status = "needs_human";
      remainingItems = syncDecision.loop_decision.remaining;
    }

    if (shouldCheckoutAndRemediate) {
      try {
        const stashedPaths = await stashPreExistingWorkspaceChanges(workflowCwd, artifactDir, `babysit-pr pre-checkout safety stash for ${prUrl}`);
        stages.push(stashedPaths.length > 0 ? "pre-checkout-stash-dirty-workspace" : "pre-checkout-guard-clean-workspace");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stages.push("pre-checkout-stash-dirty-workspace-failed");
        const report = await writeWorkflowReport({
          workflowName: WORKFLOW_NAME,
          summary: "needs human pre-checkout dirty workspace stash failed",
          cwd: workflowCwd,
          report: `# babysit-pr report\n\nStatus: needs_human\nPR: ${prUrl}\n\nUnable to safely stash pre-existing workspace changes before checking out the PR branch.\n\n\`\`\`text\n${message}\n\`\`\``,
        });
        const manifestPath = join(artifactDir, "manifest.json");
        await writeWorkflowManifest(manifestPath, {
          runId,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          input: recordedInput,
          finalStatus: "needs_human",
          pr: parsed.identity,
          commitsPushed: [],
          finalReportPath: displayPath(report.reportPath),
          artifacts: manifestArtifactPaths(artifactPathsByName, manifestPath),
        });
        return {
          summary: "needs human pre-checkout dirty workspace stash failed",
          status: "needs_human",
          pr_url: prUrl,
          iterations_completed: 0,
          commits_pushed: [],
          remaining_items: [message],
          report_path: report.reportPath,
          filename_summary: report.filenameSummary,
          artifact_dir: displayPath(artifactDir),
          manifest_path: displayPath(manifestPath),
          stages,
        };
      }

      try {
        await checkoutPrBranch(parsed.identity, workflowCwd);
        stages.push("checkout-pr-branch");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const report = await writeWorkflowReport({
          workflowName: WORKFLOW_NAME,
          summary: "needs human checkout pr branch",
          cwd: workflowCwd,
          report: `# babysit-pr report\n\nStatus: needs_human\nPR: ${prUrl}\n\nUnable to checkout the PR branch safely.\n\n\`\`\`text\n${message}\n\`\`\``,
        });
        const manifestPath = join(artifactDir, "manifest.json");
        await writeWorkflowManifest(manifestPath, {
          runId,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          input: recordedInput,
          finalStatus: "needs_human",
          pr: parsed.identity,
          commitsPushed: [],
          finalReportPath: displayPath(report.reportPath),
          artifacts: manifestArtifactPaths(artifactPathsByName, manifestPath),
        });
        return {
          summary: "needs human checkout pr branch",
          status: "needs_human",
          pr_url: prUrl,
          iterations_completed: 0,
          commits_pushed: [],
          remaining_items: [`Unable to checkout PR branch: ${message}`],
          report_path: report.reportPath,
          filename_summary: report.filenameSummary,
          artifact_dir: displayPath(artifactDir),
          manifest_path: displayPath(manifestPath),
          stages,
        };
      }

      try {
        const checkoutState = await fetchPrState(parsed.identity, workflowCwd);
        prUrl = checkoutState.url;
        lastHeadRepository = checkoutState.head_repository;
        await verifyLocalHeadMatchesPrHead(workflowCwd, checkoutState, "verifyLocalHeadMatchesPrHead after PR checkout");
        stages.push("verify-local-head-pr-head-after-checkout");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const report = await writeWorkflowReport({
          workflowName: WORKFLOW_NAME,
          summary: "needs human checkout head mismatch",
          cwd: workflowCwd,
          report: `# babysit-pr report\n\nStatus: needs_human\nPR: ${prUrl}\n\nThe PR checkout did not match the latest GitHub headRefOid, so remediation was not started.\n\n\`\`\`text\n${message}\n\`\`\``,
        });
        const manifestPath = join(artifactDir, "manifest.json");
        await writeWorkflowManifest(manifestPath, {
          runId,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          input: recordedInput,
          finalStatus: "needs_human",
          pr: parsed.identity,
          commitsPushed: [],
          finalReportPath: displayPath(report.reportPath),
          artifacts: manifestArtifactPaths(artifactPathsByName, manifestPath),
        });
        return {
          summary: "needs human checkout head mismatch",
          status: "needs_human",
          pr_url: prUrl,
          iterations_completed: 0,
          commits_pushed: [],
          remaining_items: [`PR checkout/headRefOid mismatch: ${message}`],
          report_path: report.reportPath,
          filename_summary: report.filenameSummary,
          artifact_dir: displayPath(artifactDir),
          manifest_path: displayPath(manifestPath),
          stages,
        };
      }

      let consecutiveNoProgress = 0;
    const addressedCommentSignalIds = new Set<string>();
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const iterationDir = join(artifactDir, `iteration-${String(iteration).padStart(2, "0")}`);
      await mkdir(iterationDir, { recursive: true });
      const stateJsonPath = jsonArtifact(iterationDir, "pr-state.json");
      const stateMarkdownPath = markdownArtifact(iterationDir, "pr-state.md");
      const ciJsonPath = jsonArtifact(iterationDir, "ci-state.json");
      const decisionJsonPath = jsonArtifact(iterationDir, "decision.json");

      let prState: PullRequestState;
      let decision: LoopDecision;
      try {
        prState = withAddressedCommentSignals(await fetchPrState(parsed.identity, workflowCwd), addressedCommentSignalIds);
        if (prState.lifecycle_state === "OPEN") {
          prState = withAddressedCommentSignals(await waitForCiToSettle(parsed.identity, prState, workflowCwd, pollInterval, pollTimeout), addressedCommentSignalIds);
        }
        prUrl = prState.url;
        lastHeadRepository = prState.head_repository;
        decision = classifyPrReadiness(prState, {
          iterations_completed: iteration - 1,
          max_iterations: maxIterations,
          consecutive_no_progress: consecutiveNoProgress,
        });
        await writeRegisteredJsonArtifact(`iteration-${iteration}-pr-state-json`, stateJsonPath, prState);
        await writeRegisteredJsonArtifact(`iteration-${iteration}-ci-state`, ciJsonPath, prState.checks);
        await writeRegisteredJsonArtifact(`iteration-${iteration}-decision`, decisionJsonPath, decision);
        await writeRegisteredMarkdownArtifact(`iteration-${iteration}-pr-state`, stateMarkdownPath, markdownPrState(prState, decision));
        stages.push(`sync-pr-state-${iteration}`);
      } catch (error) {
        const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
        decision = {
          kind: "needs_human",
          reason: "Per-iteration PR state or CI sync failed.",
          remaining: [`GitHub/CLI sync failed during iteration ${iteration}: ${message}`],
        };
        await writeRegisteredJsonArtifact(`iteration-${iteration}-pr-state-json`, stateJsonPath, { error: message, phase: "fetchPrState/waitForCiToSettle" });
        await writeRegisteredJsonArtifact(`iteration-${iteration}-ci-state`, ciJsonPath, { error: message, phase: "fetchPrState/waitForCiToSettle" });
        await writeRegisteredJsonArtifact(`iteration-${iteration}-decision`, decisionJsonPath, decision);
        await writeRegisteredMarkdownArtifact(`iteration-${iteration}-pr-state`, stateMarkdownPath, [
          `# PR state sync failed for ${prUrl}`,
          "",
          `Iteration: ${iteration}`,
          "",
          "```text",
          message,
          "```",
        ].join("\n"));
        stages.push(`sync-pr-state-failed-${iteration}`);
        iterations.push({ iteration, decision, stateArtifact: stateMarkdownPath, ciArtifact: ciJsonPath });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      const ledgerEntry: IterationLedger = {
        iteration,
        decision,
        stateArtifact: stateMarkdownPath,
        ciArtifact: ciJsonPath,
      };

      if (decision.kind !== "remediate") {
        iterations.push(ledgerEntry);
        status = finalStatusFromDecision(decision);
        remainingItems = "remaining" in decision ? decision.remaining : remainingItemsForState(prState);
        break;
      }

      try {
        await guardCleanWorkspace(workflowCwd, artifactDir);
        stages.push(`guard-clean-workspace-${iteration}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = {
          kind: "needs_human",
          reason: "Workspace has pre-existing changes outside workflow-owned artifacts.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      const remediationPath = markdownArtifact(iterationDir, "remediation.md");
      const remediationReceiptPath = jsonArtifact(iterationDir, "remediation-receipt.json");
      let remediationArtifact: string | undefined;
      let receiptArtifact: string | undefined;
      let parentHeadBeforeRemediation: string;
      try {
        parentHeadBeforeRemediation = await verifyLocalHeadMatchesPrHead(workflowCwd, prState, "verifyLocalHeadMatchesPrHead before trusted remediation");
        stages.push(`verify-local-head-pr-head-before-remediation-${iteration}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = {
          kind: "needs_human",
          reason: "Local checkout did not match the observed PR head before trusted remediation.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      try {
        const remediation = await ctx.task(`remediate-pr-iteration-${iteration}`, {
          reads: [stateJsonPath, ciJsonPath, stateMarkdownPath],
          prompt: `Apply one trusted remediation pass for this GitHub PR.

Read the artifacts:
- PR state: ${displayPath(stateJsonPath)}
- PR state summary: ${displayPath(stateMarkdownPath)}
- CI state: ${displayPath(ciJsonPath)}

Address actionable review feedback, requested-change review threads, merge conflicts, and failing CI for the current OPEN PR state. Use senior-engineer judgment: research the codebase against each PR comment, apply changes that are relevant and important to resolve, and prefer small idiomatic fixes over superficial appeasement. This remediation stage is trusted and has shell access similar to running Claude Code with --dangerously-skip-permissions: you may run local commands, tests, typechecks, builds, package scripts, git, and gh using the credentials available in this checkout. You may edit files, resolve merge conflicts, create commits, push to the PR branch, update PR title/body or other PR metadata, and reply to or resolve review threads when that is the appropriate way to address the feedback. Do not merge or close the PR; avoid force-pushes unless the repository's normal workflow explicitly requires them and you can explain why. If feedback is ambiguous, unsafe, or unfixable, leave the repository in a clean state and explain why. End with a final marker line \`FINAL_REMEDIATION_RECEIPT:\` followed by a machine-checkable remediation receipt as raw JSON or a fenced json block with this schema: {"changed_files":[{"path":"src/foo.ts","change":"modify"}],"tests_run":[{"command":"bun test","result":"passed"}],"residual_items":[],"addressed_comment_signal_ids":["comment-... or review-..."]}. Rename/copy entries must use old_path and new_path. The optional addressed_comment_signal_ids array is only for top-level PR comment or review-summary comment_signal IDs from the PR state that you actually addressed in this pass; do not include inline review thread IDs, unknown IDs, non-actionable IDs, or previously addressed IDs. Omit addressed_comment_signal_ids or use [] when no top-level comment/review-summary signal was addressed.`,
          output: remediationPath,
          outputMode: FILE_ONLY_OUTPUT,
          tools: ["read", "edit", "write", "bash"],
        });
        await access(remediationPath);
        remediationArtifact = addArtifact(`iteration-${iteration}-remediation`, remediationPath);
        stages.push(remediation.stageName);
      } catch (error) {
        const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
        decision = {
          kind: "needs_human",
          reason: "Trusted remediation failed before the receipt gate.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      let parentHeadAfterRemediation: string;
      try {
        parentHeadAfterRemediation = await git(["rev-parse", "HEAD"], workflowCwd);
        stages.push(`observe-trusted-remediation-head-${iteration}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = {
          kind: "needs_human",
          reason: "Unable to observe repository HEAD after trusted remediation.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      let remediationReceipt: RemediationReceipt;
      let validatedAddressedCommentSignalIds: readonly string[] = [];
      try {
        remediationReceipt = await parseRemediationReceipt(remediationPath);
        receiptArtifact = await writeRegisteredJsonArtifact(`iteration-${iteration}-remediation-receipt`, remediationReceiptPath, remediationReceipt);
        stages.push(`parse-remediation-receipt-${iteration}`);
        const receiptOutcome = validateRemediationReceiptOutcome(remediationReceipt);
        if (!receiptOutcome.ok) {
          throw new Error(`validate_remediation_receipt_outcome rejected the remediation output: ${receiptOutcome.error}`);
        }
        stages.push(`validate-remediation-receipt-outcome-${iteration}`);
        const addressedValidation = validateReceiptAddressedCommentSignalIds(prState, remediationReceipt);
        if (!addressedValidation.ok) {
          throw new Error(`validate_receipt_addressed_comment_signal_ids rejected the remediation output: ${addressedValidation.error}`);
        }
        validatedAddressedCommentSignalIds = addressedValidation.addressed_comment_signal_ids;
        stages.push(`validate-receipt-addressed-comment-signal-ids-${iteration}`);
        await validateReceiptOwnedWorkspace(workflowCwd, artifactDir, remediationReceipt);
        stages.push(`trusted-remediation-left-clean-or-receipt-owned-workspace-${iteration}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const receiptBlockedState = {
          ...prState,
          blockers: [...(prState.blockers ?? []), message],
        } satisfies PullRequestState;
        decision = { kind: "needs_human", reason: "Trusted remediation receipt validation or clean-workspace check failed.", remaining: remainingItemsForState(receiptBlockedState) };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, receiptArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      markReceiptCommentSignalsAddressed(validatedAddressedCommentSignalIds, addressedCommentSignalIds);

      const trustedHeadChanged = parentHeadAfterRemediation !== parentHeadBeforeRemediation;
      const trustedCommit: CommitReceipt | undefined = trustedHeadChanged
        ? {
          sha: parentHeadAfterRemediation,
          shortSha: parentHeadAfterRemediation.slice(0, 12),
          message: "trusted remediation commit(s)",
          parentSha: parentHeadBeforeRemediation,
        }
        : undefined;
      let trustedPush: PushReceipt | undefined;

      const postPushStateJsonPath = jsonArtifact(iterationDir, "post-push-pr-state.json");
      const postPushStateMarkdownPath = markdownArtifact(iterationDir, "post-push-pr-state.md");
      let postPushState: PullRequestState;
      let postPushDecision: LoopDecision;
      try {
        if (trustedHeadChanged) {
          postPushState = withAddressedCommentSignals(await syncAfterPush(parsed.identity, parentHeadAfterRemediation, workflowCwd, pollInterval, pollTimeout), addressedCommentSignalIds);
          trustedPush = {
            target: "trusted remediator",
            branch: postPushState.head_ref || prState.head_ref || "unknown",
            commit: parentHeadAfterRemediation,
          };
          commitsPushed.push(parentHeadAfterRemediation);
          stages.push(`sync-after-trusted-remediation-push-${iteration}`);
        } else {
          postPushState = withAddressedCommentSignals(await fetchPrState(parsed.identity, workflowCwd), addressedCommentSignalIds);
          if (postPushState.lifecycle_state === "OPEN") {
            postPushState = withAddressedCommentSignals(await waitForCiToSettle(parsed.identity, postPushState, workflowCwd, pollInterval, pollTimeout), addressedCommentSignalIds);
          }
          stages.push(`sync-after-trusted-remediation-${iteration}`);
        }
        prUrl = postPushState.url;
        lastHeadRepository = postPushState.head_repository;
        postPushDecision = classifyPrReadiness(postPushState, {
          iterations_completed: iteration,
          max_iterations: maxIterations,
        });
        await writeRegisteredJsonArtifact(`iteration-${iteration}-post-push-pr-state-json`, postPushStateJsonPath, postPushState);
        await writeRegisteredMarkdownArtifact(`iteration-${iteration}-post-push-pr-state`, postPushStateMarkdownPath, markdownPrState(postPushState, postPushDecision));
      } catch (error) {
        const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
        postPushDecision = {
          kind: "needs_human",
          reason: "Post-remediation sync failed after trusted remediation completed.",
          remaining: [`Trusted remediation completed at local HEAD ${parentHeadAfterRemediation}, but post-remediation sync failed: ${message}`],
        };
        await writeRegisteredJsonArtifact(`iteration-${iteration}-post-push-pr-state-json`, postPushStateJsonPath, { error: message, trustedRemediationHead: parentHeadAfterRemediation });
        await writeRegisteredMarkdownArtifact(`iteration-${iteration}-post-push-pr-state`, postPushStateMarkdownPath, [
          `# Post-remediation sync failed for ${prUrl}`,
          "",
          `Trusted remediation HEAD: ${parentHeadAfterRemediation}`,
          "",
          "```text",
          message,
          "```",
        ].join("\n"));
        stages.push(`sync-after-trusted-remediation-failed-${iteration}`);
        iterations.push({ ...ledgerEntry, decision: postPushDecision, remediationArtifact, receiptArtifact, commit: trustedCommit, push: trustedPush });
        status = "needs_human";
        remainingItems = postPushDecision.remaining;
        break;
      }

      iterations.push({ ...ledgerEntry, decision: postPushDecision, remediationArtifact, receiptArtifact, commit: trustedCommit, push: trustedPush });
      remainingItems = "remaining" in postPushDecision ? postPushDecision.remaining : remainingItemsForState(postPushState);
      consecutiveNoProgress = trustedHeadChanged || validatedAddressedCommentSignalIds.length > 0 ? 0 : consecutiveNoProgress + 1;

      if (postPushDecision.kind !== "remediate") {
        status = finalStatusFromDecision(postPushDecision);
        break;
      }

      if (iteration === maxIterations) {
        status = postPushDecision.kind === "exhausted" ? "exhausted" : "needs_human";
        break;
      }
    }
    }

    const ledger: BabysitLedger = {
      input: recordedInput,
      identity: parsed.identity,
      prUrl,
      headRepository: lastHeadRepository,
      status,
      iterations,
      commitsPushed,
      remainingItems,
      stages,
    };
    const finalReport = renderFinalReport(ledger);
    const summary = reportSummaryText(`${status} ${parsed.identity.owner} ${parsed.identity.repo} pr ${parsed.identity.number}`, "babysit pr report");
    const savedReport = await writeWorkflowReport({ workflowName: WORKFLOW_NAME, summary, report: finalReport, cwd: workflowCwd });
    const manifestPath = join(artifactDir, "manifest.json");
    await writeWorkflowManifest(manifestPath, {
      runId,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      input: ledger.input,
      finalStatus: status,
      pr: { ...parsed.identity, url: prUrl, head_repository: lastHeadRepository },
      commitsPushed,
      finalReportPath: displayPath(savedReport.reportPath),
      artifacts: manifestArtifactPaths(artifactPathsByName, manifestPath),
    });

    return {
      summary,
      status,
      pr_url: prUrl,
      iterations_completed: iterations.length,
      commits_pushed: commitsPushed,
      remaining_items: remainingItems,
      report_path: savedReport.reportPath,
      filename_summary: savedReport.filenameSummary,
      artifact_dir: displayPath(artifactDir),
      manifest_path: displayPath(manifestPath),
      stages,
    };
  },
});
