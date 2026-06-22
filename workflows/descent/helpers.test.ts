import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_DESCENT_BASE_BRANCH,
  WORKER_PREFLIGHT_CONTRACT,
  normalizeBaseBranchInput,
  normalizeGitRefInput,
  normalizeRequestedGitWorktreeDir,
  prepareDescentWorkspace,
  transitionActionForDecision,
  workspaceModeFromRequestedGitWorktreeDir,
} from "./helpers.ts";

const descentSource = () =>
  readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const descentReadme = () =>
  readFileSync(new URL("./README.md", import.meta.url), "utf8");

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
  Union: (
    variants: readonly MockSchema[],
    options: MockTypeOptions = {},
  ): MockSchema => ({
    anyOf: variants,
    ...options,
  }),
  Array: (items: MockSchema, options: MockTypeOptions = {}): MockSchema => ({
    type: "array",
    items,
    ...options,
  }),
  Object: (
    properties: Record<string, MockSchema>,
    options: MockTypeOptions = {},
  ): MockSchema => ({
    type: "object",
    properties,
    ...options,
  }),
  Optional: (schema: MockSchema): MockSchema => ({ ...schema, optional: true }),
  Unsafe<T>(schema: MockSchema): MockSchema {
    void (undefined as T | undefined);
    return schema;
  },
};

mock.module("@bastani/workflows", () => ({
  workflow(options: {
    name: string;
    description: string;
    inputs: Record<string, MockSchema>;
    outputs: Record<string, MockSchema>;
    worktreeFromInputs?: MockWorktreeBinding;
    run?: unknown;
  }) {
    return Object.freeze({
      __piWorkflow: true,
      name: options.name,
      description: options.description,
      inputs: Object.freeze({ ...options.inputs }),
      outputs: Object.freeze({ ...options.outputs }),
      inputBindings: Object.freeze(
        options.worktreeFromInputs
          ? { worktree: { ...options.worktreeFromInputs } }
          : {},
      ),
      run: options.run,
    });
  },
}));

mock.module("typebox", () => ({ Type }));

const descentModulePromise = import("./index.ts");
const descentWorkflowPromise = descentModulePromise.then((module) => module.default);

const EXPECTED_WORKTREE_BINDING = {
  gitWorktreeDir: "git_worktree_dir",
  baseBranch: "base_branch",
} as const;

const DESTRUCTIVE_BASELINE_MARKERS = [
  "createAcceptedSnapshot",
  "resetToRef",
  "reset --hard",
  "clean -ffdx",
  "descent: accept iteration",
  "Atomic Descent",
  "accepted-baseline",
] as const;

describe("descent helpers", () => {
  test("normalizes git refs by falling back for empty and unsafe input", () => {
    expect(normalizeGitRefInput(undefined, "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("   ", "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("feature/descent", "HEAD")).toBe("feature/descent");
    expect(normalizeGitRefInput("release+candidate", "HEAD")).toBe("release+candidate");
    expect(normalizeGitRefInput("../secret", "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("-bad", "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("foo..bar", "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("x@{y", "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("origin//main", "HEAD")).toBe("HEAD");
    expect(normalizeGitRefInput("branch.lock/path", "HEAD")).toBe("HEAD");
  });

  test("normalizes base_branch with Ralph-compatible default", () => {
    expect(normalizeBaseBranchInput(undefined)).toBe(DEFAULT_DESCENT_BASE_BRANCH);
    expect(normalizeBaseBranchInput("   ")).toBe(DEFAULT_DESCENT_BASE_BRANCH);
    expect(normalizeBaseBranchInput("main")).toBe("main");
    expect(normalizeBaseBranchInput("origin/main")).toBe("origin/main");
    expect(normalizeBaseBranchInput("feature/descent-worktree")).toBe(
      "feature/descent-worktree",
    );

    for (const unsafe of ["../secret", "-bad", "foo..bar", "x@{y", "path/file.lock"]) {
      expect(normalizeBaseBranchInput(unsafe)).toBe(DEFAULT_DESCENT_BASE_BRANCH);
    }
  });

  test("keeps requested worktree intent separate from effective workflow cwd", () => {
    expect(normalizeRequestedGitWorktreeDir(undefined)).toBeUndefined();
    expect(normalizeRequestedGitWorktreeDir("")).toBeUndefined();
    expect(normalizeRequestedGitWorktreeDir("   ")).toBeUndefined();
    expect(workspaceModeFromRequestedGitWorktreeDir(undefined)).toBe(
      "primary_checkout",
    );
    expect(workspaceModeFromRequestedGitWorktreeDir("../wt")).toBe(
      "reusable_worktree",
    );
  });

  test("primary checkout metadata preserves the projected workflow cwd", () => {
    for (const gitWorktreeDir of [undefined, "", "   "]) {
      expect(
        prepareDescentWorkspace({
          gitWorktreeDir,
          effectiveWorkflowCwd: "/repo/packages/api",
        }),
      ).toEqual({
        mode: "primary_checkout",
        effectiveWorkflowCwd: "/repo/packages/api",
      });
    }
  });

  test("reusable worktree metadata records request and projected cwd only", () => {
    const workspace = prepareDescentWorkspace({
      gitWorktreeDir: "  ../wt  ",
      effectiveWorkflowCwd: "/repo-wt/packages/api",
    });

    expect(workspace).toEqual({
      mode: "reusable_worktree",
      requestedGitWorktreeDir: "../wt",
      effectiveWorkflowCwd: "/repo-wt/packages/api",
    });
    expect("worktreeRoot" in workspace).toBe(false);
    expect("repositoryRoot" in workspace).toBe(false);
    expect("worktreeCreated" in workspace).toBe(false);
  });

  test("maps evaluation decisions to inspection-oriented transitions", () => {
    expect(transitionActionForDecision("approve")).toBe("accepted_evaluation");
    expect(transitionActionForDecision("reject")).toBe(
      "rejected_left_for_inspection",
    );
    expect(transitionActionForDecision("error")).toBe("error_left_for_inspection");
  });

  test("workflow entrypoint exposes only the default runtime export", async () => {
    const descentModule = await descentModulePromise;
    expect(Object.keys(descentModule)).toEqual(["default"]);
  });

  test("compiled descent workflow binds Ralph-style worktree inputs and declares outputs", async () => {
    const descentWorkflow = await descentWorkflowPromise;
    expect(descentWorkflow.inputs.base_branch?.default).toBe(
      DEFAULT_DESCENT_BASE_BRANCH,
    );
    expect(descentWorkflow.inputs.git_worktree_dir?.default).toBe("");
    expect(descentWorkflow.inputBindings?.worktree).toEqual(
      EXPECTED_WORKTREE_BINDING,
    );
    expect(Object.keys(descentWorkflow.outputs)).toEqual([
      "result",
      "status",
      "converged",
      "objective",
      "iterations_completed",
      "accepted_evaluations",
      "rejected_evaluations",
      "approved_iterations",
      "rejected_iterations",
      "final_score",
      "final_scores",
      "history",
      "ultimates",
      "review_report",
      "final_report",
      "radical_plan",
    ]);
  });

  test("descent workflow source uses current workflow object schemas and runtime worktree binding without production setup", () => {
    const source = descentSource();
    expect(source).toContain('import { workflow } from "@bastani/workflows";');
    expect(source).toContain('import { Type } from "typebox";');
    expect(source).toMatch(/"base_branch":\s*Type\.String/);
    expect(source).toContain('default: DEFAULT_DESCENT_BASE_BRANCH');
    expect(source).toMatch(/"git_worktree_dir":\s*Type\.String/);
    expect(source).toContain('"result": Type.String');
    expect(source).toContain('"radical_plan": Type.Optional');
    expect(source).not.toContain('required: true');
    expect(source).toContain('worktreeFromInputs: {');
    expect(source).toContain('gitWorktreeDir: "git_worktree_dir"');
    expect(source).toContain('baseBranch: "base_branch"');
    expect(source).not.toContain("setupGitWorktree");
    expect(source).toContain(
      "const comparisonBaseRef = normalizeBaseBranchInput(inputs.base_branch);",
    );
    expect(source).toContain(
      "const effectiveWorkflowCwd = workflowCtx.cwd ?? process.cwd();",
    );
    expect(source).toContain("effectiveWorkflowCwd: options.effectiveWorkflowCwd");
    expect(source).toContain("comparisonBaseRef,");
  });

  test("descent workflow routes stages through projected-cwd wrappers while binding remains source of truth", async () => {
    const source = descentSource();
    const descentWorkflow = await descentWorkflowPromise;
    expect(descentWorkflow.inputBindings?.worktree).toEqual(
      EXPECTED_WORKTREE_BINDING,
    );
    expect(source).toContain("function descentTask(");
    expect(source).toContain("function descentParallel(");
    expect(source).toContain("cwd: runtime.effectiveWorkflowCwd");
    expect(source).toContain("descentTask(runtime");
    expect(source).toContain("descentParallel(runtime");
    expect(source).not.toContain("await ctx.task(");
    expect(source).not.toContain("await ctx.parallel(");

    const directTaskCalls = source.match(/(?<!runtime\.)\bctx\.task\(/g) ?? [];
    const directParallelCalls = source.match(/(?<!runtime\.)\bctx\.parallel\(/g) ?? [];
    expect(directTaskCalls).toHaveLength(0);
    expect(directParallelCalls).toHaveLength(0);
  });

  test("descent workflow source has no destructive git baseline side effects", () => {
    const source = descentSource();
    for (const marker of DESTRUCTIVE_BASELINE_MARKERS) {
      expect(source).not.toContain(marker);
    }
    expect(source).toContain("rejected_left_for_inspection");
    expect(source).toContain("error_left_for_inspection");
  });

  test("descent README documents runtime binding without automatic cleanup", () => {
    const readme = descentReadme();
    expect(readme).toContain("base_branch");
    expect(readme).toContain("git_worktree_dir");
    expect(readme).toContain("Atomic runtime binding");
    expect(readme).toContain(".worktreeFromInputs");
    expect(readme).toContain("preserves the invoking repo-relative subdirectory");
    expect(readme).toContain("does not create accepted-baseline commits");
    expect(readme).toContain("does not run `git reset --hard` or `git clean -ffdx`");
    expect(readme).toContain("manual inspection, cleanup, or retry");
    expect(readme).not.toContain("setupGitWorktree");
  });

  test("exposes the worker preflight contract used by descent implementors", () => {
    expect(WORKER_PREFLIGHT_CONTRACT).toContain("determine whether this checkout appears initialized");
    expect(WORKER_PREFLIGHT_CONTRACT).toContain("Do not rely on hard-coded assumptions");
    expect(WORKER_PREFLIGHT_CONTRACT).toContain("Once setup succeeds, continue normal implementation orchestration");
  });
});
