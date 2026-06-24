import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_BABYSIT_PR_BASE_BRANCH,
  DEFAULT_MAX_ITERATIONS,
  actionableFeedbackText,
  aggregateChecks,
  classifyPrReadiness,
  collectReceiptOwnedPaths,
  remainingItemsForState,
  mergeRequiredAndAllChecks,
  normalizeBoundedInteger,
  normalizeCheckState,
  normalizeMergeability,
  normalizeReviewThreadNodes,
  parseGitHubRemoteUrl,
  parseGitStatusPorcelain,
  parsePullRequestRef,
  parseRemediationReceiptContent,
  redactCommandOutput,
  resolveHeadRepositoryIdentity,
  validateReceiptAddressedCommentSignalIds,
  validateRemediationReceiptOutcome,
  type CheckRecord,
  type PullRequestState,
} from "./helpers.ts";

const babysitSource = () => readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const babysitReadme = () => readFileSync(new URL("./README.md", import.meta.url), "utf8");

type MockSchema = Record<string, unknown>;
type MockWorktreeBinding = {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
};
type MockTypeOptions = Record<string, unknown>;

function mockSchema(type: string, options: MockTypeOptions = {}): MockSchema {
  return { type, ...options };
}

const Type = {
  String: (options?: MockTypeOptions): MockSchema => mockSchema("string", options),
  Number: (options?: MockTypeOptions): MockSchema => mockSchema("number", options),
  Boolean: (options?: MockTypeOptions): MockSchema => mockSchema("boolean", options),
  Literal: (value: string | number | boolean): MockSchema => ({ const: value }),
  Union: (variants: readonly MockSchema[], options: MockTypeOptions = {}): MockSchema => ({ anyOf: variants, ...options }),
  Array: (items: MockSchema, options: MockTypeOptions = {}): MockSchema => ({ type: "array", items, ...options }),
  Object: (properties: Record<string, MockSchema>, options: MockTypeOptions = {}): MockSchema => ({ type: "object", properties, ...options }),
  Optional: (schema: MockSchema): MockSchema => ({ ...schema, optional: true }),
  Unsafe<T>(schema: MockSchema): MockSchema {
    void (undefined as T | undefined);
    return schema;
  },
};


mock.module("typebox", () => ({ Type }));

mock.module("@bastani/workflows", () => ({
  workflow(config: {
    readonly name: string;
    readonly description: string;
    readonly inputs: Record<string, MockSchema>;
    readonly outputs: Record<string, MockSchema>;
    readonly worktreeFromInputs?: MockWorktreeBinding;
    readonly run?: unknown;
  }) {
    return Object.freeze({
      __piWorkflow: true,
      ...config,
      inputs: Object.freeze({ ...config.inputs }),
      outputs: Object.freeze({ ...config.outputs }),
      ...(config.worktreeFromInputs ? { worktreeFromInputs: Object.freeze({ ...config.worktreeFromInputs }) } : {}),
    });
  },
}));

const babysitWorkflowPromise = import("./index.ts").then((module) => module.default);

const identity = { owner: "bastani-inc", repo: "atomic-workflows", number: 10, source: "url" as const };

function checks(records: readonly CheckRecord[]) {
  return aggregateChecks(records);
}

function prState(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    identity,
    url: "https://github.com/bastani-inc/atomic-workflows/pull/10",
    base_ref: "main",
    head_ref: "feature",
    head_repo: "bastani-inc/atomic-workflows",
    head_repository: {
      kind: "known",
      owner: "bastani-inc",
      repo: "atomic-workflows",
      full_name: "bastani-inc/atomic-workflows",
      is_cross_repository: false,
    },
    lifecycle_state: "OPEN",
    maintainer_can_modify: true,
    push_accessible: true,
    review_decision: "APPROVED",
    review_threads: [],
    comment_signals: [],
    checks: checks([{ name: "test", conclusion: "success" }]),
    head_sha: "abc123",
    ...overrides,
  };
}

describe("babysit-pr PR ref parsing", () => {
  test("parses full GitHub pull request URLs", () => {
    const parsed = parsePullRequestRef("https://github.com/bastani-inc/atomic-workflows/pull/10");
    expect(parsed).toEqual({
      ok: true,
      identity: { owner: "bastani-inc", repo: "atomic-workflows", number: 10, source: "url" },
    });
  });

  test("parses owner/repo#number shorthand", () => {
    const parsed = parsePullRequestRef("bastani-inc/atomic-workflows#123");
    expect(parsed).toEqual({
      ok: true,
      identity: { owner: "bastani-inc", repo: "atomic-workflows", number: 123, source: "shorthand" },
    });
  });

  test("resolves bare numbers from GitHub origin remotes", () => {
    expect(parseGitHubRemoteUrl("git@github.com:bastani-inc/atomic-workflows.git")).toEqual({ owner: "bastani-inc", repo: "atomic-workflows" });
    expect(parseGitHubRemoteUrl("https://oauth:token@github.com/bastani-inc/atomic-workflows.git")).toEqual({ owner: "bastani-inc", repo: "atomic-workflows" });
    expect(parsePullRequestRef("7", { originUrl: "https://github.com/bastani-inc/atomic-workflows.git" })).toEqual({
      ok: true,
      identity: { owner: "bastani-inc", repo: "atomic-workflows", number: 7, source: "bare" },
    });
  });

  test("fails fast for invalid PR references", () => {
    expect(parsePullRequestRef("", { originUrl: "https://github.com/a/b.git" })).toMatchObject({ ok: false, error: { code: "EmptyInput" } });
    expect(parsePullRequestRef("https://gitlab.com/a/b/-/merge_requests/1")).toMatchObject({ ok: false, error: { code: "UnsupportedHost" } });
    expect(parsePullRequestRef("0", { originUrl: "https://github.com/a/b.git" })).toMatchObject({ ok: false, error: { code: "InvalidNumber" } });
    expect(parsePullRequestRef("44")).toMatchObject({ ok: false, error: { code: "BareNumberWithoutOrigin" } });
    expect(parsePullRequestRef("owner/repo/pull/1")).toMatchObject({ ok: false, error: { code: "InvalidFormat" } });
  });
});

describe("babysit-pr check aggregation and decisions", () => {
  test("aggregates pending checks before failures and unknowns", () => {
    const summary = aggregateChecks([
      { name: "unit", conclusion: "success" },
      { name: "e2e", status: "in_progress" },
      { name: "lint", conclusion: "failure" },
      { name: "mystery", state: "wat" },
    ]);

    expect(summary.state).toBe("pending");
    expect(summary.observed).toBe(true);
    expect(summary.observed_count).toBe(4);
    expect(summary.pending.map((check) => check.name)).toEqual(["e2e"]);
    expect(summary.failing.map((check) => check.name)).toEqual(["lint"]);
    expect(summary.unknown.map((check) => check.name)).toEqual(["mystery"]);
  });

  test("treats skipped and neutral checks as non-failing", () => {
    const summary = aggregateChecks([
      { name: "optional", conclusion: "skipped" },
      { name: "matrix", conclusion: "neutral" },
      { name: "unit", conclusion: "success" },
    ]);

    expect(normalizeCheckState({ name: "optional", conclusion: "skipped" })).toBe("neutral");
    expect(summary.state).toBe("success");
    expect(summary.observed).toBe(true);
    expect(summary.failing).toEqual([]);
    expect(summary.unknown).toEqual([]);
  });

  test("empty check data is not green and cannot classify clean", () => {
    const summary = aggregateChecks([]);
    expect(summary).toMatchObject({ state: "unknown", observed: false, observed_count: 0, checks: [] });

    const decision = classifyPrReadiness(prState({ checks: summary }), { iterations_completed: 0, max_iterations: 10 });
    expect(decision).toMatchObject({
      kind: "needs_human",
      reason: expect.stringContaining("No CI check records were observed"),
      remaining: [expect.stringContaining("no check records observed")],
    });
  });

  test("returns clean only when feedback is clear and observed CI is green", () => {
    expect(classifyPrReadiness(prState(), { iterations_completed: 0, max_iterations: 10 })).toEqual({
      kind: "clean",
      reason: "No actionable review feedback remains and all current checks are green.",
    });
  });

  test("merges required green checks with visible optional failures", () => {
    const required = checks([{ name: "required-build", conclusion: "success" }]);
    const all = checks([
      { name: "required-build", conclusion: "success" },
      { name: "optional-lint", conclusion: "failure" },
    ]);
    const merged = mergeRequiredAndAllChecks(required, all);

    expect(merged.required_scope).toBe("required-plus-visible");
    expect(merged.state).toBe("failure");
    expect(merged.failing.map((check) => check.name)).toEqual(["optional-lint"]);
    expect(classifyPrReadiness(prState({ checks: merged }), { iterations_completed: 0, max_iterations: 10 })).toEqual({
      kind: "remediate",
      feedback_count: 0,
      failing_checks: ["optional-lint"],
    });
  });

  test("keeps required-only check fallback when all-check data is absent", () => {
    const merged = mergeRequiredAndAllChecks(checks([{ name: "required-build", conclusion: "success" }]), undefined);

    expect(merged.required_scope).toBe("required-checks");
    expect(merged.state).toBe("success");
    expect(classifyPrReadiness(prState({ checks: merged }), { iterations_completed: 0, max_iterations: 10 })).toMatchObject({ kind: "clean" });
  });


  test("treats missing PR head repository metadata as needs_human without base repo fallback", () => {
    expect(resolveHeadRepositoryIdentity(null, { login: "bastani-inc" }, identity)).toEqual({ kind: "unknown", reason: "missing_head_repository" });
    expect(resolveHeadRepositoryIdentity({ name: "atomic-workflows" }, null, identity)).toEqual({ kind: "unknown", reason: "missing_head_owner" });
    const known = resolveHeadRepositoryIdentity({ name: "atomic-workflows" }, { login: "bastani-inc" }, identity);
    expect(known).toMatchObject({ kind: "known", full_name: "bastani-inc/atomic-workflows", is_cross_repository: false });

    expect(classifyPrReadiness(prState({
      head_repo: "unknown/unknown",
      head_repository: { kind: "unknown", reason: "missing_head_repository" },
    }), { iterations_completed: 0, max_iterations: 10 })).toMatchObject({
      kind: "needs_human",
      reason: expect.stringContaining("PR head repository is unknown"),
    });
  });

  test("does not block same-repo or clean states on maintainerCanModify=false", () => {
    expect(classifyPrReadiness(prState({ maintainer_can_modify: false }), {
      iterations_completed: 0,
      max_iterations: 10,
    })).toMatchObject({ kind: "clean" });

    expect(classifyPrReadiness(prState({
      maintainer_can_modify: false,
      checks: checks([{ name: "lint", conclusion: "failure" }]),
    }), { iterations_completed: 0, max_iterations: 10 })).toEqual({
      kind: "remediate",
      feedback_count: 0,
      failing_checks: ["lint"],
    });
  });

  test("uses a tightened shared feedback actionability heuristic", () => {
    expect(actionableFeedbackText("Please fix flaky lint handling")).toBe(true);
    expect(actionableFeedbackText("please change the parser error handling")).toBe(true);
    expect(actionableFeedbackText("Please update the README")).toBe(true);
    expect(actionableFeedbackText("This must handle empty input")).toBe(true);
    expect(actionableFeedbackText("This is broken and failing")).toBe(true);
    expect(actionableFeedbackText("Please take a look when you can")).toBe(false);
    expect(actionableFeedbackText("This should be okay now")).toBe(false);
    expect(actionableFeedbackText("Thanks for the update")).toBe(false);
  });

  test("routes actionable top-level PR comments to remediation and remaining items", () => {
    const state = prState({
      comment_signals: [{ id: "comment-1", source: "comment", body: "Please fix flaky lint handling", author: "octo", actionable: true }],
      review_threads: [],
    });
    const decision = classifyPrReadiness(state, { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toEqual({ kind: "remediate", feedback_count: 1, failing_checks: [] });
    expect(remainingItemsForState(state)).toEqual(["Actionable PR comment from octo: Please fix flaky lint handling"]);
  });

  test("routes actionable CHANGES_REQUESTED review summaries to remediation", () => {
    const decision = classifyPrReadiness(prState({
      review_decision: "CHANGES_REQUESTED",
      comment_signals: [{ id: "review-1", source: "review", body: "Please change the parser error handling", author: "reviewer", actionable: true }],
      review_threads: [],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toEqual({ kind: "remediate", feedback_count: 1, failing_checks: [] });
  });

  test("routes actionable COMMENTED review summaries to remediation", () => {
    const decision = classifyPrReadiness(prState({
      review_decision: "APPROVED",
      comment_signals: [{ id: "review-1", source: "review", body: "Please update the parser docs", author: "reviewer", actionable: true }],
      review_threads: [],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toEqual({ kind: "remediate", feedback_count: 1, failing_checks: [] });
  });

  test("keeps non-actionable top-level PR comments supplemental and non-blocking", () => {
    const state = prState({
      comment_signals: [{ id: "comment-1", source: "comment", body: "Thanks for the update", author: "octo", actionable: false }],
      review_threads: [],
    });
    const decision = classifyPrReadiness(state, { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toMatchObject({ kind: "clean" });
    expect(remainingItemsForState(state)).toEqual([]);
  });

  test("ignores addressed top-level comment signals when otherwise clean", () => {
    const state = prState({
      comment_signals: [{ id: "comment-C1", source: "comment", body: "Please fix flaky lint handling", author: "octo", actionable: true }],
      addressed_comment_signal_ids: ["comment-C1"],
      review_threads: [],
    });

    expect(classifyPrReadiness(state, { iterations_completed: 1, max_iterations: 10 })).toMatchObject({ kind: "clean" });
    expect(remainingItemsForState(state)).toEqual([]);
  });

  test("remediates new unaddressed top-level signals while ignoring addressed ones", () => {
    const state = prState({
      comment_signals: [
        { id: "comment-C1", source: "comment", body: "Please fix flaky lint handling", author: "octo", actionable: true },
        { id: "comment-C2", source: "comment", body: "Please update parser docs", author: "octo", actionable: true },
      ],
      addressed_comment_signal_ids: ["comment-C1"],
      review_threads: [],
    });

    expect(classifyPrReadiness(state, { iterations_completed: 1, max_iterations: 10 })).toEqual({
      kind: "remediate",
      feedback_count: 1,
      failing_checks: [],
    });
    expect(remainingItemsForState(state)).toEqual(["Actionable PR comment from octo: Please update parser docs"]);
  });

  test("feedback_count reflects actionable comment and review signals", () => {
    const decision = classifyPrReadiness(prState({
      comment_signals: [
        { id: "comment-1", source: "comment", body: "Please fix the docs", author: "octo", actionable: true },
        { id: "review-1", source: "review", body: "This must handle empty input", author: "reviewer", actionable: true },
        { id: "comment-2", source: "comment", body: "Looks promising", author: "octo", actionable: false },
      ],
      review_threads: [],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toEqual({ kind: "remediate", feedback_count: 2, failing_checks: [] });
  });

  test("keeps CHANGES_REQUESTED fallback when no actionable text is identified", () => {
    const decision = classifyPrReadiness(prState({
      review_decision: "CHANGES_REQUESTED",
      comment_signals: [{ id: "review-1", source: "review", body: "This is surprising", author: "reviewer", actionable: false }],
      review_threads: [],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toMatchObject({
      kind: "needs_human",
      reason: expect.stringContaining("requested changes"),
    });
  });

  test("waits for pending CI instead of exiting clean", () => {
    const decision = classifyPrReadiness(prState({ checks: checks([{ name: "build", status: "queued" }]) }), {
      iterations_completed: 0,
      max_iterations: 10,
    });
    expect(decision).toEqual({ kind: "wait_for_ci", pending: ["build"] });
  });

  test("routes closed, merged, and unknown lifecycle states to humans before CI decisions", () => {
    for (const lifecycleState of ["CLOSED", "MERGED", "UNKNOWN"] as const) {
      const decision = classifyPrReadiness(prState({
        lifecycle_state: lifecycleState,
        checks: checks([{ name: "build", status: "queued" }]),
      }), { iterations_completed: 0, max_iterations: 10 });

      expect(decision).toMatchObject({
        kind: "needs_human",
        reason: expect.stringContaining(lifecycleState === "UNKNOWN" ? "unknown" : lifecycleState),
      });
    }
  });

  test("requires GitHub headRefOid before remediation", () => {
    const decision = classifyPrReadiness(prState({
      head_sha: "",
      checks: checks([{ name: "lint", conclusion: "failure" }]),
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toMatchObject({
      kind: "needs_human",
      reason: expect.stringContaining("headRefOid"),
    });
  });

  test("remediates failing checks and actionable review feedback", () => {
    const decision = classifyPrReadiness(prState({
      checks: checks([{ name: "lint", conclusion: "failure" }]),
      review_threads: [{ id: "1", path: "src/a.ts", line: 12, body: "Please fix this bug", author: "reviewer", resolved: false, actionable: true }],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toEqual({ kind: "remediate", feedback_count: 1, failing_checks: ["lint"] });
  });

  test("blocks clean for unresolved non-outdated inline review threads even without keyword actionability", () => {
    const decision = classifyPrReadiness(prState({
      review_threads: [{ id: "1", path: "src/a.ts", line: 12, body: "This behavior is surprising", author: "reviewer", resolved: false, outdated: false, actionable: false }],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toMatchObject({
      kind: "needs_human",
      reason: expect.stringContaining("Unresolved non-outdated inline review threads"),
      remaining: [expect.stringContaining("This behavior is surprising")],
    });
  });

  test("routes ambiguous live inline threads to humans before failing CI remediation", () => {
    const decision = classifyPrReadiness(prState({
      checks: checks([{ name: "lint", conclusion: "failure" }]),
      review_threads: [{ id: "1", path: "src/a.ts", line: 12, body: "This behavior is surprising", author: "reviewer", resolved: false, outdated: false, actionable: false }],
    }), { iterations_completed: 0, max_iterations: 10 });

    expect(decision).toMatchObject({
      kind: "needs_human",
      reason: expect.stringContaining("Unresolved non-outdated inline review threads"),
      remaining: [expect.stringContaining("This behavior is surprising"), expect.stringContaining("CI failing: lint")],
    });
  });

  test("exhausts when bounded loop reaches max iterations with work remaining", () => {
    const decision = classifyPrReadiness(prState({ checks: checks([{ name: "test", conclusion: "failure" }]) }), {
      iterations_completed: 3,
      max_iterations: 3,
    });

    expect(decision).toMatchObject({ kind: "exhausted", iterations_completed: 3 });
  });

  test("normalizes mergeability and refuses conflicting or unknown clean exits", () => {
    expect(normalizeMergeability("MERGEABLE", "CLEAN")).toMatchObject({ kind: "clean" });
    expect(normalizeMergeability("CONFLICTING", "DIRTY")).toMatchObject({ kind: "dirty" });
    expect(normalizeMergeability("UNKNOWN", "UNKNOWN")).toMatchObject({ kind: "unknown" });
    expect(normalizeMergeability("MERGEABLE", "BLOCKED")).toMatchObject({ kind: "blocked" });
    expect(classifyPrReadiness(prState({ mergeability: normalizeMergeability("UNKNOWN", "UNKNOWN") }), {
      iterations_completed: 0,
      max_iterations: 10,
    })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("mergeability is unknown") });
    expect(classifyPrReadiness(prState({ mergeability: normalizeMergeability("CONFLICTING", "DIRTY") }), {
      iterations_completed: 0,
      max_iterations: 10,
    })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("merge conflicts") });
  });

  test("normalizes inline review threads with source, location, resolution, and actionability", () => {
    const [thread, resolved, outdated] = normalizeReviewThreadNodes([
      {
        id: "thread-1",
        isResolved: false,
        isOutdated: false,
        path: "src/a.ts",
        line: 42,
        comments: { nodes: [{ id: "comment-1", body: "Please fix this bug", author: { login: "octo" } }] },
      },
      {
        id: "thread-2",
        isResolved: true,
        comments: { nodes: [{ body: "Please change this", author: { login: "octo" } }] },
      },
      {
        id: "thread-3",
        isOutdated: true,
        comments: { nodes: [{ body: "Please fix stale code", author: { login: "octo" } }] },
      },
    ]);

    expect(thread).toMatchObject({ id: "thread-1", source: "inline", path: "src/a.ts", line: 42, author: "octo", actionable: true, resolved: false, outdated: false });
    expect(resolved).toMatchObject({ resolved: true, actionable: false });
    expect(outdated).toMatchObject({ outdated: true, actionable: false });
  });

  test("requires humans for no-progress, push access, merge conflict, ambiguous feedback, and non-fast-forward safety cases", () => {
    expect(classifyPrReadiness(prState({ checks: checks([{ name: "test", conclusion: "failure" }]) }), {
      iterations_completed: 1,
      max_iterations: 10,
      consecutive_no_progress: 1,
    })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("no progress") });
    expect(classifyPrReadiness(prState({ push_accessible: false }), { iterations_completed: 0, max_iterations: 10 })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("No push access") });
    expect(classifyPrReadiness(prState({ merge_conflict: true }), { iterations_completed: 0, max_iterations: 10 })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("merge conflicts") });
    expect(classifyPrReadiness(prState({ ambiguous_feedback: true }), { iterations_completed: 0, max_iterations: 10 })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("ambiguous") });
    expect(classifyPrReadiness(prState({ non_fast_forward: true }), { iterations_completed: 0, max_iterations: 10 })).toMatchObject({ kind: "needs_human", reason: expect.stringContaining("fast-forward") });
  });
});


describe("babysit-pr remediation receipt, redaction, and git status helpers", () => {
  test("parses machine-checkable remediation receipts from JSON or fenced JSON", () => {
    const jsonReceipt = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    expect(jsonReceipt).toMatchObject({ ok: true, receipt: { changed_files: [{ path: "src/foo.ts", change: "modify" }] } });

    const fencedReceipt = parseRemediationReceiptContent([
      "Summary",
      "```json",
      JSON.stringify({
        changed_files: [{ old_path: "src/old.ts", new_path: "src/new.ts", change: "rename" }],
        tests_run: [{ command: "bun test", result: "skipped" }],
        residual_items: ["manual review required"],
      }),
      "```",
    ].join("\n"));
    expect(fencedReceipt).toMatchObject({ ok: true, receipt: { changed_files: [{ old_path: "src/old.ts", new_path: "src/new.ts", change: "rename" }] } });
  });

  test("uses the final remediation receipt instead of earlier example JSON", () => {
    const parsed = parseRemediationReceiptContent([
      "Example only:",
      "```json",
      JSON.stringify({
        changed_files: [{ path: "docs/example.md", change: "modify" }],
        tests_run: [{ command: "example", result: "skipped" }],
        residual_items: ["example residual"],
      }),
      "```",
      "FINAL_REMEDIATION_RECEIPT:",
      "```json",
      JSON.stringify({
        changed_files: [{ path: "src/final.ts", change: "modify" }],
        tests_run: [{ command: "bun test", result: "passed" }],
        residual_items: [],
      }),
      "```",
    ].join("\n"));

    expect(parsed).toMatchObject({ ok: true, receipt: { changed_files: [{ path: "src/final.ts", change: "modify" }], residual_items: [] } });
  });

  test("parses optional addressed comment signal IDs as trimmed sorted unique strings", () => {
    const missing = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    expect(missing).toMatchObject({ ok: true, receipt: { addressed_comment_signal_ids: [] } });

    const parsed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
      addressed_comment_signal_ids: [" review-R2 ", "comment-C1", "comment-C1"],
    }));
    expect(parsed).toMatchObject({ ok: true, receipt: { addressed_comment_signal_ids: ["comment-C1", "review-R2"] } });
  });

  test("rejects malformed addressed comment signal IDs", () => {
    expect(parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
      addressed_comment_signal_ids: "comment-C1",
    }))).toMatchObject({ ok: false, error: expect.stringContaining("addressed_comment_signal_ids") });

    expect(parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
      addressed_comment_signal_ids: ["comment-C1", ""],
    }))).toMatchObject({ ok: false, error: expect.stringContaining("non-empty string") });
  });

  test("validates receipt-listed addressed comment signal IDs against current actionable state", () => {
    const state = prState({
      comment_signals: [
        { id: "comment-C1", source: "comment", body: "Please fix docs", author: "octo", actionable: true },
        { id: "review-R2", source: "review", body: "Please update parser", author: "reviewer", actionable: true },
        { id: "comment-C3", source: "comment", body: "Thanks", author: "octo", actionable: false },
      ],
      addressed_comment_signal_ids: ["review-R2"],
    });

    expect(validateReceiptAddressedCommentSignalIds(state, { addressed_comment_signal_ids: ["comment-C1"] })).toEqual({
      ok: true,
      addressed_comment_signal_ids: ["comment-C1"],
    });
    expect(validateReceiptAddressedCommentSignalIds(state, { addressed_comment_signal_ids: ["comment-C3"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown or non-actionable"),
    });
    expect(validateReceiptAddressedCommentSignalIds(state, { addressed_comment_signal_ids: ["review-R2"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already-addressed"),
    });
  });

  test("validates remediation receipt outcome before ownership", () => {
    const passed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [
        { command: "bun test", result: "passed" },
        { command: "optional integration", result: "skipped" },
      ],
      residual_items: [],
    }));
    if (!passed.ok) throw new Error(passed.error);
    expect(validateRemediationReceiptOutcome(passed.receipt)).toEqual({
      ok: true,
      passed_tests: ["bun test"],
      skipped_tests: ["optional integration"],
    });

    const failed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "failed" }],
      residual_items: [],
    }));
    if (!failed.ok) throw new Error(failed.error);
    expect(validateRemediationReceiptOutcome(failed.receipt)).toMatchObject({
      ok: false,
      error: expect.stringContaining("failed validation"),
      failed_tests: ["bun test"],
    });

    const residual = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "not applicable", result: "skipped" }],
      residual_items: ["manual follow-up"],
    }));
    if (!residual.ok) throw new Error(residual.error);
    expect(validateRemediationReceiptOutcome(residual.receipt)).toMatchObject({
      ok: false,
      error: expect.stringContaining("residual work"),
      residual_items: ["manual follow-up"],
    });
  });

  test("keeps token-like repository names raw for URL parsing while serialization redacts", () => {
    const rawUrl = "https://github.com/octo/ghp_fixture.git";
    expect(parseGitHubRemoteUrl(rawUrl)).toEqual({ owner: "octo", repo: "ghp_fixture" });
    expect(redactCommandOutput(rawUrl)).not.toContain("ghp_fixture");
  });

  test("rejects malformed remediation receipts and unsafe paths", () => {
    expect(parseRemediationReceiptContent("changed src/foo.ts")).toMatchObject({ ok: false });
    expect(parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "../secret", change: "modify" }],
      tests_run: [],
      residual_items: [],
    }))).toMatchObject({ ok: false, error: expect.stringContaining("unsafe") });
    expect(parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "/tmp/secret", change: "modify" }],
      tests_run: [],
      residual_items: [],
    }))).toMatchObject({ ok: false, error: expect.stringContaining("unsafe") });
  });

  test("collects only paths present in both remediation receipt and git diff", () => {
    const parsed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ path: "src/foo.ts", change: "modify" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(collectReceiptOwnedPaths([{ status: " M", path: "src/foo.ts" }], parsed.receipt)).toEqual({ ok: true, paths: ["src/foo.ts"] });
    expect(collectReceiptOwnedPaths([{ status: " M", path: "src/foo.ts" }, { status: " M", path: "src/unlisted.ts" }], parsed.receipt)).toMatchObject({ ok: false, error: expect.stringContaining("absent") });
    expect(collectReceiptOwnedPaths([], parsed.receipt)).toMatchObject({ ok: false, error: expect.stringContaining("no corresponding git diff") });
  });

  test("requires rename receipt entries to match porcelain rename paths", () => {
    const parsed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ old_path: "src/old.ts", new_path: "src/new.ts", change: "rename" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(collectReceiptOwnedPaths([
      { status: "R ", path: "src/new.ts" },
      { status: "R ", path: "src/old.ts" },
    ], parsed.receipt)).toEqual({ ok: true, paths: ["src/new.ts", "src/old.ts"] });
    expect(collectReceiptOwnedPaths([
      { status: " M", path: "src/new.ts" },
      { status: " D", path: "src/old.ts" },
    ], parsed.receipt)).toMatchObject({ ok: false, error: expect.stringContaining("rename") });
  });

  test("stages only copy destinations while treating old_path as provenance", () => {
    const parsed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [{ old_path: "src/source.ts", new_path: "src/copied.ts", change: "copy" }],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    if (!parsed.ok) throw new Error(parsed.error);

    expect(collectReceiptOwnedPaths([{ status: "??", path: "src/copied.ts" }], parsed.receipt)).toEqual({ ok: true, paths: ["src/copied.ts"] });
    expect(collectReceiptOwnedPaths([
      { status: "C ", path: "src/copied.ts" },
      { status: "C ", path: "src/source.ts" },
    ], parsed.receipt)).toEqual({ ok: true, paths: ["src/copied.ts"] });
    expect(collectReceiptOwnedPaths([
      { status: "??", path: "src/copied.ts" },
      { status: " M", path: "src/source.ts" },
    ], parsed.receipt)).toMatchObject({ ok: false, error: expect.stringContaining("copy source") });
  });

  test("allows copy sources to be staged only when separately listed as modified", () => {
    const parsed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [
        { old_path: "src/source.ts", new_path: "src/copied.ts", change: "copy" },
        { path: "src/source.ts", change: "modify" },
      ],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    if (!parsed.ok) throw new Error(parsed.error);

    expect(collectReceiptOwnedPaths([
      { status: "??", path: "src/copied.ts" },
      { status: " M", path: "src/source.ts" },
    ], parsed.receipt)).toEqual({ ok: true, paths: ["src/copied.ts", "src/source.ts"] });
  });

  test("redacts GitHub PATs, URL credentials, and generic secret assignments", () => {
    const input = [
      "github_pat_11ABCDEFG_secret",
      "ghp_classic123",
      "gho_oauth123",
      "ghu_user123",
      "ghs_server123",
      "ghr_refresh123",
      "https://octo:super-secret@github.com/owner/repo.git",
      "API_TOKEN=abc123",
      "password: hunter2",
      "client_secret='shh'",
    ].join(" ");
    const output = redactCommandOutput(input);

    expect(output).not.toContain("github_pat_");
    expect(output).not.toContain("ghp_classic123");
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("shh");
    expect(output).toContain("[REDACTED_TOKEN]");
    expect(output).toContain("https://[REDACTED_CREDENTIALS]@github.com/owner/repo.git");
  });

  test("preserves both destination and source records for rename and copy porcelain", () => {
    expect(parseGitStatusPorcelain("R  new/name.ts\0old/name.ts\0C  copy/name.ts\0source/name.ts\0 M kept.ts\0")).toEqual([
      { status: "R ", path: "new/name.ts" },
      { status: "R ", path: "old/name.ts" },
      { status: "C ", path: "copy/name.ts" },
      { status: "C ", path: "source/name.ts" },
      { status: " M", path: "kept.ts" },
    ]);
  });

  test("parses NUL porcelain records without requiring trimmed stdout", () => {
    expect(parseGitStatusPorcelain(" M leading-space-status.ts\0")).toEqual([
      { status: " M", path: "leading-space-status.ts" },
    ]);
  });

  test("keeps token-like filenames exact for git porcelain ownership", () => {
    const entries = parseGitStatusPorcelain(" M src/ghp_fixture.ts\0?? src/API_TOKEN=fixture.ts\0");
    expect(entries).toEqual([
      { status: " M", path: "src/ghp_fixture.ts" },
      { status: "??", path: "src/API_TOKEN=fixture.ts" },
    ]);

    const parsed = parseRemediationReceiptContent(JSON.stringify({
      changed_files: [
        { path: "src/ghp_fixture.ts", change: "modify" },
        { path: "src/API_TOKEN=fixture.ts", change: "add" },
      ],
      tests_run: [{ command: "bun test", result: "passed" }],
      residual_items: [],
    }));
    if (!parsed.ok) throw new Error(parsed.error);

    expect(collectReceiptOwnedPaths(entries, parsed.receipt)).toEqual({
      ok: true,
      paths: ["src/API_TOKEN=fixture.ts", "src/ghp_fixture.ts"],
    });
  });
});

describe("babysit-pr workflow shape", () => {
  test("compiled workflow declares inputs, outputs, and worktree binding", async () => {
    const workflow = await babysitWorkflowPromise;
    const source = babysitSource();
    expect(source).toContain('import { workflow } from "@bastani/workflows";');
    expect(source).toContain('import { Type } from "typebox";');
    expect(source).not.toContain("defineWorkflow");
    expect(source).not.toContain(".compile()");
    expect(workflow.name).toBe("babysit-pr");
    expect(workflow.inputs.max_iterations?.default).toBe(DEFAULT_MAX_ITERATIONS);
    expect(workflow.inputs.base_branch?.default).toBe(DEFAULT_BABYSIT_PR_BASE_BRANCH);
    expect(workflow.inputs.git_worktree_dir?.default).toBe("");
    expect(workflow.worktreeFromInputs).toEqual({ gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" });
    expect(Object.keys(workflow.outputs)).toEqual([
      "summary",
      "status",
      "pr_url",
      "iterations_completed",
      "commits_pushed",
      "remaining_items",
      "report_path",
      "filename_summary",
      "artifact_dir",
      "manifest_path",
      "stages",
    ]);
  });

  test("source keeps remote mutation behind push_pr_fixes and enforces child mutation policy", () => {
    const source = babysitSource();
    expect(source).toContain("async function push_pr_fixes");
    expect(source).toContain("await push_pr_fixes(");
    expect(source).toContain('tools: ["read", "edit", "write"]');
    expect(source).toContain('noTools: "builtin"');
    expect(source).toContain('mcp: { deny: ["*"] }');
    expect(source).toContain("this remediation stage has no shell access");
    expect(source).not.toContain('tools: ["read", "edit", "write", "bash"]');
    expect(source).not.toContain("bashPolicy");
    expect(source).not.toContain('default: "allow"');
    expect(source).not.toContain("--force");
    expect(source).not.toContain("thread resolve");
  });

  test("source stages only explicit remediation-owned paths", () => {
    const source = babysitSource();
    expect(source).toContain("parseRemediationReceipt");
    expect(source).toContain("collectOwnedRemediationPaths");
    expect(source).toContain("guardCleanWorkspace");
    expect(source).toContain("parseGitStatusPorcelain");
    expect(source).toContain("git([\"add\", \"--\", ...ownedPaths]");
    expect(source).not.toMatch(/git\(\["add",\s*"--all"/);
    expect(source).not.toMatch(/git\(\["add",\s*"-A"/);
    expect(source).not.toMatch(/git\(\["add",\s*"\."/);
  });

  test("source guards a clean workspace before checkout and preserves remediation guard", () => {
    const source = babysitSource();
    expect(source).toContain("pre-checkout-guard-clean-workspace-failed");
    expect(source).toContain("needs human pre-checkout dirty workspace");
    expect(source).toContain("iterations_completed: 0");
    expect(source).toContain("commits_pushed: []");
    const authIndex = source.indexOf("ghAuthAvailable(workflowCwd)");
    const preCheckoutGuardIndex = source.indexOf("await guardCleanWorkspace(workflowCwd, artifactDir)");
    const checkoutIndex = source.indexOf("await checkoutPrBranch(parsed.identity, workflowCwd)");
    const remediationGuardIndex = source.indexOf("stages.push(`guard-clean-workspace-${iteration}`)");
    expect(authIndex).toBeGreaterThan(-1);
    expect(preCheckoutGuardIndex).toBeGreaterThan(authIndex);
    expect(checkoutIndex).toBeGreaterThan(preCheckoutGuardIndex);
    expect(remediationGuardIndex).toBeGreaterThan(checkoutIndex);
  });

  test("source excludes workflow report and artifact paths from remediation ownership", () => {
    const source = babysitSource();
    expect(source).toContain("const WORKFLOW_ARTIFACT_ROOT_PREFIX = `.${WORKFLOW_NAME}-`");
    expect(source).toContain("const WORKFLOW_REPORT_ROOT = WORKFLOW_NAME");
    expect(source).toContain("function isWorkflowArtifactPath");
    expect(source).toContain("return isWorkflowArtifactPath(path) || ownedRoots.some");
    expect(source).toContain("relativeGitPath(cwd, artifactDir), WORKFLOW_REPORT_ROOT");
    expect(source).toContain(".filter((entry) => !isWorkflowOwnedPath(entry.path, ownedRoots))");
  });

  test("source combines required and all gh checks before status rollup fallback", () => {
    const source = babysitSource();
    expect(source).toContain("async function prChecks");
    expect(source).toContain("const requiredChecks = await ghPrChecks(identity, cwd, { required: true })");
    expect(source).toContain("const allChecks = await ghPrChecks(identity, cwd)");
    expect(source).toContain("return mergeRequiredAndAllChecks(requiredChecks, allChecks)");
    expect(source).toContain('...(options.required ? ["--required"] : [])');
    expect(source).toContain("const checks = checkedRuns.observed ? checkedRuns : aggregateChecks(statusRollupChecks(view))");
  });

  test("source fetches lifecycle state, mergeability, inline review threads, headRefOid, resolved push targets, and post-push sync", () => {
    const source = babysitSource();
    expect(source).toContain("headRefOid");
    expect(source).toContain("text(view.headRefOid)");
    expect(source).toContain("lifecycle_state: normalizePullRequestLifecycleState(view.state)");
    expect(source).toContain("if (prState.lifecycle_state === \"OPEN\")");
    expect(source).toContain("current.lifecycle_state !== \"OPEN\"");
    expect(source).not.toContain("lastCommit");
    expect(source).not.toContain("view.commits");
    expect(source).toContain("mergeable,mergeStateStatus");
    expect(source).toContain("reviewThreads(first: 50");
    expect(source).toContain("async function resolvePushTarget");
    expect(source).toContain("\"remote\", \"get-url\", \"--push\", \"--all\"");
    expect(source).toContain("single validated push URL");
    expect(source).toContain("owner/repo slug");
    expect(source).toContain("async function syncAfterPush");
    expect(source).toContain("async function sleepUntilDeadline");
    expect(source).toContain("Math.min(pollIntervalSeconds * 1_000, remainingMs)");
    expect(source).toContain("pushedCommitSha");
    expect(source).toContain("current.checks.observed && current.checks.state !== \"pending\"");
    expect(source).toContain("No CI check records appeared for the pushed commit");
    expect(source).toContain("await syncAfterPush(parsed.identity, commit.sha");
  });

  test("source confirms push access before remediation and never fakes PR metadata", () => {
    const source = babysitSource();
    expect(source).toContain("async function confirmPushAccessForPrHead");
    expect(source).toContain('"push", "--dry-run", "--porcelain"');
    expect(source).toContain('"push", "--dry-run", "--porcelain", "--no-verify"');
    expect(source).toContain('await verifyLocalHeadMatchesPrHead(cwd, state, "confirmPushAccessForPrHead")');
    expect(source).not.toContain("push_accessible: true,\n    review_decision");
    expect(source).toContain("prState = { ...prState, push_accessible: true }");
    expect(source).toContain("push_pr_fixes refused to push because push access was not confirmed");

    const confirmIndex = source.indexOf("confirmPushAccessForPrHead(workflowCwd, prState)");
    const taskIndex = source.indexOf("ctx.task(`remediate-pr-iteration");
    const commitIndex = source.indexOf("commitPrFixes(workflowCwd");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(taskIndex).toBeGreaterThan(confirmIndex);
    expect(commitIndex).toBeGreaterThan(taskIndex);
  });

  test("source disables local hooks for commit and push, and verifies parent-owned commit trees", () => {
    const source = babysitSource();
    expect(source).toContain("async function gitWithLocalAutomationDisabled");
    expect(source).toContain("core.hooksPath=${hooksPath}");
    expect(source).toContain('"commit.gpgSign=false"');
    expect(source).toContain('"commit", "--no-verify", "-m", message');
    expect(source).toContain('"push", "--no-verify"');
    expect(source).toContain("const expectedTree = await git([\"write-tree\"]");
    expect(source).toContain("HEAD^{tree}");
    expect(source).toContain("selectively staged remediation tree");
  });

  test("source handles remediation child failures before receipt parsing and ownership", () => {
    const source = babysitSource();
    expect(source).toContain("Remediation child failed before the receipt gate.");
    expect(source).toContain("await access(remediationPath)");
    const childFailureIndex = source.indexOf("Remediation child failed before the receipt gate.");
    const parseIndex = source.indexOf("parseRemediationReceipt(remediationPath)");
    const ownershipIndex = source.indexOf("collectOwnedRemediationPaths(workflowCwd");
    expect(childFailureIndex).toBeGreaterThan(-1);
    expect(parseIndex).toBeGreaterThan(childFailureIndex);
    expect(ownershipIndex).toBeGreaterThan(parseIndex);
  });

  test("source validates remediation receipt outcome and addressed IDs before ownership collection", () => {
    const source = babysitSource();
    expect(source).toContain("validateRemediationReceiptOutcome");
    expect(source).toContain("validate_remediation_receipt_outcome rejected");
    expect(source).toContain("validate_receipt_addressed_comment_signal_ids rejected");
    expect(source).toContain("addressed_comment_signal_ids array is only for top-level PR comment or review-summary comment_signal IDs");
    expect(source).toContain("Omit addressed_comment_signal_ids or use [] when no top-level comment/review-summary signal was addressed");
    const validateIndex = source.indexOf("validateRemediationReceiptOutcome(remediationReceipt)");
    const addressedIndex = source.indexOf("validateReceiptAddressedCommentSignalIds(prState, remediationReceipt)");
    const ownershipIndex = source.indexOf("collectOwnedRemediationPaths(workflowCwd");
    expect(validateIndex).toBeGreaterThan(-1);
    expect(addressedIndex).toBeGreaterThan(validateIndex);
    expect(ownershipIndex).toBeGreaterThan(addressedIndex);
  });

  test("source feeds raw unredacted command output to parsers", () => {
    const source = babysitSource();
    expect(source).toContain("async function commandRaw");
    expect(source).toContain("async function ghRaw");
    expect(source).toContain("JSON.parse(await ghRaw(args, cwd))");
    expect(source).toContain('return await gitRaw(["remote", "get-url", "origin"], cwd)');
    expect(source).toContain('gitRaw(["remote", "get-url", "--push", "--all", remote]');
    expect(source).not.toContain("JSON.parse(await gh(args, cwd))");
  });

  test("source models top-level PR comments and review summaries as comment signals", () => {
    const source = babysitSource();
    expect(source).toContain("function topLevelCommentSignals");
    expect(source).toContain("function stableCommentSignalId");
    expect(source).toContain("text(record.id) || text(record.node_id) || text(record.databaseId) || text(record.url)");
    expect(source).toContain('state === "COMMENTED"');
    expect(source).toContain("actionableFeedbackText(body)");
    expect(source).not.toContain("function actionableCommentText");
    expect(source).toContain("review_threads: inlineReviewThreads");
    expect(source).toContain("comment_signals: topLevelCommentSignals(view)");
    expect(source).not.toContain("topLevelReviewFeedback");
  });

  test("source tracks only receipt-listed addressed top-level comment signals after successful pushes", () => {
    const source = babysitSource();
    expect(source).toContain("addressed_comment_signal_ids");
    expect(source).toContain("const addressedCommentSignalIds = new Set<string>()");
    expect(source).toContain("function withAddressedCommentSignals");
    expect(source).toContain("function markReceiptCommentSignalsAddressed");
    expect(source).toContain("validateReceiptAddressedCommentSignalIds(prState, remediationReceipt)");
    expect(source).toContain("validatedAddressedCommentSignalIds = addressedValidation.addressed_comment_signal_ids");
    expect(source).toContain("markReceiptCommentSignalsAddressed(validatedAddressedCommentSignalIds, addressedCommentSignalIds)");
    expect(source).toContain("postPushState = withAddressedCommentSignals(await syncAfterPush");
    expect(source).not.toContain("function markActionableCommentSignalsAddressed");
    expect(source).not.toContain("markActionableCommentSignalsAddressed(prState, addressedCommentSignalIds)");
  });

  test("source records final needs_human when post-push sync throws", () => {
    const source = babysitSource();
    expect(source).toContain("Post-push sync failed after a successful push.");
    expect(source).toContain("Pushed commit ${commit.sha}");
    expect(source).toContain("sync-after-push-failed");
  });

  test("source gates child remediation commits before parsing receipts or pushing", () => {
    const source = babysitSource();
    expect(source).toContain("parentHeadBeforeRemediation = await verifyLocalHeadMatchesPrHead");
    expect(source).toContain("parentHeadAfterRemediation = await git([\"rev-parse\", \"HEAD\"]");
    expect(source).toContain("refusing to parse, stage, commit, or push");
    expect(source).toContain("Do not run git commit, git push, git reset, git rebase");
    expect(source).toContain("commitPrFixes(workflowCwd, iteration, ownedRemediationPaths, prState.head_sha)");
    expect(source).toContain("commit_pr_fixes refused to continue because HEAD changed");
  });

  test("source verifies PR head ancestry and parent-owned push commits", () => {
    const source = babysitSource();
    expect(source).toContain("async function verifyLocalHeadMatchesPrHead");
    expect(source).toContain("latest observed PR headRefOid");
    expect(source).toContain("readonly parentSha: string");
    expect(source).toContain("commit.parentSha !== state.head_sha");
    expect(source).toContain("local HEAD ${currentHead} is not the parent-owned remediation commit");
  });

  test("source preserves exact raw stdout separately for NUL-delimited git porcelain", () => {
    const source = babysitSource();
    expect(source).toContain("rawStdout?: boolean");
    expect(source).toContain("readonly rawStdout?: string");
    expect(source).toContain("rawStdout: stdout");
    expect(source).toContain("async function gitRaw");
    expect(source).toContain("rawStdout ?? \"\"");
    expect(source).toContain("gitRaw([\"status\", \"--porcelain=v1\", \"-z\"");
    expect(source).toContain("gitRaw([\"diff\", \"--cached\", \"--name-only\", \"-z\"]");
    expect(source).not.toContain("parseGitStatusPorcelain(await git([\"status\", \"--porcelain=v1\", \"-z\"");
    expect(source).not.toContain("redactCommandOutput(options.rawStdout ? stdout");
  });

  test("source registers artifacts only after successful writes", () => {
    const source = babysitSource();
    expect(source).toContain("writeRegisteredJsonArtifact");
    expect(source).toContain("writeRegisteredMarkdownArtifact");
    expect(source).toContain("sync-pr-state-failed");
    expect(source).not.toContain("receiptArtifact: remediationReceiptPath");
    expect(source).not.toContain("ownedPathsArtifact: ownedPathsPath");
    expect(source).not.toContain("pushTargetArtifact: pushTargetPath");
  });

  test("source records canonical PR URLs instead of raw PR input in artifacts", () => {
    const source = babysitSource();
    expect(source).toContain("const recordedInput = { pr: prUrl");
    expect(source).toContain("input: recordedInput");
    expect(source).not.toContain("input: { pr: prInput }");
    expect(source).not.toContain("input: { pr: prInput, max_iterations");
  });

  test("workflows README uses organization install URLs", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("git:github.com/bastani-inc/atomic-workflows");
    expect(readme).not.toContain("git:github.com/lavaman131/atomic-workflows");
  });

  test("README documents safety boundaries and reports", () => {
    const readme = babysitReadme();
    expect(readme).toContain("push_pr_fixes");
    expect(readme).toContain("does not merge");
    expect(readme).toContain("needs_human");
    expect(readme).toContain("Empty or absent check data is never treated as green");
    expect(readme).toContain("Actionable top-level PR comments and review summaries are first-class");
    expect(readme).toContain("marks only validated receipt-listed stable signal IDs addressed for the current workflow run");
    expect(readme).toContain("before `gh pr checkout`");
    expect(readme).toContain("`addressed_comment_signal_ids` may be omitted or `[]`");
    expect(readme).toContain("Required checks are preferred where they are discoverable");
    expect(readme).toContain("visible optional failures, pending checks, or unknown check states");
    expect(readme).toContain("GitHub `statusCheckRollup`");
    expect(readme).toContain("Parser-facing command stdout is kept exact and unredacted");
    expect(readme).toContain("local hooks and commit signing disabled");
    expect(readme).toContain("Push preflights and real pushes use `--no-verify`");
    expect(readme).toContain("babysit-pr/");
    expect(readme).toContain(".babysit-pr-");
  });

  test("normalizes bounded numeric inputs", () => {
    expect(normalizeBoundedInteger(5.9, { min: 1, max: 10, fallback: 3 })).toBe(5);
    expect(normalizeBoundedInteger("6", { min: 1, max: 10, fallback: 3 })).toBe(6);
    expect(normalizeBoundedInteger(0, { min: 1, max: 10, fallback: 3 })).toBe(3);
    expect(normalizeBoundedInteger(99, { min: 1, max: 10, fallback: 3 })).toBe(3);
  });
});
