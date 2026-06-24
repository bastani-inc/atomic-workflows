import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  type PullRequestIdentity,
  type PullRequestState,
  type RemediationReceipt,
  type ReviewThread,
  actionableFeedbackText,
  aggregateChecks,
  mergeRequiredAndAllChecks,
  classifyPrReadiness,
  collectReceiptOwnedPaths,
  normalizeBaseBranchInput,
  normalizeBoundedInteger,
  normalizeMergeability,
  normalizePullRequestLifecycleState,
  normalizeRequestedGitWorktreeDir,
  normalizeReviewThreadNodes,
  parseGitHubRemoteUrl,
  parseGitStatusPorcelain,
  parsePullRequestRef,
  parseRemediationReceiptContent,
  redactCommandOutput,
  validateReceiptAddressedCommentSignalIds,
  validateRemediationReceiptOutcome,
  remediationReceiptPaths,
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

type PushTarget =
  | {
    readonly kind: "remote";
    readonly branch: string;
    readonly repo: string;
    readonly remoteName: string;
    readonly validatedPushUrls: readonly string[];
    readonly redactedPushUrls: readonly string[];
    readonly source: string;
  }
  | {
    readonly kind: "direct_url";
    readonly branch: string;
    readonly repo: string;
    readonly validatedPushUrl: string;
    readonly redactedPushUrl: string;
    readonly source: string;
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
  readonly ownedPathsArtifact?: string;
  readonly pushTargetArtifact?: string;
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

async function disabledHooksPath(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atomic-babysit-pr-disabled-hooks-"));
}

async function gitWithLocalAutomationDisabled(args: readonly string[], cwd: string): Promise<string> {
  const hooksPath = await disabledHooksPath();
  try {
    return await git(["-c", `core.hooksPath=${hooksPath}`, "-c", "commit.gpgSign=false", ...args], cwd);
  } finally {
    await rm(hooksPath, { recursive: true, force: true });
  }
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

async function guardCleanWorkspace(cwd: string, artifactDir: string): Promise<void> {
  const ownedRoots = workflowOwnedRoots(cwd, artifactDir);
  const dirty = (await workspaceStatus(cwd)).filter((entry) => !isWorkflowOwnedPath(entry.path, ownedRoots));
  if (dirty.length > 0) {
    throw new Error(`Workspace has pre-existing changes outside workflow artifacts: ${dirty.map((entry) => entry.path).join(", ")}`);
  }
}

async function parseRemediationReceipt(remediationPath: string): Promise<RemediationReceipt> {
  const parsed = parseRemediationReceiptContent(await readFile(remediationPath, "utf8"));
  if (!parsed.ok) {
    throw new Error(`parse_remediation_receipt rejected the remediation output: ${parsed.error}`);
  }
  return parsed.receipt;
}

async function collectOwnedRemediationPaths(cwd: string, artifactDir: string, receipt: RemediationReceipt): Promise<readonly string[]> {
  const ownedRoots = workflowOwnedRoots(cwd, artifactDir);
  const receiptArtifactPaths = remediationReceiptPaths(receipt).filter((path) => isWorkflowOwnedPath(path, ownedRoots));
  if (receiptArtifactPaths.length > 0) {
    throw new Error(`collect_owned_remediation_paths refused receipt paths under workflow artifacts/reports: ${receiptArtifactPaths.join(", ")}`);
  }

  for (const change of receipt.changed_files) {
    if (change.change !== "copy") continue;
    try {
      await access(resolve(cwd, change.old_path));
    } catch {
      throw new Error(`collect_owned_remediation_paths refused copy receipt because old_path does not exist: ${change.old_path}`);
    }
  }

  const entries = (await workspaceStatus(cwd)).filter((entry) => !isWorkflowOwnedPath(entry.path, ownedRoots));
  const collected = collectReceiptOwnedPaths(entries, receipt);
  if (!collected.ok) {
    throw new Error(`collect_owned_remediation_paths rejected the remediation diff: ${collected.error}`);
  }
  return collected.paths;
}

async function stagedPaths(cwd: string): Promise<readonly string[]> {
  return (await gitRaw(["diff", "--cached", "--name-only", "-z"], cwd)).split("\0").filter(Boolean);
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

async function commitPrFixes(cwd: string, iteration: number, ownedPaths: readonly string[], expectedParentHead: string): Promise<CommitReceipt | undefined> {
  const currentHead = await git(["rev-parse", "HEAD"], cwd);
  if (currentHead !== expectedParentHead) {
    throw new Error(`commit_pr_fixes refused to continue because HEAD changed from ${expectedParentHead} to ${currentHead} before parent-owned staging.`);
  }
  if (ownedPaths.length === 0) return undefined;
  const message = `fix: address PR feedback iteration ${iteration}`;
  const parentSha = currentHead;
  await git(["reset", "--"], cwd);
  await git(["add", "--", ...ownedPaths], cwd);
  const staged = await stagedPaths(cwd);
  const stagedOutsideOwnedPaths = staged.filter((path) => !ownedPaths.includes(path));
  if (stagedOutsideOwnedPaths.length > 0) {
    throw new Error(`commit_pr_fixes refused to commit staged paths outside remediation ownership: ${stagedOutsideOwnedPaths.join(", ")}`);
  }
  try {
    await git(["diff", "--cached", "--quiet", "--", ...ownedPaths], cwd);
    return undefined;
  } catch {
    // Non-zero means there is a staged diff to commit.
  }
  const expectedTree = await git(["write-tree"], cwd);
  await gitWithLocalAutomationDisabled(["commit", "--no-verify", "-m", message], cwd);
  const sha = await git(["rev-parse", "HEAD"], cwd);
  const actualParentSha = await git(["rev-parse", "HEAD^"], cwd);
  if (actualParentSha !== parentSha) {
    throw new Error(`commit_pr_fixes refused the parent-owned commit because its parent ${actualParentSha} does not match ${parentSha}.`);
  }
  const actualTree = await git(["rev-parse", "HEAD^{tree}"], cwd);
  if (actualTree !== expectedTree) {
    throw new Error("commit_pr_fixes refused the parent-owned commit because its tree differs from the selectively staged remediation tree.");
  }
  const shortSha = await git(["rev-parse", "--short", "HEAD"], cwd);
  return { sha, shortSha, message, parentSha };
}

function remoteMatchesRepo(remoteUrl: string | undefined, repo: string): boolean {
  const parsed = parseGitHubRemoteUrl(remoteUrl);
  return parsed !== undefined && `${parsed.owner}/${parsed.repo}`.toLowerCase() === repo.toLowerCase();
}

async function remotePushUrls(cwd: string, remote: string): Promise<readonly string[]> {
  try {
    return (await gitRaw(["remote", "get-url", "--push", "--all", remote], cwd))
      .split(/\r?\n/)
      .map((pushUrl) => pushUrl.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function gitRemotes(cwd: string): Promise<readonly { readonly name: string; readonly pushUrls: readonly string[] }[]> {
  const names = (await git(["remote"], cwd)).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const remotes = [] as { name: string; pushUrls: readonly string[] }[];
  for (const name of names) {
    const pushUrls = await remotePushUrls(cwd, name);
    if (pushUrls.length > 0) remotes.push({ name, pushUrls });
  }
  return remotes;
}

function requireKnownHeadRepository(state: PullRequestState): string {
  if (state.head_repository.kind === "unknown") {
    throw new Error(`UnknownHeadRepository: ${state.head_repository.reason}`);
  }
  return state.head_repository.full_name;
}

async function repoCloneUrl(repo: string, cwd: string): Promise<string | undefined> {
  try {
    const view = await ghJson<Record<string, unknown>>(["repo", "view", repo, "--json", "sshUrl,url"], cwd);
    const sshUrl = text(view.sshUrl);
    if (remoteMatchesRepo(sshUrl, repo)) return sshUrl;
    const url = text(view.url);
    if (remoteMatchesRepo(url, repo)) return url;
  } catch {
    return undefined;
  }
  return undefined;
}

function hasUrlCredentials(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

function safeRemoteName(value: string): boolean {
  return /^(?!-)[A-Za-z0-9._-]+$/.test(value) && !hasUrlCredentials(value);
}

function pushTargetFromRemote(remoteName: string, pushUrls: readonly string[], branch: string, repo: string): PushTarget | undefined {
  if (!safeRemoteName(remoteName) || !allPushUrlsMatchRepo(pushUrls, repo)) return undefined;
  return {
    kind: "remote",
    branch,
    repo,
    remoteName,
    validatedPushUrls: [...pushUrls],
    redactedPushUrls: pushUrls.map((pushUrl) => redactCommandOutput(pushUrl)),
    source: remoteName,
  };
}

function pushTargetFromUrl(pushUrl: string, branch: string, repo: string, source: string): PushTarget | undefined {
  if (hasUrlCredentials(pushUrl) || !remoteMatchesRepo(pushUrl, repo)) return undefined;
  return {
    kind: "direct_url",
    branch,
    repo,
    validatedPushUrl: pushUrl,
    redactedPushUrl: redactCommandOutput(pushUrl),
    source,
  };
}

function allPushUrlsMatchRepo(pushUrls: readonly string[], repo: string): boolean {
  return pushUrls.length > 0 && pushUrls.every((pushUrl) => remoteMatchesRepo(pushUrl, repo));
}

async function resolvePushTarget(cwd: string, state: PullRequestState): Promise<PushTarget> {
  if (state.lifecycle_state !== "OPEN") {
    throw new Error(`resolve_push_target refused to push because the PR lifecycle state is ${state.lifecycle_state}.`);
  }
  if (!state.head_ref) {
    throw new Error("resolve_push_target refused to push because the PR head branch is unknown.");
  }

  const headRepo = requireKnownHeadRepository(state);
  const remotes = await gitRemotes(cwd);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin) {
    const target = pushTargetFromRemote(origin.name, origin.pushUrls, state.head_ref, headRepo);
    if (target) return target;
  }

  for (const remote of remotes) {
    if (remote.name === "origin") continue;
    const target = pushTargetFromRemote(remote.name, remote.pushUrls, state.head_ref, headRepo);
    if (target) return target;
  }

  const directUrl = await repoCloneUrl(headRepo, cwd);
  const target = directUrl ? pushTargetFromUrl(directUrl, state.head_ref, headRepo, "gh repo view") : undefined;
  if (target) return target;

  throw new Error("resolve_push_target could not find a validated credential-safe push target for the PR head repository.");
}

async function pushDryRun(cwd: string, target: PushTarget): Promise<void> {
  const refspec = `HEAD:refs/heads/${target.branch}`;
  if (target.kind === "remote") {
    const currentPushUrls = await remotePushUrls(cwd, target.remoteName);
    if (!safeRemoteName(target.remoteName) || !allPushUrlsMatchRepo(currentPushUrls, target.repo)) {
      throw new Error("confirm_push_access refused because the validated remote no longer matches the PR head repository.");
    }
    await gitWithLocalAutomationDisabled(["push", "--dry-run", "--porcelain", "--no-verify", target.remoteName, refspec], cwd);
    return;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.validatedPushUrl)) {
    throw new Error("confirm_push_access refused to preflight an owner/repo slug instead of a real remote URL.");
  }
  if (hasUrlCredentials(target.validatedPushUrl)) {
    throw new Error("confirm_push_access refused to put a credential-bearing URL in git push argv.");
  }
  if (!remoteMatchesRepo(target.validatedPushUrl, target.repo)) {
    throw new Error("confirm_push_access refused because the single validated push URL no longer validates against the PR head repository.");
  }
  await gitWithLocalAutomationDisabled(["push", "--dry-run", "--porcelain", "--no-verify", target.validatedPushUrl, refspec], cwd);
}

async function confirmPushAccessForPrHead(cwd: string, state: PullRequestState): Promise<PushTarget> {
  await verifyLocalHeadMatchesPrHead(cwd, state, "confirmPushAccessForPrHead");
  const target = await resolvePushTarget(cwd, state);
  await pushDryRun(cwd, target);
  return target;
}

function redactedPushTargetArtifact(target: PushTarget): Record<string, unknown> {
  if (target.kind === "remote") {
    return {
      kind: target.kind,
      branch: target.branch,
      repo: target.repo,
      remoteName: target.remoteName,
      redactedPushUrls: target.redactedPushUrls,
      source: target.source,
    };
  }
  return {
    kind: target.kind,
    branch: target.branch,
    repo: target.repo,
    redactedPushUrl: target.redactedPushUrl,
    source: target.source,
  };
}

async function push_pr_fixes(cwd: string, state: PullRequestState, commit: CommitReceipt, target: PushTarget): Promise<PushReceipt> {
  if (state.lifecycle_state !== "OPEN") {
    throw new Error(`push_pr_fixes refused to push because the PR lifecycle state is ${state.lifecycle_state}.`);
  }
  if (!state.head_ref) {
    throw new Error("push_pr_fixes refused to push because the PR head branch is unknown.");
  }
  if (commit.parentSha !== state.head_sha) {
    throw new Error(`push_pr_fixes refused to push because commit parent ${commit.parentSha} does not match latest observed PR headRefOid ${state.head_sha}.`);
  }
  const currentHead = await git(["rev-parse", "HEAD"], cwd);
  if (currentHead !== commit.sha) {
    throw new Error(`push_pr_fixes refused to push because local HEAD ${currentHead} is not the parent-owned remediation commit ${commit.sha}.`);
  }
  const headRepo = requireKnownHeadRepository(state);
  if (state.push_accessible !== true) {
    throw new Error("push_pr_fixes refused to push because push access was not confirmed.");
  }
  if (target.branch !== state.head_ref || target.repo.toLowerCase() !== headRepo.toLowerCase()) {
    throw new Error("push_pr_fixes refused to push because the resolved target no longer matches the PR head.");
  }

  if (target.kind === "remote") {
    const currentPushUrls = await remotePushUrls(cwd, target.remoteName);
    if (!safeRemoteName(target.remoteName) || !allPushUrlsMatchRepo(currentPushUrls, target.repo)) {
      throw new Error("push_pr_fixes refused to push because the validated remote no longer matches the PR head repository.");
    }
    await gitWithLocalAutomationDisabled(["push", "--no-verify", target.remoteName, `HEAD:refs/heads/${target.branch}`], cwd);
    return { target: target.remoteName, branch: target.branch, commit: commit.sha };
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.validatedPushUrl)) {
    throw new Error("push_pr_fixes refused to push to an owner/repo slug instead of a real remote URL.");
  }
  if (hasUrlCredentials(target.validatedPushUrl)) {
    throw new Error("push_pr_fixes refused to put a credential-bearing URL in git push argv.");
  }
  if (!remoteMatchesRepo(target.validatedPushUrl, target.repo)) {
    throw new Error("push_pr_fixes refused to push because the single validated push URL no longer validates against the PR head repository.");
  }

  await gitWithLocalAutomationDisabled(["push", "--no-verify", target.validatedPushUrl, `HEAD:refs/heads/${target.branch}`], cwd);
  return { target: target.redactedPushUrl, branch: target.branch, commit: commit.sha };
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
    if (entry.ownedPathsArtifact) lines.push(`- Owned paths: ${displayPath(entry.ownedPathsArtifact)}`);
    if (entry.pushTargetArtifact) lines.push(`- Push target: ${displayPath(entry.pushTargetArtifact)}`);
    if (entry.commit) lines.push(`- Commit: ${entry.commit.shortSha} (${entry.commit.message})`);
    if (entry.push) lines.push(`- Pushed: ${entry.push.commit} to ${entry.push.target}/${entry.push.branch}`);
  }

  lines.push(
    "",
    "## Safety posture",
    "- No merge, close, approve, force-push, review-thread marking, or PR comment action was attempted.",
    "- Remote branch mutation is isolated to the `push_pr_fixes` helper.",
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

    if (!(await ghAuthAvailable(workflowCwd))) {
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

    try {
      await guardCleanWorkspace(workflowCwd, artifactDir);
      stages.push("pre-checkout-guard-clean-workspace");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stages.push("pre-checkout-guard-clean-workspace-failed");
      const report = await writeWorkflowReport({
        workflowName: WORKFLOW_NAME,
        summary: "needs human pre-checkout dirty workspace",
        cwd: workflowCwd,
        report: `# babysit-pr report\n\nStatus: needs_human\nPR: ${prUrl}\n\nUnable to checkout the PR branch because the workspace is not clean outside workflow-owned artifacts.\n\n\`\`\`text\n${message}\n\`\`\``,
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
        summary: "needs human pre-checkout dirty workspace",
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
      const ownedPathsPath = jsonArtifact(iterationDir, "owned-paths.json");
      const pushTargetPath = jsonArtifact(iterationDir, "push-target.json");
      let remediationArtifact: string | undefined;
      let receiptArtifact: string | undefined;
      let ownedPathsArtifact: string | undefined;
      let pushTargetArtifact: string | undefined;
      let pushTarget: PushTarget;
      let parentHeadBeforeRemediation: string;
      try {
        parentHeadBeforeRemediation = await verifyLocalHeadMatchesPrHead(workflowCwd, prState, "verifyLocalHeadMatchesPrHead before remediation");
        stages.push(`verify-local-head-pr-head-before-remediation-${iteration}`);
        pushTarget = await confirmPushAccessForPrHead(workflowCwd, prState);
        pushTargetArtifact = await writeRegisteredJsonArtifact(`iteration-${iteration}-push-target`, pushTargetPath, redactedPushTargetArtifact(pushTarget));
        prState = { ...prState, push_accessible: true };
        stages.push(`confirm-push-access-for-pr-head-${iteration}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = {
          kind: "needs_human",
          reason: "Push access could not be confirmed before remediation.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision, pushTargetArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      try {
        const remediation = await ctx.task(`remediate-pr-iteration-${iteration}`, {
          reads: [stateJsonPath, ciJsonPath, stateMarkdownPath],
          prompt: `Apply one bounded remediation pass for this GitHub PR.\n\nRead the artifacts:\n- PR state: ${displayPath(stateJsonPath)}\n- PR state summary: ${displayPath(stateMarkdownPath)}\n- CI state: ${displayPath(ciJsonPath)}\n\nAddress only actionable review feedback and failing CI for the current OPEN PR state. You may edit files, but this remediation stage has no shell access; the parent workflow owns validation, commits, and pushes. Do not run git commit, git push, git reset, git rebase, branch rewrites, force pushes, merges, or anything that changes HEAD/history. Do not merge, close, approve, resolve review threads, post comments, call GitHub mutating APIs, submit reviews, update PR metadata, or mutate GitHub state in any way. If feedback is ambiguous, unsafe, or unfixable, leave code untouched and explain why. End with a final marker line \`FINAL_REMEDIATION_RECEIPT:\` followed by a machine-checkable remediation receipt as raw JSON or a fenced json block with this schema: {"changed_files":[{"path":"src/foo.ts","change":"modify"}],"tests_run":[{"command":"not run - no shell access","result":"skipped"}],"residual_items":[],"addressed_comment_signal_ids":["comment-... or review-..."]}. Rename/copy entries must use old_path and new_path. The optional addressed_comment_signal_ids array is only for top-level PR comment or review-summary comment_signal IDs from the PR state that you actually addressed in this pass; do not include inline review thread IDs, unknown IDs, non-actionable IDs, or previously addressed IDs. Omit addressed_comment_signal_ids or use [] when no top-level comment/review-summary signal was addressed.`,
          output: remediationPath,
          outputMode: FILE_ONLY_OUTPUT,
          tools: ["read", "edit", "write"],
          noTools: "builtin",
          mcp: { deny: ["*"] },
        });
        await access(remediationPath);
        remediationArtifact = addArtifact(`iteration-${iteration}-remediation`, remediationPath);
        stages.push(remediation.stageName);
      } catch (error) {
        const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
        decision = {
          kind: "needs_human",
          reason: "Remediation child failed before the receipt gate.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, pushTargetArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      try {
        const parentHeadAfterRemediation = await git(["rev-parse", "HEAD"], workflowCwd);
        if (parentHeadAfterRemediation !== parentHeadBeforeRemediation) {
          decision = {
            kind: "needs_human",
            reason: "Remediation child changed git HEAD before the receipt gate; refusing to parse, stage, commit, or push.",
            remaining: [...remainingItemsForState(prState), `HEAD changed from ${parentHeadBeforeRemediation} to ${parentHeadAfterRemediation}`],
          };
          iterations.push({ ...ledgerEntry, decision, remediationArtifact, pushTargetArtifact });
          status = "needs_human";
          remainingItems = decision.remaining;
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = {
          kind: "needs_human",
          reason: "Unable to verify remediation child left git HEAD unchanged.",
          remaining: [...remainingItemsForState(prState), message],
        };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, pushTargetArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      let remediationReceipt: RemediationReceipt;
      let ownedRemediationPaths: readonly string[];
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
        ownedRemediationPaths = await collectOwnedRemediationPaths(workflowCwd, artifactDir, remediationReceipt);
        ownedPathsArtifact = await writeRegisteredJsonArtifact(`iteration-${iteration}-owned-paths`, ownedPathsPath, { paths: ownedRemediationPaths });
        stages.push(`collect-owned-remediation-paths-${iteration}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const receiptBlockedState = {
          ...prState,
          blockers: [...(prState.blockers ?? []), message],
        } satisfies PullRequestState;
        decision = { kind: "needs_human", reason: "Remediation receipt or selective ownership validation failed.", remaining: remainingItemsForState(receiptBlockedState) };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, receiptArtifact, ownedPathsArtifact, pushTargetArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      let commit: CommitReceipt | undefined;
      try {
        await verifyLocalHeadMatchesPrHead(workflowCwd, prState, "verifyLocalHeadMatchesPrHead before commit");
        stages.push(`verify-local-head-pr-head-before-commit-${iteration}`);
        commit = await commitPrFixes(workflowCwd, iteration, ownedRemediationPaths, prState.head_sha);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const commitBlockedState = {
          ...prState,
          blockers: [...(prState.blockers ?? []), `commit_pr_fixes failed: ${message}`],
        } satisfies PullRequestState;
        decision = { kind: "needs_human", reason: "Selective staging or commit safety failed.", remaining: remainingItemsForState(commitBlockedState) };
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, receiptArtifact, ownedPathsArtifact, pushTargetArtifact });
        status = "needs_human";
        remainingItems = decision.remaining;
        break;
      }

      if (!commit) {
        consecutiveNoProgress += 1;
        decision = classifyPrReadiness(prState, {
          iterations_completed: iteration,
          max_iterations: maxIterations,
          consecutive_no_progress: consecutiveNoProgress,
        });
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, receiptArtifact, ownedPathsArtifact, pushTargetArtifact });
        status = finalStatusFromDecision(decision);
        remainingItems = "remaining" in decision ? decision.remaining : remainingItemsForState(prState);
        break;
      }

      let push: PushReceipt;
      try {
        push = await push_pr_fixes(workflowCwd, prState, commit, pushTarget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pushBlockedState = {
          ...prState,
          non_fast_forward: true,
          blockers: [...(prState.blockers ?? []), `push_pr_fixes failed: ${message}`],
        } satisfies PullRequestState;
        decision = classifyPrReadiness(pushBlockedState, {
          iterations_completed: iteration,
          max_iterations: maxIterations,
        });
        iterations.push({ ...ledgerEntry, decision, remediationArtifact, receiptArtifact, ownedPathsArtifact, pushTargetArtifact, commit });
        status = finalStatusFromDecision(decision);
        remainingItems = "remaining" in decision ? decision.remaining : remainingItemsForState(pushBlockedState);
        break;
      }

      commitsPushed.push(commit.sha);
      markReceiptCommentSignalsAddressed(validatedAddressedCommentSignalIds, addressedCommentSignalIds);
      stages.push(`push-pr-fixes-${iteration}`);

      const postPushStateJsonPath = jsonArtifact(iterationDir, "post-push-pr-state.json");
      const postPushStateMarkdownPath = markdownArtifact(iterationDir, "post-push-pr-state.md");
      let postPushState: PullRequestState;
      let postPushDecision: LoopDecision;
      try {
        postPushState = withAddressedCommentSignals(await syncAfterPush(parsed.identity, commit.sha, workflowCwd, pollInterval, pollTimeout), addressedCommentSignalIds);
        prUrl = postPushState.url;
        lastHeadRepository = postPushState.head_repository;
        postPushDecision = classifyPrReadiness(postPushState, {
          iterations_completed: iteration,
          max_iterations: maxIterations,
        });
        await writeRegisteredJsonArtifact(`iteration-${iteration}-post-push-pr-state-json`, postPushStateJsonPath, postPushState);
        await writeRegisteredMarkdownArtifact(`iteration-${iteration}-post-push-pr-state`, postPushStateMarkdownPath, markdownPrState(postPushState, postPushDecision));
        stages.push(`sync-after-push-${iteration}`);
      } catch (error) {
        const message = redactCommandOutput(error instanceof Error ? error.message : String(error));
        postPushDecision = {
          kind: "needs_human",
          reason: "Post-push sync failed after a successful push.",
          remaining: [`Pushed commit ${commit.sha}, but post-push sync failed: ${message}`],
        };
        await writeRegisteredJsonArtifact(`iteration-${iteration}-post-push-pr-state-json`, postPushStateJsonPath, { error: message, pushedCommit: commit.sha });
        await writeRegisteredMarkdownArtifact(`iteration-${iteration}-post-push-pr-state`, postPushStateMarkdownPath, [
          `# Post-push sync failed for ${prUrl}`,
          "",
          `Pushed commit: ${commit.sha}`,
          "",
          "```text",
          message,
          "```",
        ].join("\n"));
        stages.push(`sync-after-push-failed-${iteration}`);
        iterations.push({ ...ledgerEntry, decision: postPushDecision, remediationArtifact, receiptArtifact, ownedPathsArtifact, pushTargetArtifact, commit, push });
        status = "needs_human";
        remainingItems = postPushDecision.remaining;
        break;
      }

      iterations.push({ ...ledgerEntry, decision: postPushDecision, remediationArtifact, receiptArtifact, ownedPathsArtifact, pushTargetArtifact, commit, push });
      remainingItems = "remaining" in postPushDecision ? postPushDecision.remaining : remainingItemsForState(postPushState);
      consecutiveNoProgress = 0;

      if (postPushDecision.kind !== "remediate") {
        status = finalStatusFromDecision(postPushDecision);
        break;
      }

      if (iteration === maxIterations) {
        status = postPushDecision.kind === "exhausted" ? "exhausted" : "needs_human";
        break;
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
