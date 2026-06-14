import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, mock, test } from "bun:test";
import {
  gateChildRunCompletion,
  parseEvidenceFromText,
  reviewArtifactToEvidenceText,
} from "./lib/review-evidence.ts";
import {
  buildChildHandoff,
  datedMarkdownPath,
  displayPath,
  loadSavedStageReport,
  missingReviewCriteria,
  normalizeCreatePr,
  parseApprovalDecision,
  reduceReviewEvidence,
  resolveEffectiveWorktreeRoot,
  resolveMode,
  resolveRunner,
  slugifyTopic,
  writeMarkdown,
} from "./helpers.ts";

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const workflowSource = () => readFixture("./index.ts");
const workflowReadme = () => readFixture("./README.md");
const registryReadme = () => readFixture("../README.md");
const rootReadme = () => readFixture("../../README.md");
const rootGitignore = () => readFixture("../../.gitignore");

async function gitInit(cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "init"], { cwd, stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git init failed in ${cwd}`);
}

function structuredEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    independent: { satisfied: true, evidence: "Child internal reviewer ran independently after implementation.", source: "child internal review" },
    acceptance_mapped: { satisfied: true, evidence: "Child mapped each approved acceptance criterion to implemented changes." },
    diff_aware: { satisfied: true, evidence: "Child inspected git diff and changed files before approval." },
    validation_backed: {
      satisfied: true,
      evidence: "Validation completed successfully.",
      commands: [{ command: "bun test", exit_code: 0, summary: "bun test passed" }],
    },
    risk_aware: { satisfied: true, evidence: "Child documented residual risks after review." },
    fresh: { satisfied: true, evidence: "Evidence was collected after the final diff/latest change." },
    severity_counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
    ...overrides,
  };
}

function structuredEvidenceReport(evidence: Record<string, unknown> = structuredEvidence()): string {
  return [
    "Independent separate reviewer mapped acceptance criteria against the approved spec.",
    "Inspected git diff and changed files.",
    "Validation commands run: bun test passed.",
    "Residual risk review completed.",
    "Fresh after final diff.",
    "P0: none",
    "P1: no findings",
    "",
    "```json",
    JSON.stringify({ review_evidence: evidence }, null, 2),
    "```",
  ].join("\n");
}

function proseOnlySufficientReviewReport(): string {
  return [
    "Independent separate reviewer mapped acceptance criteria against the approved spec.",
    "Inspected git diff and changed files.",
    "Validation commands run: bun test passed.",
    "Residual risk review completed.",
    "Fresh after final diff.",
    "P0: none",
    "P1: no findings",
  ].join("\n");
}

function sufficientReviewReport(): string {
  return structuredEvidenceReport();
}

function nativeReviewRoundReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    iteration: 2,
    reviews: [
      {
        reviewer: "native-reviewer",
        artifact_path: "/tmp/native-review.json",
        decision: {
          overall_correctness: "patch is correct",
          stop_review_loop: true,
          findings: [],
        },
      },
    ],
    ...overrides,
  });
}

type MockSchema = Record<string, unknown>;
type MockTypeOptions = Record<string, unknown>;

function mockSchema(type: string, options: MockTypeOptions = {}): MockSchema {
  return { type, ...options };
}

const Type = {
  String: (options?: MockTypeOptions): MockSchema => mockSchema("string", options),
  Number: (options?: MockTypeOptions): MockSchema => mockSchema("number", options),
  Integer: (options?: MockTypeOptions): MockSchema => mockSchema("integer", options),
  Boolean: (options?: MockTypeOptions): MockSchema => mockSchema("boolean", options),
  Null: (options?: MockTypeOptions): MockSchema => mockSchema("null", options),
  Literal: (value: unknown): MockSchema => ({ const: value }),
  Union: (variants: MockSchema[], options: MockTypeOptions = {}): MockSchema => ({ anyOf: variants, ...options }),
  Object: (properties: Record<string, MockSchema>, options: MockTypeOptions = {}): MockSchema => ({ type: "object", properties, ...options }),
  Array: (items: MockSchema, options: MockTypeOptions = {}): MockSchema => ({ type: "array", items, ...options }),
  Optional: (schema: MockSchema): MockSchema => ({ ...schema, optional: true }),
};

mock.module("@bastani/workflows/builtin", () => ({
  deepResearchCodebase: Object.freeze({ name: "deep-research-codebase" }),
  goal: Object.freeze({ name: "goal" }),
  ralph: Object.freeze({ name: "ralph" }),
}));

mock.module("@bastani/workflows", () => ({
  Type,
  defineWorkflow(name: string) {
    const state: { description?: string; inputs: Record<string, MockSchema>; outputs: Record<string, MockSchema>; run?: unknown; worktree?: unknown } = {
      inputs: {},
      outputs: {},
    };
    const builder = {
      description(value: string) {
        state.description = value;
        return builder;
      },
      input(key: string, schema: MockSchema) {
        state.inputs[key] = schema;
        return builder;
      },
      output(key: string, schema: MockSchema) {
        state.outputs[key] = schema;
        return builder;
      },
      worktreeFromInputs(value: unknown) {
        state.worktree = value;
        return builder;
      },
      run(fn: unknown) {
        state.run = fn;
        return builder;
      },
      compile() {
        return Object.freeze({ name, ...state });
      },
    };
    return builder;
  },
}));

const workflowModulePromise = import("./index.ts");
const workflowPromise = workflowModulePromise.then((module) => module.default as {
  name: string;
  inputs: Record<string, MockSchema>;
  outputs: Record<string, MockSchema>;
  worktree?: unknown;
  run: (ctx: unknown) => Promise<Record<string, unknown>>;
});

describe("compound-engineering mode routing", () => {
  test("explicit modes are preserved", () => {
    expect(resolveMode("anything", "review")).toBe("review");
    expect(resolveMode("anything", "compound-only")).toBe("compound-only");
  });

  test("auto routes path, review, learning, vague, and concrete prompts", () => {
    expect(resolveMode("specs/2026-06-05-rate-limit.md", "auto")).toBe("work");
    expect(resolveMode("docs/plans/2026-06-05-rate-limit.md", "auto")).toBe("work");
    expect(resolveMode("docs/brainstorms/onboarding.md", "auto")).toBe("plan");
    expect(resolveMode("main..feature/auth", "auto")).toBe("review");
    expect(resolveMode("Capture lessons learned from the rate limit fix", "auto")).toBe("compound-only");
    expect(resolveMode("Improve onboarding activation", "auto")).toBe("brainstorm");
    expect(resolveMode("Fix auth bug", "auto")).toBe("work");
    expect(resolveMode("Add API tests", "auto")).toBe("work");
    expect(resolveMode("Fix CLI config", "auto")).toBe("work");
    expect(resolveMode("Implement the TypeScript CLI config parser and add tests", "auto")).toBe("work");
  });
});

describe("compound-engineering runner and approval helpers", () => {
  test("auto runner resolves to safe handoff-only for iteration 3 and explicit runners are preserved", () => {
    expect(resolveRunner("auto")).toBe("handoff-only");
    expect(resolveRunner("goal")).toBe("goal");
    expect(resolveRunner("ralph")).toBe("ralph");
    expect(resolveRunner("handoff-only")).toBe("handoff-only");
  });

  test("approval parser recognizes approve, reject, revise, and stop intents", () => {
    expect(parseApprovalDecision("Approved, proceed")).toBe("approved");
    expect(parseApprovalDecision("LGTM ship it")).toBe("approved");
    expect(parseApprovalDecision("reject this scope")).toBe("rejected");
    expect(parseApprovalDecision("please revise validation")).toBe("revise");
    expect(parseApprovalDecision("cancel for now")).toBe("stopped");
    expect(parseApprovalDecision("not sure yet")).toBe("revise");
  });

  test("create_pr is strict true only and child handoff inputs default safely", () => {
    expect(normalizeCreatePr(true)).toBe(true);
    expect(normalizeCreatePr("true")).toBe(false);
    expect(normalizeCreatePr(1)).toBe(false);

    const ralphHandoff = buildChildHandoff({
      runner: "ralph",
      approvedPath: "specs/approved.md",
      prompt: "Implement the approved spec",
      maxLoops: 5,
      baseBranch: "origin/main",
      gitWorktreeDir: "",
      createPr: false,
    });

    expect(ralphHandoff.workflow).toBe("ralph");
    expect(ralphHandoff.inputs.create_pr).toBe(false);
    expect(ralphHandoff.inputs.max_loops).toBe(5);
    expect(ralphHandoff.inputs.base_branch).toBe("origin/main");
    expect(ralphHandoff.command).toContain("/workflow ralph");
    expect(ralphHandoff.safe_note).toContain("explicit goal/ralph");

    const goalHandoff = buildChildHandoff({
      runner: "goal",
      approvedPath: "specs/approved.md",
      prompt: "Implement the approved spec",
      maxLoops: 5,
      baseBranch: "origin/main",
      gitWorktreeDir: "ignored-for-goal",
      createPr: true,
    });
    expect(goalHandoff.inputs).toMatchObject({
      max_turns: 5,
      base_branch: "origin/main",
    });
    expect(goalHandoff.inputs.objective).toContain("Implement the approved Compound Engineering plan/spec at specs/approved.md. Original request: Implement the approved spec");
    expect(goalHandoff.inputs.objective).toContain("review_evidence");
    expect(goalHandoff.inputs.objective).not.toContain("compound_engineering_evidence");
    expect(goalHandoff.command).toContain("/workflow goal");
    expect(goalHandoff.command).toContain("max_turns=5");

    const handoffOnly = buildChildHandoff({
      runner: "handoff-only",
      approvedPath: "specs/approved.md",
      prompt: "Implement the approved spec",
      maxLoops: 5,
      baseBranch: "origin/main",
      gitWorktreeDir: "",
      createPr: true,
    });
    expect(handoffOnly.workflow).toBe("handoff-only");
    expect(handoffOnly.inputs.create_pr).toBe(false);
    expect(handoffOnly.command).toBeUndefined();
  });
});

describe("compound-engineering child completion and review artifact gates", () => {
  test("child completion gate vetoes non-approval statuses and missing approval", async () => {

    expect(gateChildRunCompletion({ approved: false }, "ralph")).toMatchObject({ state: "non_approved", parent_status: "needs_human" });
    for (const status of ["needs_human", "rejected", "stopped", "active"] as const) {
      expect(gateChildRunCompletion({ approved: true, status }, "goal")).toMatchObject({ state: "non_approved", parent_status: "needs_human", status });
    }
    for (const status of ["blocked", "failed", "failure", "error", "errored"] as const) {
      expect(gateChildRunCompletion({ approved: true, status }, "goal")).toMatchObject({ state: "blocked", parent_status: "blocked", status });
    }
    expect(gateChildRunCompletion({ status: "complete" }, "goal")).toMatchObject({ state: "missing_approval", parent_status: "needs_human" });
    expect(gateChildRunCompletion({ approved: true, status: "mystery" }, "goal")).toMatchObject({ state: "non_approved", parent_status: "needs_human" });
    expect(gateChildRunCompletion({ approved: true }, "goal")).toMatchObject({ state: "missing_approval", parent_status: "needs_human" });
    expect(gateChildRunCompletion({ approved: true }, "ralph")).toMatchObject({ state: "approved" });
    expect(gateChildRunCompletion({ approved: true, status: "complete" }, "goal")).toMatchObject({ state: "approved" });
  });

  test("empty prompt guard uses ctx.exit before creating artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-empty-exit-"));
    const workflow = await workflowPromise;
    try {
      let exitPayload: Record<string, unknown> | undefined;
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "   ",
          mode: "auto",
          runner: "auto",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async () => ({ text: "should not run" }),
        workflow: async () => ({}),
        exit: (payload: Record<string, unknown>) => {
          exitPayload = payload;
          return (payload.outputs ?? {}) as Record<string, unknown>;
        },
      });

      expect(exitPayload).toMatchObject({ status: "blocked", reason: "Blocked: prompt is required." });
      expect(result).toMatchObject({ status: "blocked", approved: false, artifact_dir: "", manifest_path: "" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("child exited guard preserves Atomic exit status while keeping domain status schema-compatible", async () => {
    const cases: Array<{ name: string; childResult: Record<string, unknown>; exitStatus: string; domainStatus: string; exitReason: string }> = [
      { name: "cancelled", childResult: { exited: true, status: "cancelled", reason: "user cancelled" }, exitStatus: "cancelled", domainStatus: "stopped", exitReason: "user cancelled" },
      { name: "skipped", childResult: { exited: true, exit: { status: "skipped", reason: "precondition skipped" } }, exitStatus: "skipped", domainStatus: "stopped", exitReason: "precondition skipped" },
      { name: "blocked", childResult: { exited: true, status: "blocked", reason: "child blocked" }, exitStatus: "blocked", domainStatus: "blocked", exitReason: "child blocked" },
      { name: "exit-reason-precedence", childResult: { exited: true, status: "blocked", exitReason: "top Atomic exitReason", reason: "alias reason", exit_reason: "snake alias reason", exit: { reason: "nested reason" } }, exitStatus: "blocked", domainStatus: "blocked", exitReason: "top Atomic exitReason" },
      { name: "reason-precedence", childResult: { exited: true, status: "blocked", reason: "top reason", exit_reason: "snake alias reason", exit: { reason: "nested reason" } }, exitStatus: "blocked", domainStatus: "blocked", exitReason: "top reason" },
      { name: "snake-precedence", childResult: { exited: true, status: "blocked", exit_reason: "snake alias reason", exit: { reason: "nested reason" } }, exitStatus: "blocked", domainStatus: "blocked", exitReason: "snake alias reason" },
      { name: "unknown", childResult: { exited: true, outputs: { approved: true, status: "complete", review_report: sufficientReviewReport() } }, exitStatus: "blocked", domainStatus: "blocked", exitReason: "goal child workflow exited before returning declared completion evidence." },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-child-exited-${testCase.name}-`));
      const workflow = await workflowPromise;
      try {
        let exitPayload: Record<string, unknown> | undefined;
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => testCase.childResult,
          exit: (payload: Record<string, unknown>) => {
            exitPayload = payload;
            return (payload.outputs ?? {}) as Record<string, unknown>;
          },
        });

        expect(exitPayload).toMatchObject({ status: testCase.exitStatus, reason: testCase.exitReason });
        expect(result.status).toBe(testCase.domainStatus);
        expect((result.implementation as Record<string, unknown>).child_exited).toBe(true);
        expect((result.implementation as Record<string, unknown>).gate_child_run_completion).toMatchObject({
          state: "child_exited",
          parent_status: testCase.domainStatus,
          exited: true,
          exit_status: testCase.exitStatus,
          reason: testCase.exitReason,
          exit_reason: testCase.exitReason,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("implementation receipt schema allows null leaves and array items", async () => {
    const workflow = await workflowPromise;
    const implementation = workflow.outputs.implementation;
    const variants = implementation.anyOf as MockSchema[];
    const childReceipt = variants.find((variant) => ((variant.properties as Record<string, MockSchema>).kind as MockSchema).const === "child_workflow_receipt") as MockSchema;
    const outputs = ((childReceipt.properties as Record<string, MockSchema>).outputs as MockSchema);
    const leaf = outputs.additionalProperties as MockSchema;
    const leafVariants = leaf.anyOf as MockSchema[];
    const arrayVariant = leafVariants.find((variant) => variant.type === "array") as MockSchema;
    const arrayItemVariants = ((arrayVariant.items as MockSchema).anyOf as MockSchema[]);

    expect(leafVariants.some((variant) => variant.type === "null")).toBe(true);
    expect(arrayItemVariants.some((variant) => variant.type === "null")).toBe(true);
  });

  test("implementation receipt preserves declared nulls and compacted array nulls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-receipt-null-"));
    const workflow = await workflowPromise;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            approved: true,
            status: "complete",
            ledger_path: null,
            remaining_work: [null, Number.POSITIVE_INFINITY, undefined, () => "ignored", Symbol("ignored"), "done"],
            review_report: sufficientReviewReport(),
          },
        }),
      });

      expect(result.status).toBe("complete");
      const outputs = ((result.implementation as Record<string, unknown>).outputs as Record<string, unknown>);
      expect(outputs.ledger_path).toBeNull();
      expect(outputs.remaining_work).toEqual([null, null, null, null, null, "done"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("supplemental review cannot override child approved false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-child-veto-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const sufficientReport = sufficientReviewReport();
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, sufficientReport);
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: false, status: "needs_human", review_report: sufficientReport } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("needs_human");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("child completion gate");
      expect((result.implementation as Record<string, unknown>).gate_child_run_completion).toMatchObject({ state: "non_approved" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("child review_report_path is loaded before inline compact review_report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-child-review-path-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const reviewPath = join(dir, "ralph-review.json");
      await writeFile(reviewPath, JSON.stringify({
        reviewer: "ralph",
        review_evidence: structuredEvidence(),
      }), "utf8");

      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, review_report_path: reviewPath, review_report: "Output saved to: /tmp/compact.md" } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("complete");
      expect(result.review_report_path).toBe(displayPath(reviewPath));
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({ source: "review_report_path", loaded: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("compact child review pointer with missing path fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-child-pointer-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, review_report_path: join(dir, "missing-review.json"), review_report: "Output saved to: /tmp/compact.md" } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("blocked");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("review evidence gate returned blocked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Ralph latest review artifact pointer is not inline evidence when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-ralph-pointer-missing-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const missingReviewPath = join(dir, "missing-ralph-review.json");
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, sufficientReviewReport());
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, status: "complete", review_report: `Latest review round artifact: ${missingReviewPath}` } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("blocked");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("review evidence gate returned blocked");
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({ compact_pointer: true, loaded: false, fail_closed: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Ralph latest review artifact pointer loads referenced artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-ralph-pointer-loaded-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const reviewPath = join(dir, "ralph-review.md");
      await writeFile(reviewPath, sufficientReviewReport(), "utf8");
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, status: "complete", review_report: `Latest review round artifact: ${reviewPath}` } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("complete");
      expect(result.review_report_path).toBe(displayPath(reviewPath));
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({ source: "inline_review_report_pointer", compact_pointer: true, loaded: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Latest review round artifact pointer with spaces loads referenced artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound engineering latest pointer "));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const reviewDir = join(dir, "review folder with spaces");
      await mkdir(reviewDir, { recursive: true });
      const reviewPath = join(reviewDir, "ralph review artifact.md");
      await writeFile(reviewPath, sufficientReviewReport(), "utf8");
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, status: "complete", review_report: `Latest review round artifact: ${reviewPath}` } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("complete");
      expect(result.review_report_path).toBe(displayPath(reviewPath));
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({
        source: "inline_review_report_pointer",
        path: reviewPath,
        compact_pointer: true,
        pointer_kind: "latest_review_round_artifact",
        loaded: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Output saved to pointer with spaces and Atomic suffix loads referenced artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound engineering output pointer "));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const reviewDir = join(dir, "review folder with spaces");
      await mkdir(reviewDir, { recursive: true });
      const reviewPath = join(reviewDir, "saved review artifact.md");
      await writeFile(reviewPath, sufficientReviewReport(), "utf8");
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, status: "complete", review_report: `Output saved to: ${reviewPath} (48.2 KB, 2847 lines). Read this file if needed.` } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("complete");
      expect(result.review_report_path).toBe(displayPath(reviewPath));
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({
        source: "inline_review_report_pointer",
        path: reviewPath,
        compact_pointer: true,
        pointer_kind: "output_saved_to",
        loaded: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing compact pointer path with spaces fails closed and traces full path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound engineering missing pointer "));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const missingReviewPath = join(dir, "missing review artifact with spaces.md");
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, sufficientReviewReport());
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { approved: true, status: "complete", review_report: `Saved output to: ${missingReviewPath}` } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("blocked");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("review evidence gate returned blocked");
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({
        source: "inline_review_report_pointer",
        path: missingReviewPath,
        compact_pointer: true,
        pointer_kind: "output_saved_to",
        loaded: false,
        fail_closed: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing child review report fails closed without parsing generic result self-attestation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-missing-child-review-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, sufficientReviewReport());
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: sufficientReviewReport(),
            approved: true,
          },
        }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("blocked");
      expect(result.approved).toBe(false);
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child_review_artifact).toMatchObject({
        source: "missing_child_review_report",
        loaded: false,
        fail_closed: true,
      });
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).child).toMatchObject({ blocked: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("implementation receipt and final report omit raw child plan ledger and receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-compact-child-output-"));
    const workflow = await workflowPromise;
    try {
      const rawPlanSentinel = "RAW-PLAN-SENTINEL";
      const rawLedgerSentinel = "RAW-LEDGER-SENTINEL";
      const rawReceiptSentinel = "RAW-RECEIPT-SENTINEL";
      const ledgerPath = join(dir, "goal-ledger.json");
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            approved: true,
            status: "complete",
            review_report: sufficientReviewReport(),
            review_report_path: undefined,
            ledger_path: ledgerPath,
            plan: `${rawPlanSentinel} ${"x".repeat(4096)}`,
            ledger: { details: rawLedgerSentinel },
            receipts: [{ details: rawReceiptSentinel }],
          },
        }),
      });

      expect(result.status).toBe("complete");
      const implementation = result.implementation as Record<string, unknown>;
      const outputs = implementation.outputs as Record<string, unknown>;
      expect(outputs).not.toHaveProperty("ledger_path");
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(outputs).not.toHaveProperty("raw");
      expect(outputs).not.toHaveProperty("plan");
      expect(outputs).not.toHaveProperty("ledger");
      expect(outputs).not.toHaveProperty("receipts");
      expect(outputs.unknown_child_output_keys).toEqual(expect.arrayContaining(["ledger", "ledger_path", "receipts", "status"]));
      expect(outputs.omitted_inline_child_output_keys).toEqual(expect.arrayContaining(["plan"]));
      expect(JSON.stringify(result)).not.toContain(rawPlanSentinel);
      expect(JSON.stringify(result)).not.toContain(rawLedgerSentinel);
      expect(JSON.stringify(result)).not.toContain(rawReceiptSentinel);

      const manifest = JSON.parse(await readFile(result.manifest_path as string, "utf8"));
      const finalReport = await readFile(manifest.finalReportPath, "utf8");
      expect(finalReport).not.toContain(rawPlanSentinel);
      expect(finalReport).not.toContain(rawLedgerSentinel);
      expect(finalReport).not.toContain(rawReceiptSentinel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("implementation receipt compacting sanitizes non-JSON primitives and cycles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-json-safe-child-output-"));
    const workflow = await workflowPromise;
    try {
      const cyclic: Record<string, unknown> = { kept_path: "/tmp/validation.log", nested: { command: "bun test" } };
      cyclic.self = cyclic;
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: 123n,
            approved: true,
            artifact_dir: "/tmp/child-artifacts",
            review_report: sufficientReviewReport(),
            validation_output: cyclic,
            changed_files: ["src/index.ts", undefined, Symbol("skip"), () => "skip", Number.POSITIVE_INFINITY, Number.NaN, 7n],
          },
        }),
      });

      expect(result.status).toBe("complete");
      expect(() => JSON.stringify(result)).not.toThrow();
      const outputs = ((result.implementation as Record<string, unknown>).outputs as Record<string, unknown>);
      expect(outputs.result).toBe("123");
      expect(outputs).not.toHaveProperty("artifact_dir");
      expect(outputs).not.toHaveProperty("validation_output");
      expect(outputs).not.toHaveProperty("changed_files");
      expect(outputs.unknown_child_output_keys).toEqual(expect.arrayContaining(["artifact_dir", "changed_files", "validation_output"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("implementation receipt caps wide selected child output objects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-wide-child-output-"));
    const workflow = await workflowPromise;
    try {
      const omittedValueSentinel = "OMITTED-WIDE-VALIDATION-VALUE";
      const validationOutput = Object.fromEntries(Array.from({ length: 60 }, (_value, index) => [
        `key_${String(index).padStart(2, "0")}`,
        index === 55 ? omittedValueSentinel : `value_${index}`,
      ]));

      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "ralph",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            approved: true,
            status: "complete",
            review_report: sufficientReviewReport(),
            validation_output: validationOutput,
          },
        }),
      });

      expect(result.status).toBe("complete");
      expect(() => JSON.stringify(result)).not.toThrow();
      const outputs = ((result.implementation as Record<string, unknown>).outputs as Record<string, unknown>);
      expect(outputs).not.toHaveProperty("validation_output");
      expect(outputs.unknown_child_output_keys).toEqual(expect.arrayContaining(["status", "validation_output"]));
      expect(JSON.stringify(result)).not.toContain(omittedValueSentinel);

      const manifest = JSON.parse(await readFile(result.manifest_path as string, "utf8"));
      const finalReport = await readFile(manifest.finalReportPath, "utf8");
      expect(finalReport).not.toContain(omittedValueSentinel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("compound-engineering review evidence parser and reducer", () => {
  test("severity parser ignores empty headings and counts real finding lines", async () => {
    const evidence = parseEvidenceFromText([
      "## P0",
      "P0: none",
      "P1: no findings",
      "P0: none found",
      "P1: none identified",
      "P0: none reported",
      "P1: no issues",
      "P1: no blockers",
      "- none",
      "### P2",
      "- P1: data loss bug",
      "[P0] deletes user data",
      "p2 - issue in fallback",
      "P3: small docs nit",
    ].join("\n"));

    expect(evidence.severity_counts).toEqual({ p0: 1, p1: 1, p2: 1, p3: 1 });
  });

  test("validation availability alone does not satisfy validation-backed evidence", async () => {
    const evidence = parseEvidenceFromText([
      "Independent separate reviewer mapped acceptance criteria against the approved spec.",
      "Inspected git diff and changed files.",
      "Validation commands available: bun test.",
      "Residual risk review completed.",
      "Fresh after final diff.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));

    expect(evidence.validation_failed).toBe(false);
    expect(evidence.validation_backed).toBeUndefined();
    expect(reduceReviewEvidence(evidence).missing).toContain("validation_backed");
    expect(reduceReviewEvidence(evidence).decision).not.toBe("sufficient");
  });

  test("bare validation execution wording does not satisfy validation-backed evidence", async () => {
    const evidence = parseEvidenceFromText([
      "Independent separate reviewer mapped acceptance criteria against the approved spec.",
      "Inspected git diff and changed files.",
      "Validation commands run: bun test.",
      "Residual risk review completed.",
      "Fresh after final diff.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));
    const reduction = reduceReviewEvidence(evidence);

    expect(evidence.validation_failed).toBe(false);
    expect(evidence.validation_backed).toBeUndefined();
    expect(reduction.missing).toContain("validation_backed");
    expect(reduction.decision).not.toBe("sufficient");
  });

  test("negated validation success wording fails closed before success matching", async () => {
    const negatedSuccessLines = [
      "Validation commands run: bun test not successful.",
      "Validation commands run: bun test not passed.",
      "Validation commands run: bun test. Not successful.",
      "Validation commands run: not all tests passed.",
      "Validation commands run: bun test. Not all tests passed.",
    ];

    for (const line of negatedSuccessLines) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));
      const reduction = reduceReviewEvidence(evidence);

      expect(evidence.validation_failed).toBe(true);
      expect(evidence.validation_backed).toBe(false);
      expect(reduction.decision).not.toBe("sufficient");
    }
  });

  test("validation no-run wording fails closed instead of satisfying validation evidence", async () => {
    const noRunLines = [
      "Validation commands run: none.",
      "Validation commands run: no commands.",
      "Validation commands run: zero.",
      "Tests run: none.",
      "No validation commands were run.",
      "No validation was run.",
      "No validation ran.",
      "No tests were run.",
      "Validation skipped.",
    ];

    for (const line of noRunLines) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));
      const reduction = reduceReviewEvidence(evidence);

      expect(evidence.validation_failed).toBe(false);
      expect(evidence.validation_backed).toBe(false);
      expect(reduction.missing).toContain("validation_backed");
      expect(reduction.decision).not.toBe("sufficient");
    }
  });

  test("failed validation outcomes set validation_failed and cannot satisfy validation evidence", async () => {
    const failureLines = [
      "Validation commands run: bun test did not pass.",
      "Validation commands run: bun test reported 2 failures.",
      "Validation commands run: bun test reported 3 errors.",
      "bun test failed.",
      "Validation command exited with exit code 1.",
      "Validation command exited with code 1.",
      "Validation command exited with status 2.",
      "Validation command returned code 3.",
      "Validation command returned status 4.",
      "Validation command status: 2.",
      "Validation command code: 1.",
      "Validation command exit code: 1.",
      "Validation command exit status: 5.",
      "Validation command failed with exit status 5.",
      "Tests completed with nonzero status.",
      "Validation command returned non-zero exit.",
      "Test command errored before completion.",
      "Validation is failing in CI.",
    ];

    for (const line of failureLines) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));

      expect(evidence.validation_failed).toBe(true);
      expect(evidence.validation_backed).toBe(false);
      expect(reduceReviewEvidence(evidence).decision).not.toBe("sufficient");
    }
  });

  test("adjacent validation exit code and status segments fail closed", async () => {
    const adjacentFailures = [
      "Validation commands run: bun test. Exit code: 1.",
      "Validation commands run: bun test; status: 2.",
      "Validation commands run: bun test. Returned code: 3.",
      "Validation commands run: bun test; nonzero status.",
    ];

    for (const line of adjacentFailures) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));

      expect(evidence.validation_failed).toBe(true);
      expect(evidence.validation_backed).toBe(false);
      expect(reduceReviewEvidence(evidence).decision).not.toBe("sufficient");
    }
  });

  test("contextual validation errors fail but expected negative-path errors can pass", async () => {
    const contextualErrors = [
      "Validation commands run: bun test reported 3 errors.",
      "Validation commands run: bun test had 3 errors.",
      "Validation commands run: bun test error count: 3.",
      "Validation commands run: bun test errors: 3.",
      "Validation commands run: bun test failed with errors.",
      "Validation commands run: bun test errored.",
    ];

    for (const line of contextualErrors) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));

      expect(evidence.validation_failed).toBe(true);
      expect(evidence.validation_backed).toBe(false);
      expect(reduceReviewEvidence(evidence).decision).not.toBe("sufficient");
    }

    const expectedErrorEvidence = parseEvidenceFromText([
      "Independent separate reviewer mapped acceptance criteria against the approved spec.",
      "Inspected git diff and changed files.",
      "Validation commands run: errors were expected in negative-path tests and the command passed.",
      "Residual risk review completed.",
      "Fresh after final diff.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));

    expect(expectedErrorEvidence.validation_failed).toBe(false);
    expect(expectedErrorEvidence.validation_backed).toBe(true);
    expect(reduceReviewEvidence(expectedErrorEvidence).decision).toBe("sufficient");
  });

  test("explicit pass and status-zero wording satisfies validation-backed evidence", async () => {
    const successLines = [
      "Validation commands run: bun test passed.",
      "Validation commands run: bun test succeeded.",
      "Validation commands run: bun test status: 0.",
      "Validation commands run: bun test. Exit code: 0.",
      "bun test returned status: 0.",
    ];

    for (const line of successLines) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));

      expect(evidence.validation_failed).toBe(false);
      expect(evidence.validation_backed).toBe(true);
      expect(reduceReviewEvidence(evidence).decision).toBe("sufficient");
    }
  });

  test("negated validation failure wording does not set validation_failed", async () => {
    const noFailureLines = [
      "Validation commands run: bun test passed; no validation commands failed.",
      "Validation commands run: bun test passed; No tests failed.",
      "Validation commands run: bun test passed; zero validation failures.",
      "Validation commands run: bun test passed; 0 failures.",
      "Validation commands run: bun test passed; Validation failures: none.",
      "Validation commands run: bun test passed; Validation errors: none.",
      "Validation commands run: error handling tests passed.",
      "Validation commands run: bun test passed without validation failures.",
    ];

    for (const line of noFailureLines) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        "Inspected git diff and changed files.",
        line,
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));

      expect(evidence.validation_failed).toBe(false);
      expect(evidence.validation_backed).toBe(true);
      expect(reduceReviewEvidence(evidence).decision).toBe("sufficient");
    }

    expect(parseEvidenceFromText("No tests failed.").validation_failed).toBe(false);
    expect(parseEvidenceFromText("zero validation failures.").validation_failed).toBe(false);
    expect(parseEvidenceFromText("0 failures.").validation_failed).toBe(false);
  });

  test("Ralph JSON review artifacts expose findings and raw text as evidence", async () => {
    const evidenceText = reviewArtifactToEvidenceText(JSON.stringify({
      reviewer: "reviewer-a",
      decision: {
        findings: [
          { title: "[P2] fallback bug", body: "The fallback misses an edge case.", priority: 2 },
        ],
        overall_correctness: "patch is correct",
        overall_explanation: "Reviewed after final diff.",
      },
      raw_text: "Independent separate reviewer mapped acceptance criteria against the approved spec. Inspected git diff and changed files. Validation commands run: bun test passed. Residual risk review completed. Fresh after final diff.",
      validation_notes: "No validation commands failed.",
      severity_counts: { p0: 0, p1: 0, p2: 1, p3: 0 },
    }));
    const evidence = parseEvidenceFromText(evidenceText);

    expect(evidenceText).toContain("overall_correctness: patch is correct");
    expect(evidenceText).toContain("finding_title: [P2] fallback bug");
    expect(evidenceText).toContain("validation_notes: No validation commands failed.");
    expect(evidence.severity_counts).toMatchObject({ p0: 0, p1: 0, p2: 3, p3: 0 });
    expect(evidence.validation_failed).toBe(false);
  });

  test("acceptance evidence requires explicit mapping, checking, tracing, verification, or coverage", async () => {
    const bareMentions = parseEvidenceFromText([
      "Independent separate reviewer completed the review.",
      "The latest approved spec and criteria were mentioned.",
      "Inspected git diff and changed files.",
      "Validation commands run: bun test passed.",
      "Residual risk review completed.",
      "Fresh after final diff.",
    ].join("\n"));
    const positiveControls = [
      "Acceptance criteria were checked and traced against the approved spec.",
      "Reviewer verified approved plan coverage for each acceptance criterion.",
    ];
    const negativeControls = [
      "The approved spec was not checked against acceptance criteria.",
      "Unchecked spec; acceptance criteria were not traced.",
      "Spec not verified against acceptance criteria.",
    ];

    expect(bareMentions.acceptance_mapped).toBeUndefined();
    expect(reduceReviewEvidence(bareMentions).missing).toContain("acceptance_mapped");
    for (const line of positiveControls) {
      expect(parseEvidenceFromText(line).acceptance_mapped).toBe(true);
    }
    for (const line of negativeControls) {
      expect(parseEvidenceFromText(line).acceptance_mapped).toBe(false);
    }
  });

  test("freshness requires review after the final or current diff/latest change", async () => {

    expect(parseEvidenceFromText("Latest change is mentioned in the review summary.").fresh).toBeUndefined();
    expect(parseEvidenceFromText("Reviewed after latest change.").fresh).toBe(true);
    expect(parseEvidenceFromText("Fresh after final diff.").fresh).toBe(true);
    expect(parseEvidenceFromText("Review evidence after current diff was checked.").fresh).toBe(true);
    expect(parseEvidenceFromText("Review predates latest change.").fresh).toBe(false);
    expect(parseEvidenceFromText("Reviewed before final diff.").fresh).toBe(false);
  });

  test("diff unavailable wording prevents diff-aware sufficiency", async () => {
    const unavailableLines = [
      "Unable to inspect git diff for this run.",
      "Could not inspect changed files.",
      "Cannot review current diff.",
      "Diff unavailable.",
      "Diff was unavailable.",
      "Diff could not be inspected.",
      "No git diff was available.",
      "Diff was not available.",
      "Changed files were unavailable.",
    ];

    for (const line of unavailableLines) {
      const evidence = parseEvidenceFromText([
        "Independent separate reviewer mapped acceptance criteria against the approved spec.",
        line,
        "Validation commands run: bun test passed.",
        "Residual risk review completed.",
        "Fresh after final diff.",
        "P0: none",
        "P1: no findings",
      ].join("\n"));

      expect(evidence.diff_aware).toBe(false);
      expect(reduceReviewEvidence(evidence).missing).toContain("diff_aware");
      expect(reduceReviewEvidence(evidence).decision).not.toBe("sufficient");
    }
  });

  test("negated and skipped review phrases do not satisfy evidence criteria", async () => {
    const evidence = parseEvidenceFromText([
      "Review is not independent.",
      "No acceptance mapping was provided.",
      "Diff not inspected.",
      "Validation commands skipped; no tests run.",
      "No residual risk assessment.",
      "Not fresh.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));

    expect(evidence).toMatchObject({
      independent: false,
      acceptance_mapped: false,
      diff_aware: false,
      validation_backed: false,
      risk_aware: false,
      fresh: false,
      severity_counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
    });
    expect(reduceReviewEvidence(evidence).decision).not.toBe("sufficient");
  });

  test("negated criterion variants stay missing even with other affirmative evidence", async () => {
    const positiveLines = {
      independent: "Independent separate reviewer completed the review.",
      acceptance_mapped: "Acceptance criteria were mapped to the approved spec.",
      diff_aware: "Inspected git diff and changed files.",
      validation_backed: "Validation commands run: bun test passed.",
      risk_aware: "Residual risk review completed.",
      fresh: "Fresh after final diff.",
    } as const;
    const cases = [
      { criterion: "independent", negatedLine: "This review was not independent." },
      { criterion: "acceptance_mapped", negatedLine: "Acceptance criteria were not mapped to the approved spec." },
      { criterion: "diff_aware", negatedLine: "No git diff or changed files were inspected." },
      { criterion: "validation_backed", negatedLine: "Validation was skipped; no tests run." },
      { criterion: "risk_aware", negatedLine: "Risk is unknown." },
      { criterion: "fresh", negatedLine: "Evidence is stale." },
    ] as const;

    for (const { criterion, negatedLine } of cases) {
      const report = Object.entries(positiveLines)
        .map(([key, line]) => key === criterion ? negatedLine : line)
        .concat(["P0: none", "P1: no findings"])
        .join("\n");
      const evidence = parseEvidenceFromText(report);
      const reduction = reduceReviewEvidence(evidence);

      expect(evidence[criterion]).toBe(false);
      expect(reduction.missing).toContain(criterion);
      expect(reduction.decision).not.toBe("sufficient");
    }
  });

  test("common negated acceptance and validation variants do not satisfy sufficiency", async () => {
    const evidence = parseEvidenceFromText([
      "Independent separate reviewer completed the review.",
      "No acceptance criteria were mapped.",
      "Inspected git diff and changed files.",
      "No tests were run.",
      "Residual risk review completed.",
      "Fresh after final diff.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));
    const reduction = reduceReviewEvidence(evidence);

    expect(evidence.acceptance_mapped).toBe(false);
    expect(evidence.validation_backed).toBe(false);
    expect(reduction.missing).toEqual(expect.arrayContaining(["acceptance_mapped", "validation_backed"]));
    expect(reduction.decision).not.toBe("sufficient");
  });

  test("common negated independent, acceptance, diff, and test variants fail closed", async () => {
    const evidence = parseEvidenceFromText([
      "No separate reviewer completed this.",
      "Acceptance mapping was not provided.",
      "Diff review skipped.",
      "Tests skipped.",
      "Residual risk review completed.",
      "Fresh after final diff.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));
    const reduction = reduceReviewEvidence(evidence);

    expect(evidence.independent).toBe(false);
    expect(evidence.acceptance_mapped).toBe(false);
    expect(evidence.diff_aware).toBe(false);
    expect(evidence.validation_backed).toBe(false);
    expect(reduction.missing).toEqual(expect.arrayContaining(["independent", "acceptance_mapped", "diff_aware", "validation_backed"]));
    expect(reduction.decision).not.toBe("sufficient");
  });

  test("affirmative non-negated review evidence still satisfies all criteria", async () => {
    const evidence = parseEvidenceFromText([
      "Independent separate reviewer mapped acceptance criteria against the approved spec.",
      "Inspected git diff and changed files.",
      "Validation commands run: bun test passed.",
      "Residual risk review completed.",
      "Fresh after final diff.",
      "P0: none",
      "P1: no findings",
    ].join("\n"));

    expect(evidence).toMatchObject({
      independent: true,
      acceptance_mapped: true,
      diff_aware: true,
      validation_backed: true,
      risk_aware: true,
      fresh: true,
      severity_counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
    });
    expect(reduceReviewEvidence(evidence).decision).toBe("sufficient");
  });

  test("sufficient evidence passes only when every criterion is true", () => {
    const reduction = reduceReviewEvidence({
      independent: true,
      acceptance_mapped: true,
      diff_aware: true,
      validation_backed: true,
      risk_aware: true,
      fresh: true,
    });

    expect(reduction.decision).toBe("sufficient");
    expect(reduction.missing).toEqual([]);
  });

  test("fractional severity counts fail closed instead of being floored", () => {
    const reduction = reduceReviewEvidence({
      independent: true,
      acceptance_mapped: true,
      diff_aware: true,
      validation_backed: true,
      risk_aware: true,
      fresh: true,
      severity_counts: { p0: 0, p1: 0, p2: 0.5, p3: 0 },
    });

    expect(reduction.decision).toBe("needs_human");
    expect(reduction.reason).toContain("non-negative integers");
  });

  test("one missing non-fresh criterion asks for targeted review", () => {
    const reduction = reduceReviewEvidence({
      independent: true,
      acceptance_mapped: true,
      diff_aware: false,
      validation_backed: true,
      risk_aware: true,
      fresh: true,
    });

    expect(reduction.decision).toBe("targeted_review");
    expect(reduction.missing).toEqual(["diff_aware"]);
  });

  test("stale or multiple missing criteria require full review", () => {
    expect(reduceReviewEvidence({
      independent: true,
      acceptance_mapped: true,
      diff_aware: true,
      validation_backed: true,
      risk_aware: true,
      fresh: false,
    }).decision).toBe("full_review");

    expect(reduceReviewEvidence({
      independent: false,
      acceptance_mapped: true,
      diff_aware: false,
      validation_backed: true,
      risk_aware: true,
      fresh: true,
    }).decision).toBe("full_review");
  });

  test("negated prose hard-stop phrases do not set blocked or conflicted flags", async () => {
    const negatedBlocked = ["not blocked", "no blockers", "no blocking issues", "not unable to review"];
    const negatedConflicted = ["no conflicting evidence", "no conflicts", "not conflicted", "no evidence conflicts"];

    for (const phrase of negatedBlocked) {
      expect(parseEvidenceFromText(`Review complete and ${phrase}.`).blocked).toBeUndefined();
    }
    for (const phrase of negatedConflicted) {
      expect(parseEvidenceFromText(`Review complete with ${phrase}.`).conflicted).toBeUndefined();
    }
  });

  test("positive prose hard-stop phrases still set blocked or conflicted flags", async () => {
    const blockedPhrases = ["blocked", "blocker remains", "blocking issue", "unable to review", "missing dependency"];
    const conflictedPhrases = ["conflicting evidence", "evidence conflict", "conflicted", "review conflicts with results"];

    for (const phrase of blockedPhrases) {
      const evidence = parseEvidenceFromText(`Review is ${phrase}.`);
      expect(evidence.blocked).toBe(true);
      expect(reduceReviewEvidence(evidence).decision).toBe("blocked");
    }
    for (const phrase of conflictedPhrases) {
      const evidence = parseEvidenceFromText(`Review has ${phrase}.`);
      expect(evidence.conflicted).toBe(true);
      expect(reduceReviewEvidence(evidence).decision).toBe("needs_human");
    }

    expect(parseEvidenceFromText("Not blocked, but a blocker remains.").blocked).toBe(true);
    expect(parseEvidenceFromText("No conflicts, but evidence conflicts with validation.").conflicted).toBe(true);
  });

  test("blocking severities, conflicts, validation failures, and blockers fail closed", () => {
    expect(reduceReviewEvidence({ severity_counts: { p1: 1 } }).decision).toBe("fixes_needed");
    expect(reduceReviewEvidence({ conflicted: true }).decision).toBe("needs_human");
    expect(reduceReviewEvidence({ validation_failed: true }).decision).toBe("needs_human");
    expect(reduceReviewEvidence({ blocked: true }).decision).toBe("blocked");
    expect(missingReviewCriteria({})).toEqual([
      "independent",
      "acceptance_mapped",
      "diff_aware",
      "validation_backed",
      "risk_aware",
      "fresh",
    ]);
  });
});

describe("compound-engineering artifact path helpers and discoverability", () => {
  test("markdown writes use exclusive collision-safe suffixes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-"));
    try {
      const desired = join(dir, "report.md");
      const first = await writeMarkdown(desired, "first");
      const second = await writeMarkdown(desired, "second");
      const third = await writeMarkdown(desired, "third");

      expect(first).toBe(desired);
      expect(second).toBe(join(dir, "report-2.md"));
      expect(third).toBe(join(dir, "report-3.md"));
      expect(await readFile(first, "utf8")).toBe("first\n");
      expect(await readFile(second, "utf8")).toBe("second\n");
      expect(await readFile(third, "utf8")).toBe("third\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saved stage report reads saved Markdown before inline file-only references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-report-"));
    const suffixedPointer = "Output saved to: /tmp/P1-compact-reference.md (48.2 KB, 2847 lines). Read this file if needed.";
    try {
      const reportPath = join(dir, "review.md");
      await writeFile(reportPath, "saved sufficient review evidence\n", "utf8");
      const loaded = await loadSavedStageReport(reportPath, { text: suffixedPointer });

      expect(loaded).toEqual({ path: reportPath, body: "saved sufficient review evidence\n", source: "saved-file" });
      await expect(loadSavedStageReport(join(dir, "missing.md"), { text: "Output saved to: /tmp/P1-compact-reference.md" })).rejects.toThrow("compact output reference");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing saved stage report rejects suffixed Atomic file-only pointers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-missing-report-"));
    try {
      const missingPath = join(dir, "missing.md");
      for (const pointer of [
        "Output saved to: /tmp/review.md (48.2 KB, 2847 lines). Read this file if needed.",
        "Saved output to: /tmp/review.md (48.2 KB, 2847 lines). Read this file if needed.",
        "Saved to: /tmp/review.md (48.2 KB, 2847 lines). Read this file if needed.",
      ]) {
        await expect(loadSavedStageReport(missingPath, { text: pointer })).rejects.toThrow("file-only pointer");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("substantive inline stage report remains an accepted fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-inline-report-"));
    try {
      const missingPath = join(dir, "missing.md");
      const loaded = await loadSavedStageReport(missingPath, { text: "Independent review body with substantive evidence." });

      expect(loaded).toEqual({ path: missingPath, body: "Independent review body with substantive evidence.", source: "inline-fallback" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("effective worktree root resolves Git top-level from a subdirectory for Ralph", async () => {
    const tempDir = await realpath(await mkdtemp(join(tmpdir(), "compound-engineering-git-")));
    try {
      await gitInit(tempDir);
      const subdir = join(tempDir, "nested", "cwd");
      await mkdir(subdir, { recursive: true });

      expect(await resolveEffectiveWorktreeRoot("../requested-wt", subdir)).toBe(tempDir);
      expect(await resolveEffectiveWorktreeRoot("", subdir)).toBe("");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("slugs are date-prefixed, compact, and traversal-safe", () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    expect(slugifyTopic("../../Add OAuth Login!!! and docs", "fallback")).toBe("add-oauth-login-and-docs");
    expect(datedMarkdownPath("docs/plans", "../../Add OAuth Login!!! and docs", "plan", now)).toBe("docs/plans/2026-06-05-add-oauth-login-and-docs.md");
  });

  test("workflow is discoverable and documents safe iteration-3 posture", () => {
    const source = workflowSource();
    expect(source).toContain('defineWorkflow("compound-engineering")');
    expect(source).toContain('const WORKFLOW_NAME = "compound-engineering"');
    expect(source).toContain('.worktreeFromInputs({');
    expect(source).toContain('ctx.workflow(runner === "goal" ? goal : ralph');
    expect(source).toContain('loadSavedStageReport(reviewPath, review)');
    expect(source).not.toContain('ctx.task("gate-review-evidence"');
    expect(source).toContain('resolveEffectiveWorktreeRoot(gitWorktreeDir, cwd)');
    expect(source).toContain('captureLearningArtifact({');
    expect(source).toContain('.compile()');
    expect(source).toContain('child_workflow_launched: false');
    expect(source).toContain('child_workflow_launched: true');
    expect(source).toContain('create_pr');

    expect(workflowReadme()).toContain("EveryInc");
    expect(workflowReadme()).toContain("no implementation before approval");
    expect(workflowReadme()).toContain("explicit `runner=goal` or `runner=ralph`");
    expect(workflowReadme()).toContain("`compound-engineering/` final report directory is generated and gitignored");
    expect(registryReadme()).toContain("compound-engineering");
    expect(registryReadme()).toContain("`./compound-engineering/` is generated and gitignored");
    expect(rootReadme()).toContain("compound-engineering");
    expect(rootGitignore()).toContain("/compound-engineering/");
    expect(rootGitignore()).toContain("/.compound-engineering-*/");
  });

  test("explicit goal and ralph run child workflows only after approval with runner-specific inputs", async () => {
    for (const runner of ["goal", "ralph"] as const) {
      const dir = await realpath(await mkdtemp(join(tmpdir(), `compound-engineering-${runner}-`)));
      if (runner === "ralph") await gitInit(dir);
      const workflow = await workflowPromise;
      const workflowCalls: Array<{ workflow: { name: string }; options: { inputs: Record<string, unknown> } }> = [];
      const cwd = runner === "ralph" ? join(dir, "nested", "cwd") : dir;
      try {
        if (runner === "ralph") await mkdir(cwd, { recursive: true });
        const result = await workflow.run({
          cwd,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner,
            max_loops: 3,
            base_branch: "origin/main",
            git_worktree_dir: runner === "ralph" ? "../requested-wt" : "",
            create_pr: "true",
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: {
            select: async () => "Approve",
            input: async () => "",
          },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: sufficientReviewReport() };
          },
          workflow: async (childWorkflow: { name: string }, options: { inputs: Record<string, unknown> }) => {
            workflowCalls.push({ workflow: childWorkflow, options });
            return {
              outputs: {
                result: "implementation done",
                review_report: sufficientReviewReport(),
                approved: true,
                status: "complete",
              },
            };
          },
        });

        expect(result.status).toBe("complete");
        expect(result.implementation).toBeDefined();
        expect(JSON.stringify(result)).not.toContain(":undefined");
        expect(workflowCalls).toHaveLength(1);
        expect(workflowCalls[0].workflow.name).toBe(runner);
        if (runner === "goal") {
          expect(workflowCalls[0].options.inputs).toMatchObject({
            objective: expect.stringContaining("Implement the approved Compound Engineering plan/spec"),
            max_turns: 3,
            base_branch: "origin/main",
          });
          expect(workflowCalls[0].options.inputs).not.toHaveProperty("create_pr");
        } else {
          expect(workflowCalls[0].options.inputs).toMatchObject({
            prompt: expect.stringContaining("Implement the approved Compound Engineering plan/spec"),
            max_loops: 3,
            base_branch: "origin/main",
            git_worktree_dir: dir,
            create_pr: false,
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("review-only evidence uses saved file-only body instead of compact reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-review-only-"));
    const workflow = await workflowPromise;
    try {
      const sufficientReport = sufficientReviewReport();
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "main..feature/auth",
          mode: "review",
          runner: "handoff-only",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, sufficientReport);
          return { text: "Output saved to: /tmp/P1-compact-reference.md" };
        },
        workflow: async () => ({}),
      });

      expect(result.status).toBe("review_only");
      expect(result.approved).toBe(true);
      expect(result.message).toContain("evidence gate decision: sufficient");
      expect(result.review_report_path).toContain("compound-engineering/");
      expect(JSON.stringify(result)).not.toContain(":undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("review-only missing saved compact report fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-review-only-missing-"));
    const workflow = await workflowPromise;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "main..feature/auth",
          mode: "review",
          runner: "handoff-only",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async () => ({ text: "Output saved to: /tmp/P1-compact-reference.md" }),
        workflow: async () => ({}),
      });

      expect(result.status).toBe("blocked");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("Review-only evidence gate returned blocked");
      expect(result.message).not.toContain("Review-only report produced");
      expect(result).not.toHaveProperty("review_report_path");
      expect(JSON.stringify(result)).not.toContain(":undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("review-only missing saved suffixed pointer report fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-review-only-missing-suffixed-"));
    const workflow = await workflowPromise;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "main..feature/auth",
          mode: "review",
          runner: "handoff-only",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async () => ({ text: "Output saved to: /tmp/review.md (48.2 KB, 2847 lines). Read this file if needed." }),
        workflow: async () => ({}),
      });

      expect(result.status).toBe("blocked");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("file-only pointer");
      expect(result.message).not.toContain("Review-only report produced");
      expect(result).not.toHaveProperty("review_report_path");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("native goal and ralph review-round artifacts complete without synthetic review_evidence", async () => {
    for (const runner of ["goal", "ralph"] as const) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-native-${runner}-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner,
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: nativeReviewRoundReport(), approved: true, status: "complete" } }),
        });

        expect(result.status).toBe("complete");
        expect(result.approved).toBe(true);
        expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).structured_child).toMatchObject({
          contract: "native_builtin_review_round",
          source_kind: runner === "goal" ? "native_goal_review_round" : "native_ralph_review_round",
          loaded: true,
          errors: [],
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("review_evidence wrappers with iteration metadata complete without native shadowing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-wrapper-iteration-"));
    const workflow = await workflowPromise;
    try {
      const report = JSON.stringify({ iteration: 1, review_evidence: structuredEvidence() });
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { result: "implementation done", review_report: report, approved: true, status: "complete" } }),
      });

      expect(result.status).toBe("complete");
      expect(result.approved).toBe(true);
      expect(((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).structured_child).toMatchObject({
        contract: "declared_child_review_artifact",
        loaded: true,
        errors: [],
      });
      expect(JSON.stringify(result.implementation)).not.toContain("native_goal_review_round");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy compound_engineering_evidence subtree is ignored but sibling review_evidence can complete", async () => {
    const cases: Array<{ name: string; report: string; expectedStatus: string; expectedMessage?: string }> = [
      {
        name: "legacy-only",
        report: JSON.stringify({ compound_engineering_evidence: structuredEvidence() }),
        expectedStatus: "needs_human",
        expectedMessage: "legacy compound_engineering_evidence was ignored",
      },
      {
        name: "nested-legacy",
        report: JSON.stringify({ wrapper: { compound_engineering_evidence: { review_evidence: structuredEvidence() } } }),
        expectedStatus: "needs_human",
        expectedMessage: "legacy compound_engineering_evidence was ignored",
      },
      {
        name: "sibling-review-evidence",
        report: JSON.stringify({ review_evidence: structuredEvidence(), compound_engineering_evidence: { review_evidence: structuredEvidence({ blocked: true }) } }),
        expectedStatus: "complete",
      },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-legacy-${testCase.name}-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: testCase.report, approved: true, status: "complete" } }),
        });

        expect(result.status).toBe(testCase.expectedStatus);
        expect(result.approved).toBe(testCase.expectedStatus === "complete");
        const structuredChild = ((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).structured_child as Record<string, unknown>;
        expect(structuredChild.legacy_compound_engineering_evidence_ignored).toBe(true);
        if (testCase.expectedMessage) expect(result.message).toContain(testCase.expectedMessage);
        if (testCase.expectedStatus === "complete") {
          expect(((result.implementation as Record<string, unknown>).gate_review_evidence as Record<string, unknown>).decision).toBe("sufficient");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("native review-round artifacts fail closed on blocking or malformed decisions", async () => {
    const cases: Array<{ name: string; report: string; native: boolean; decision?: string; expectedMessage?: string }> = [
      {
        name: "p0-finding",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: { overall_correctness: "patch is correct", findings: [{ title: "data loss", priority: 0 }] } }] }),
        native: true,
        decision: "fixes_needed",
      },
      {
        name: "p1-finding",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: { overall_correctness: "patch is correct", findings: [{ title: "security bug", severity: "P1" }] } }] }),
        native: true,
        decision: "fixes_needed",
      },
      {
        name: "root-reviewer-error",
        report: nativeReviewRoundReport({ reviewer_error: "round failed" }),
        native: true,
      },
      {
        name: "review-reviewer-error",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", reviewer_error: "review failed", decision: { overall_correctness: "patch is correct", findings: [] } }] }),
        native: true,
      },
      {
        name: "decision-reviewer-error",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: { overall_correctness: "patch is correct", reviewer_error: "tool failed", findings: [] } }] }),
        native: true,
      },
      {
        name: "bad-correctness",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: { overall_correctness: "patch is incorrect", findings: [] } }] }),
        native: true,
      },
      {
        name: "stop-loop-false",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: { overall_correctness: "patch is correct", stop_review_loop: false, findings: [] } }] }),
        native: true,
      },
      {
        name: "malformed-decision",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: "approved" }] }),
        native: true,
      },
      {
        name: "empty-reviews",
        report: JSON.stringify({ iteration: 1, reviews: [] }),
        native: true,
      },
      {
        name: "iteration-only-metadata",
        report: JSON.stringify({ iteration: 1 }),
        native: false,
        expectedMessage: "missing review_evidence object",
      },
      {
        name: "unknown-severity",
        report: nativeReviewRoundReport({ reviews: [{ reviewer: "native", decision: { overall_correctness: "patch is correct", findings: [{ title: "mystery", severity: "critical" }] } }] }),
        native: true,
      },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-native-${testCase.name}-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: testCase.report, approved: true, status: "complete" } }),
        });

        expect(result.status).not.toBe("complete");
        expect(result.approved).toBe(false);
        const structuredChild = ((result.implementation as Record<string, unknown>).evidence as Record<string, unknown>).structured_child as Record<string, unknown>;
        if (testCase.native) {
          expect(structuredChild).toMatchObject({ source_kind: "native_goal_review_round" });
        } else {
          expect(structuredChild).not.toHaveProperty("source_kind");
        }
        if (testCase.decision) expect(((result.implementation as Record<string, unknown>).gate_review_evidence as Record<string, unknown>).decision).toBe(testCase.decision);
        if (testCase.expectedMessage) expect(result.message).toContain(testCase.expectedMessage);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("structured validation summary-only zero failure and no-error phrases can satisfy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-zero-summary-"));
    const workflow = await workflowPromise;
    try {
      const summaries = ["0 failures", "zero failures", "no failures", "0 errors", "zero errors", "no errors"];
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            review_report: structuredEvidenceReport(structuredEvidence({
              validation_backed: {
                satisfied: true,
                evidence: "Validation command summaries reported zero failures/errors.",
                commands: summaries.map((summary) => ({ command: "validation", summary })),
              },
            })),
            approved: true,
            status: "complete",
          },
        }),
      });

      expect(result.status).toBe("complete");
      expect(result.approved).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("structured validation summary contradictions fail closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-contradictory-summary-"));
    const workflow = await workflowPromise;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            review_report: structuredEvidenceReport(structuredEvidence({
              validation_backed: {
                satisfied: true,
                evidence: "Validation summary contradicted itself.",
                commands: [{ command: "bun test", summary: "0 failures, 1 error" }],
              },
            })),
            approved: true,
            status: "complete",
          },
        }),
      });

      expect(result.status).toBe("needs_human");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("validation_backed.commands");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("structured numeric evidence requires integer exit codes and severity counts", async () => {
    const cases = [
      {
        name: "fractional-exit-code",
        evidence: structuredEvidence({
          validation_backed: { satisfied: true, evidence: "Validation passed according to summary.", commands: [{ command: "bun test", exit_code: 0.5, summary: "bun test passed" }] },
        }),
        expectedMessage: "validation_backed.commands",
      },
      {
        name: "string-exit-code",
        evidence: structuredEvidence({
          validation_backed: { satisfied: true, evidence: "Validation passed according to summary.", commands: [{ command: "bun test", exit_code: "0", summary: "bun test passed" }] },
        }),
        expectedMessage: "validation_backed.commands",
      },
      {
        name: "fractional-severity-count",
        evidence: structuredEvidence({ severity_counts: { p0: 0, p1: 0, p2: 0.5, p3: 0 } }),
        expectedMessage: "severity_counts.p2",
      },
      {
        name: "negative-severity-count",
        evidence: structuredEvidence({ severity_counts: { p0: 0, p1: 0, p2: -1, p3: 0 } }),
        expectedMessage: "severity_counts.p2",
      },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-${testCase.name}-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: structuredEvidenceReport(testCase.evidence), approved: true, status: "complete" } }),
        });

        expect(result.status).toBe("needs_human");
        expect(result.approved).toBe(false);
        expect(result.message).toContain(testCase.expectedMessage);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("structured evidence with all criteria true returns complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-structured-complete-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { result: "implementation done", review_report: structuredEvidenceReport(), approved: true, status: "complete" } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("complete");
      expect(result.approved).toBe(true);
      expect(((result.implementation as Record<string, unknown>).gate_review_evidence as Record<string, unknown>).decision).toBe("sufficient");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("structured evidence missing one criterion returns needs_human without supplemental review", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-structured-missing-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const incompleteEvidence = structuredEvidence({ risk_aware: { satisfied: false, evidence: "Child did not complete residual risk review." } });
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { result: "implementation done with incomplete review evidence", review_report: structuredEvidenceReport(incompleteEvidence), approved: true, status: "complete" } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("needs_human");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("Missing structured evidence criteria: risk_aware");
      expect(((result.implementation as Record<string, unknown>).gate_review_evidence as Record<string, unknown>).missing).toContain("risk_aware");
      expect(JSON.stringify(result)).not.toContain(":undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("structured evidence with validation_failed true does not complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-validation-failed-"));
    const workflow = await workflowPromise;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { result: "implementation done", review_report: structuredEvidenceReport(structuredEvidence({ validation_failed: true })), approved: true, status: "complete" } }),
      });

      expect(result.status).toBe("needs_human");
      expect(result.approved).toBe(false);
      expect(result.message.toLowerCase()).toContain("validation failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("structured evidence with p0 or p1 findings does not complete", async () => {
    for (const severity of ["p0", "p1"] as const) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-${severity}-finding-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: structuredEvidenceReport(structuredEvidence({ severity_counts: { p0: severity === "p0" ? 1 : 0, p1: severity === "p1" ? 1 : 0, p2: 0, p3: 0 } })), approved: true, status: "complete" } }),
        });

        expect(result.status).toBe("needs_human");
        expect(result.approved).toBe(false);
        expect(((result.implementation as Record<string, unknown>).gate_review_evidence as Record<string, unknown>).decision).toBe("fixes_needed");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("structured stop flags fail closed when malformed and accept false booleans", async () => {
    const cases: Array<{ name: string; evidence: Record<string, unknown>; expectedStatus: string; expectedMessage?: string }> = [
      { name: "blocked-string", evidence: structuredEvidence({ blocked: "false" }), expectedStatus: "needs_human", expectedMessage: "blocked must be boolean" },
      { name: "conflicted-number", evidence: structuredEvidence({ conflicted: 0 }), expectedStatus: "needs_human", expectedMessage: "conflicted must be boolean" },
      { name: "validation-failed-string", evidence: structuredEvidence({ validation_failed: "false" }), expectedStatus: "needs_human", expectedMessage: "validation_failed must be boolean" },
      { name: "false-booleans", evidence: structuredEvidence({ blocked: false, conflicted: false, validation_failed: false }), expectedStatus: "complete" },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-stop-flags-${testCase.name}-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: structuredEvidenceReport(testCase.evidence), approved: true, status: "complete" } }),
        });

        expect(result.status).toBe(testCase.expectedStatus);
        expect(result.approved).toBe(testCase.expectedStatus === "complete");
        if (testCase.expectedMessage) {
          expect(result.message).toContain(testCase.expectedMessage);
          expect(((result.implementation as Record<string, unknown>).gate_review_evidence as Record<string, unknown>).decision).toBe("needs_human");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("structured evidence with blocked or conflicted true does not complete", async () => {
    for (const flag of ["blocked", "conflicted"] as const) {
      const dir = await mkdtemp(join(tmpdir(), `compound-engineering-${flag}-flag-`));
      const workflow = await workflowPromise;
      try {
        const result = await workflow.run({
          cwd: dir,
          inputs: {
            prompt: "Implement approved thing",
            mode: "work",
            runner: "goal",
            max_loops: 2,
            base_branch: "origin/main",
            git_worktree_dir: "",
            create_pr: false,
            learning_mode: "off",
            memory_scope: "none",
          },
          ui: { select: async () => "Approve", input: async () => "" },
          task: async (_name: string, options: { output?: string }) => {
            if (options.output) await writeMarkdown(options.output, "task output");
            return { text: "draft" };
          },
          workflow: async () => ({ outputs: { result: "implementation done", review_report: structuredEvidenceReport(structuredEvidence({ [flag]: true })), approved: true, status: "complete" } }),
        });

        expect(result.status).toBe(flag === "blocked" ? "blocked" : "needs_human");
        expect(result.approved).toBe(false);
        expect(JSON.stringify(result.implementation)).toContain(flag);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("structured validation commands with failing exit codes do not complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-command-failed-"));
    const workflow = await workflowPromise;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            review_report: structuredEvidenceReport(structuredEvidence({
              validation_backed: { satisfied: true, evidence: "Validation was attempted.", commands: [{ command: "bun test", exit_code: 1, summary: "bun test failed" }] },
            })),
            approved: true,
            status: "complete",
          },
        }),
      });

      expect(result.status).toBe("needs_human");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("validation_backed.commands");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prose-only child review reports do not produce complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-prose-only-child-"));
    const workflow = await workflowPromise;
    let supplementalTaskRan = false;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          if (name === "gate-review-evidence") supplementalTaskRan = true;
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({ outputs: { result: "implementation done", review_report: proseOnlySufficientReviewReport(), approved: true, status: "complete" } }),
      });

      expect(supplementalTaskRan).toBe(false);
      expect(result.status).toBe("needs_human");
      expect(result.approved).toBe(false);
      expect(result.message).toContain("missing review_evidence object");
      expect(result.message).not.toContain("review evidence gate is sufficient");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parent no longer invokes gate-review-evidence", async () => {
    const source = workflowSource();
    expect(source).not.toContain('ctx.task("gate-review-evidence"');
    expect(source).not.toContain("mergeEvidence(");
  });

  test("post-validation learning writes docs solutions path for lightweight mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-learning-"));
    const workflow = await workflowPromise;
    const taskNames: string[] = [];
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "lightweight",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          taskNames.push(name);
          if (options.output) await writeMarkdown(options.output, name === "capture-learning" ? "learning doc" : "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            approved: true,
            status: "complete",
            review_report: sufficientReviewReport(),
          },
        }),
      });

      expect(result.status).toBe("complete");
      expect(taskNames).toContain("capture-learning");
      expect(result.learning_doc_path).toContain("docs/solutions/");
      expect(await readFile(result.learning_doc_path as string, "utf8")).toBe("learning doc\n");
      const manifest = JSON.parse(await readFile(result.manifest_path as string, "utf8"));
      expect(manifest.input.selected_learning_mode).toBe("lightweight");
      expect(manifest.artifacts["learning-doc"]).toBe(result.learning_doc_path);
      expect(JSON.stringify(result)).not.toContain(":undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("post-validation learning off does not write docs solutions path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-learning-off-"));
    const workflow = await workflowPromise;
    const taskNames: string[] = [];
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "goal",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: false,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (name: string, options: { output?: string }) => {
          taskNames.push(name);
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({
          outputs: {
            result: "implementation done",
            approved: true,
            status: "complete",
            review_report: sufficientReviewReport(),
          },
        }),
      });

      expect(result.status).toBe("complete");
      expect(taskNames).not.toContain("capture-learning");
      expect(result).not.toHaveProperty("learning_doc_path");
      expect(JSON.stringify(result)).not.toContain(":undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handoff-only does not launch child workflow and omits undefined command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-handoff-"));
    const workflow = await workflowPromise;
    let workflowCalls = 0;
    try {
      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt: "Implement approved thing",
          mode: "work",
          runner: "handoff-only",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: true,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => {
          workflowCalls += 1;
          return {};
        },
      });

      expect(result.status).toBe("handoff_ready");
      expect(workflowCalls).toBe(0);
      expect((result.implementation as Record<string, unknown>).child_workflow_launched).toBe(false);
      expect(result.implementation).not.toHaveProperty("command");
      expect(JSON.stringify(result)).not.toContain(":undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("workflow records suffixed artifact paths when visible outputs collide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compound-engineering-collisions-"));
    const workflow = await workflowPromise;
    const prompt = "Implement approved thing";
    const now = new Date();
    const desiredPlan = join(dir, datedMarkdownPath("docs/plans", prompt, "plan", now));
    const desiredSpec = join(dir, datedMarkdownPath("specs", prompt, "spec", now));
    const desiredFinalReport = join(dir, datedMarkdownPath("compound-engineering", prompt, "final-report", now));
    try {
      await mkdir(join(dir, "docs/plans"), { recursive: true });
      await mkdir(join(dir, "specs"), { recursive: true });
      await mkdir(join(dir, "compound-engineering"), { recursive: true });
      await writeFile(desiredPlan, "existing plan\n", "utf8");
      await writeFile(desiredSpec, "existing spec\n", "utf8");
      await writeFile(desiredFinalReport, "existing final report\n", "utf8");

      const result = await workflow.run({
        cwd: dir,
        inputs: {
          prompt,
          mode: "work",
          runner: "handoff-only",
          max_loops: 2,
          base_branch: "origin/main",
          git_worktree_dir: "",
          create_pr: true,
          learning_mode: "off",
          memory_scope: "none",
        },
        ui: { select: async () => "Approve", input: async () => "" },
        task: async (_name: string, options: { output?: string }) => {
          if (options.output) await writeMarkdown(options.output, "task output");
          return { text: "draft" };
        },
        workflow: async () => ({}),
      });

      const actualPlan = desiredPlan.replace(/\.md$/, "-2.md");
      const actualSpec = desiredSpec.replace(/\.md$/, "-2.md");
      const actualFinalReport = desiredFinalReport.replace(/\.md$/, "-2.md");
      expect(result.plan_path).toBe(displayPath(actualPlan));
      expect(result.spec_path).toBe(displayPath(actualSpec));
      expect(result.approved_spec_path).toBe(displayPath(actualSpec));

      const manifest = JSON.parse(await readFile(result.manifest_path as string, "utf8"));
      expect(manifest.finalReportPath).toBe(displayPath(actualFinalReport));
      expect(manifest.artifacts.plan).toBe(displayPath(actualPlan));
      expect(manifest.artifacts.spec).toBe(displayPath(actualSpec));
      expect(manifest.artifacts["final-report"]).toBe(displayPath(actualFinalReport));

      const finalReport = await readFile(actualFinalReport, "utf8");
      expect(finalReport).toContain(`- final-report: ${displayPath(actualFinalReport)}`);
      expect(finalReport).toContain(`- plan: ${displayPath(actualPlan)}`);
      expect(finalReport).toContain(`- spec: ${displayPath(actualSpec)}`);
      expect(finalReport).not.toContain(`- plan: ${displayPath(desiredPlan)}\n`);
      expect(finalReport).not.toContain(`- spec: ${displayPath(desiredSpec)}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("compiled workflow declares required inputs, defaults, and outputs", async () => {
    const workflow = await workflowPromise;
    expect(workflow.name).toBe("compound-engineering");
    expect(Object.keys(workflow.inputs)).toEqual([
      "prompt",
      "mode",
      "runner",
      "max_loops",
      "base_branch",
      "git_worktree_dir",
      "create_pr",
      "learning_mode",
      "memory_scope",
    ]);
    expect(workflow.inputs.mode.default).toBe("auto");
    expect(workflow.inputs.runner.default).toBe("auto");
    expect(workflow.inputs.max_loops.default).toBe(5);
    expect(workflow.inputs.base_branch.default).toBe("origin/main");
    expect(workflow.inputs.git_worktree_dir.default).toBe("");
    expect(workflow.inputs.create_pr.default).toBe(false);
    expect(workflow.inputs.learning_mode.default).toBe("ask");
    expect(workflow.inputs.memory_scope.default).toBe("repo");
    expect(workflow.worktree).toEqual({ gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" });
    expect(Object.keys(workflow.outputs)).toEqual([
      "status",
      "mode",
      "runner",
      "approved",
      "artifact_dir",
      "manifest_path",
      "message",
      "brainstorm_path",
      "plan_path",
      "spec_path",
      "approved_spec_path",
      "implementation",
      "review_report_path",
      "learning_doc_path",
    ]);
    expect(typeof workflow.run).toBe("function");
  });
});
