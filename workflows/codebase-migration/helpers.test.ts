import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_MAX_IDIOMATIC_LOOPS,
  DEFAULT_MAX_RESEARCH_CONCURRENCY,
  DEFAULT_MAX_RESEARCH_PARTITIONS,
  DEFAULT_MAX_TRANSLATION_LOOPS,
  buildDeepResearchPrompt,
  buildIdiomaticCleanupPrompt,
  buildLiteralTranslationPrompt,
  formatMigrationRequestReference,
} from "./helpers.ts";
import { resolveMigrationReportPath, writeMigrationReport } from "./report-output.ts";

const workflowSource = () => readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const workflowReadme = () => readFileSync(new URL("./README.md", import.meta.url), "utf8");
const workflowsReadme = () => readFileSync(new URL("../README.md", import.meta.url), "utf8");

type MockSchema = Record<string, unknown>;
type MockTypeOptions = Record<string, unknown>;
type MockWorktreeBinding = {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
};
type MockWorkflowDefinition = {
  name: string;
  inputs?: Record<string, MockSchema>;
  inputSchema?: { properties?: Record<string, MockSchema> };
  inputBindings?: { worktree?: MockWorktreeBinding } | MockWorktreeBinding;
};

function mockSchema(type: string, options: MockTypeOptions = {}): MockSchema {
  return { type, ...options };
}

const Type = {
  String: (options?: MockTypeOptions): MockSchema => mockSchema("string", options),
  Number: (options?: MockTypeOptions): MockSchema => mockSchema("number", options),
  Boolean: (options?: MockTypeOptions): MockSchema => mockSchema("boolean", options),
  Object: (
    properties: Record<string, MockSchema>,
    options: MockTypeOptions = {},
  ): MockSchema => ({
    type: "object",
    properties,
    ...options,
  }),
  Optional: (schema: MockSchema): MockSchema => ({ ...schema, optional: true }),
};

const mockDeepResearchCodebase: MockWorkflowDefinition = { name: "deep-research-codebase" };
const mockRalph: MockWorkflowDefinition = {
  name: "ralph",
  inputs: {
    prompt: Type.String(),
    base_branch: Type.String(),
    git_worktree_dir: Type.String(),
    max_loops: Type.Number(),
  },
  inputBindings: { worktree: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" } },
};

function setMockDeepResearchContract(options: {
  inputs?: Record<string, MockSchema>;
  inputSchema?: { properties?: Record<string, MockSchema> };
  inputBindings?: { worktree?: MockWorktreeBinding } | MockWorktreeBinding;
}): void {
  delete mockDeepResearchCodebase.inputs;
  delete mockDeepResearchCodebase.inputSchema;
  delete mockDeepResearchCodebase.inputBindings;
  if (options.inputs !== undefined) {
    mockDeepResearchCodebase.inputs = options.inputs;
  }
  if (options.inputSchema !== undefined) {
    mockDeepResearchCodebase.inputSchema = options.inputSchema;
  }
  if (options.inputBindings !== undefined) {
    mockDeepResearchCodebase.inputBindings = options.inputBindings;
  }
}

mock.module("@bastani/workflows", () => ({
  Type,
  defineWorkflow(name: string) {
    const state: {
      description: string;
      inputs: Record<string, MockSchema>;
      outputs: Record<string, MockSchema>;
      inputBindings: { worktree?: MockWorktreeBinding };
      run?: unknown;
    } = {
      description: "",
      inputs: {},
      outputs: {},
      inputBindings: {},
    };

    const builder = {
      description(text: string) {
        state.description = text;
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
      worktreeFromInputs(binding: MockWorktreeBinding) {
        state.inputBindings.worktree = { ...binding };
        return builder;
      },
      run(fn: unknown) {
        state.run = fn;
        return builder;
      },
      compile() {
        return Object.freeze({
          __piWorkflow: true,
          name,
          description: state.description,
          inputs: Object.freeze({ ...state.inputs }),
          outputs: Object.freeze({ ...state.outputs }),
          inputBindings: Object.freeze({ ...state.inputBindings }),
          run: state.run,
        });
      },
    };

    return builder;
  },
}));

mock.module("@bastani/workflows/builtin", () => ({
  deepResearchCodebase: mockDeepResearchCodebase,
  ralph: mockRalph,
}));

const workflowModulePromise = import("./index.ts");
const workflowPromise = workflowModulePromise.then((module) => module.default);

type WorkflowCall = {
  workflow: MockWorkflowDefinition;
  stageName: string;
  inputs: Record<string, unknown>;
};

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "codebase-migration-git-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codebase Migration Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codebase-migration@example.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["init", "--bare", ".remote.git"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", ".remote.git"], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

async function runWorkflowWithCalls(options: {
  cwd: string;
  gitWorktreeDir: string;
  baseBranch?: string;
}): Promise<{ outputs: Record<string, unknown>; calls: WorkflowCall[] }> {
  const workflow = await workflowPromise;
  const calls: WorkflowCall[] = [];

  const outputs = await workflow.run({
    cwd: options.cwd,
    inputs: {
      migration_request: "Migrate the legacy service to the target stack",
      base_branch: options.baseBranch ?? DEFAULT_BASE_BRANCH,
      git_worktree_dir: options.gitWorktreeDir,
      max_research_concurrency: 7,
      max_research_partitions: 11,
      max_translation_loops: 3,
      max_idiomatic_loops: 4,
    },
    workflow: async (childWorkflow: MockWorkflowDefinition, childOptions: { stageName: string; inputs: Record<string, unknown> }) => {
      calls.push({ workflow: childWorkflow, stageName: childOptions.stageName, inputs: childOptions.inputs });
      if (childWorkflow === mockDeepResearchCodebase) {
        return {
          research_doc_path: "research/migration.md",
          artifact_dir: "research/artifacts",
          manifest_path: "research/manifest.json",
        };
      }

      return {
        plan_path: `${childOptions.stageName.replaceAll(" ", "-")}.md`,
        implementation_notes_path: `${childOptions.stageName.replaceAll(" ", "-")}-notes.md`,
        review_report_path: `${childOptions.stageName.replaceAll(" ", "-")}-review.md`,
        approved: true,
      };
    },
    task: async () => ({ text: "# Migration handoff\n\nValidation passed." }),
  } as never) as Record<string, unknown>;

  return { outputs, calls };
}

describe("codebase-migration prompt helpers", () => {
  test("deep research prompt includes starter template and inline charter", () => {
    const request = formatMigrationRequestReference("Migrate Rails to Phoenix", "inline");
    const prompt = buildDeepResearchPrompt(request);

    expect(prompt).toContain("senior-engineering discovery for a large codebase migration");
    expect(prompt).toContain("Migrate Rails to Phoenix");
    expect(prompt).toContain("routing, APIs, data models");
    expect(prompt).toContain("literal-translation constraints");
    expect(prompt).toContain("the implementation pass should run");
    expect(prompt).toContain("downstream implementation passes");
    expect(prompt).toContain("research_doc_path");
    expect(prompt).not.toContain("Ralph");
  });

  test("request formatting handles path references without inlining the spec", () => {
    const request = formatMigrationRequestReference("specs/migration.md", "path");

    expect(request.kind).toBe("path");
    expect(request.promptBlock).toContain("Read the migration request/spec at `specs/migration.md`");
    expect(request.promptBlock).toContain("invariant migration charter");
    expect(request.promptBlock).not.toContain("```text");
  });

  test("literal prompt references research path, original request, 1:1 mapping, behavior, duplication, and PR handoff", () => {
    const prompt = buildLiteralTranslationPrompt({
      migrationRequest: formatMigrationRequestReference("Migrate AngularJS to React", "inline"),
      researchDocPath: "research/migration.md",
    });

    expect(prompt).toContain("research/migration.md");
    expect(prompt).toContain("Migrate AngularJS to React");
    expect(prompt).toContain("1:1 translation");
    expect(prompt).toContain("Preserve existing behavior");
    expect(prompt).toContain("keep duplicated code");
    expect(prompt).toContain("Do not perform broad idiomatic refactors");
    expect(prompt).toContain("Prepare the normal pull-request handoff");
    expect(prompt).toContain("Do not deploy or run destructive git cleanup");
    expect(prompt).not.toContain("Ralph");
    expect(prompt).not.toContain("Do not commit, post PRs");
    expect(prompt).not.toContain("Do not post PRs");
  });

  test("idiomatic prompt references research and literal artifacts plus safe deduplication and validation", () => {
    const prompt = buildIdiomaticCleanupPrompt({
      migrationRequest: formatMigrationRequestReference("Migrate Flask to FastAPI", "inline"),
      researchDocPath: "research/flask-fastapi.md",
      literalOutputs: {
        plan_path: "implementation/literal-plan.md",
        implementation_notes_path: "implementation/literal-notes.md",
        review_report_path: "implementation/literal-review.md",
      },
    });

    expect(prompt).toContain("research/flask-fastapi.md");
    expect(prompt).toContain("implementation/literal-plan.md");
    expect(prompt).toContain("idiomatic target-stack cleanup");
    expect(prompt).toContain("Deduplicate only when behavior remains preserved");
    expect(prompt).toContain("Run lint/type-check/focused tests");
    expect(prompt).toContain("Prepare the normal pull-request handoff");
    expect(prompt).toContain("Do not deploy or run destructive git cleanup");
    expect(prompt).not.toContain("Ralph");
    expect(prompt).not.toContain("Do not commit, post PRs");
    expect(prompt).not.toContain("Do not post PRs");
  });
});

describe("codebase-migration report output", () => {
  test("resolves reports under migrations with a date and filename-safe slug", () => {
    const resolved = resolveMigrationReportPath({
      cwd: "/repo",
      summary: "Migrate Rails API -> Phoenix!",
    });

    expect(resolved.reportPath).toMatch(/^\/repo\/migrations\/\d{4}-\d{2}-\d{2}-migrate-rails-api-phoenix\.md$/);
    expect(resolved.filenameSummary).toBe("migrate-rails-api-phoenix");
  });

  test("writes collision-safe migration report paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codebase-migration-report-"));
    try {
      const first = await writeMigrationReport({ cwd: dir, summary: "Legacy App", report: "# Report" });
      const second = await writeMigrationReport({ cwd: dir, summary: "Legacy App", report: "# Report" });

      expect(first.reportPath).toEndWith("legacy-app.md");
      expect(second.reportPath).toEndWith("legacy-app-2.md");
      expect(first.reportPath).not.toBe(second.reportPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit output path overwrites that exact path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codebase-migration-explicit-"));
    const explicitPath = join(dir, "handoff.md");
    try {
      writeFileSync(explicitPath, "old", "utf8");
      const saved = await writeMigrationReport({
        cwd: dir,
        outputPath: "handoff.md",
        summary: "Legacy App",
        report: "# New Report",
      });

      expect(saved.reportPath).toBe(explicitPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codebase-migration workflow contract and docs", () => {
  test("workflow entrypoint exposes only the default runtime export", async () => {
    const module = await workflowModulePromise;
    expect(Object.keys(module)).toEqual(["default"]);
  });

  test("compiled workflow declares inputs, defaults, worktree binding, and core outputs", async () => {
    const workflow = await workflowPromise;

    expect(workflow.name).toBe("codebase-migration");
    expect(workflow.inputs.base_branch?.default).toBe(DEFAULT_BASE_BRANCH);
    expect(workflow.inputs.git_worktree_dir?.default).toBe("");
    expect(workflow.inputs.max_research_concurrency?.default).toBe(DEFAULT_MAX_RESEARCH_CONCURRENCY);
    expect(workflow.inputs.max_research_partitions?.default).toBe(DEFAULT_MAX_RESEARCH_PARTITIONS);
    expect(workflow.inputs.max_translation_loops?.default).toBe(DEFAULT_MAX_TRANSLATION_LOOPS);
    expect(workflow.inputs.max_idiomatic_loops?.default).toBe(DEFAULT_MAX_IDIOMATIC_LOOPS);
    expect(workflow.inputBindings?.worktree).toEqual({
      gitWorktreeDir: "git_worktree_dir",
      baseBranch: "base_branch",
    });
    expect(Object.keys(workflow.outputs)).toEqual([
      "result",
      "migration_report_path",
      "research_doc_path",
      "research_artifact_dir",
      "research_manifest_path",
      "literal_translation",
      "idiomatic_cleanup",
      "approved",
      "worktree_dir",
    ]);
  });

  test("workflow source composes built-in deep research plus two built-in Ralph passes and requires research_doc_path", () => {
    const source = workflowSource();

    expect(source).toContain('import { deepResearchCodebase, ralph } from "@bastani/workflows/builtin";');
    expect(source).not.toContain('import ralphNoPr from "./ralph-no-pr.js";');
    expect(source).toContain("ctx.workflow(deepResearchCodebase");
    expect(source).toContain("const literal = await ctx.workflow(ralph");
    expect(source).toContain("const idiomatic = await ctx.workflow(ralph");
    expect(source.indexOf("const literal = await ctx.workflow(ralph")).toBeLessThan(source.indexOf("const idiomatic = await ctx.workflow(ralph"));
    expect(source).toContain('stageName: "deep research migration surface"');
    expect(source).toContain('stageName: "literal translation pass"');
    expect(source).toContain('stageName: "idiomatic cleanup pass"');
    expect(source).toContain('ctx.task("migration handoff report"');
    expect(source).toContain("research_doc_path, but it was missing");
    expect(source).toContain("requireDeepResearchWorktreeInputs");
    expect(source).toContain("workflowWorktreeBinding");
    expect(source).toContain('worktreeBinding?.gitWorktreeDir === "git_worktree_dir"');
    expect(source).toContain("deepResearchWorktreeInputs");
    expect(source.indexOf("const deepResearchWorktreeInputs = requireDeepResearchWorktreeInputs")).toBeLessThan(source.indexOf("ctx.workflow(deepResearchCodebase"));
    expect(source).not.toContain("ralphNoPr");
    expect(source).not.toContain("setupGitWorktree");
  });

  test("workflow source derives the effective shared worktree and does not forward raw parent git_worktree_dir", () => {
    const source = workflowSource();

    expect(source).toContain("resolveEffectiveWorktreeDir");
    expect(source).toContain('git(["rev-parse", "--show-toplevel"], cwd)');
    expect(source).toContain("requestedGitWorktreeDir: gitWorktreeDir");
    expect(source).toContain("effectiveWorkflowCwd: cwd");
    expect(source.match(/git_worktree_dir:\s*effectiveWorktreeDir/g) ?? []).toHaveLength(2);
    expect(source).toContain("git_worktree_dir: options.effectiveWorktreeDir");
    expect(source).toContain('return "";');
    expect(source).not.toContain("git_worktree_dir: gitWorktreeDir");
    expect(source).not.toMatch(/git_worktree_dir:\s*[^,\n]*ctx\.inputs\.git_worktree_dir/);
  });

  test("workflow commits and pushes the final migrations report to the current branch", async () => {
    setMockDeepResearchContract({
      inputs: {
        prompt: Type.String(),
        max_concurrency: Type.Number(),
      },
    });
    const dir = makeGitRepo();
    try {
      const { outputs } = await runWorkflowWithCalls({ cwd: dir, gitWorktreeDir: "" });
      const reportPath = outputs.migration_report_path as string;
      const committedReport = execFileSync("git", ["show", `HEAD:${reportPath.replace(`${dir}/`, "")}`], { cwd: dir, encoding: "utf8" });
      const currentBranch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
      const remoteHead = execFileSync("git", ["rev-parse", `origin/${currentBranch}`], { cwd: dir, encoding: "utf8" }).trim();
      const localHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

      expect(reportPath).toContain("/migrations/");
      expect(committedReport).toBe("# Migration handoff\n\nValidation passed.\n");
      expect(remoteHead).toBe(localHead);
      expect(outputs.result).toContain("Final migration report committed to");
      expect(outputs.result).toContain("pushed to origin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("workflow source does not pass PR-disable inputs to either built-in Ralph pass", () => {
    const source = workflowSource();

    expect(source).not.toContain("requireRalphPrDisableInputs");
    expect(source).not.toContain("ralphPrDisableInputs");
    expect(source).not.toContain('inputNames.has("create_pr")');
    expect(source).not.toContain('inputNames.has("pull_request_mode")');
    expect(source).not.toContain("prDisableInputs");
    expect(source).not.toContain("refusing to launch Ralph passes");
    expect(source).not.toContain("create_pr: false");
    expect(source).not.toContain('pull_request_mode: "disabled"');
  });

  test("workflow source uses imported built-in Ralph for both implementation passes", () => {
    const source = workflowSource();

    expect(source).toContain("const literal = await ctx.workflow(ralph");
    expect(source).toContain("const idiomatic = await ctx.workflow(ralph");
    expect(source.match(/ctx\.workflow\(ralph/g) ?? []).toHaveLength(2);
    expect(source).not.toContain("ralph-no-pr");
  });

  test("deep research locality guard is a no-op in empty worktree mode", async () => {
    setMockDeepResearchContract({
      inputs: {
        prompt: Type.String(),
        max_concurrency: Type.Number(),
      },
    });
    const dir = makeGitRepo();
    try {
      const { outputs, calls } = await runWorkflowWithCalls({ cwd: dir, gitWorktreeDir: "" });
      const researchCall = calls[0];

      expect(researchCall.workflow).toBe(mockDeepResearchCodebase);
      expect(researchCall.stageName).toBe("deep research migration surface");
      expect(Object.keys(researchCall.inputs).sort()).toEqual(["max_concurrency", "max_partitions", "prompt"]);
      expect(researchCall.inputs.max_concurrency).toBe(7);
      expect(researchCall.inputs.max_partitions).toBe(11);
      expect(outputs.worktree_dir).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deep research locality guard fails fast in reusable-worktree mode when the child cannot bind stages", async () => {
    setMockDeepResearchContract({
      inputs: {
        prompt: Type.String(),
        max_concurrency: Type.Number(),
        git_worktree_dir: Type.String(),
      },
    });
    const dir = makeGitRepo();
    try {
      const workflow = await workflowPromise;
      const calls: WorkflowCall[] = [];

      await expect(workflow.run({
        cwd: dir,
        inputs: {
          migration_request: "Migrate the legacy service",
          base_branch: DEFAULT_BASE_BRANCH,
          git_worktree_dir: "../migration-worktree",
          max_research_concurrency: 7,
          max_research_partitions: 11,
          max_translation_loops: 3,
          max_idiomatic_loops: 4,
        },
        workflow: async (childWorkflow: MockWorkflowDefinition, childOptions: { stageName: string; inputs: Record<string, unknown> }) => {
          calls.push({ workflow: childWorkflow, stageName: childOptions.stageName, inputs: childOptions.inputs });
          return {};
        },
        task: async () => ({ text: "unreachable" }),
      } as never)).rejects.toThrow(/deep-research-codebase.*git_worktree_dir.*worktreeFromInputs.*empty git_worktree_dir/s);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deep research locality guard inspects worktree binding and passes the effective absolute worktree root", async () => {
    setMockDeepResearchContract({
      inputSchema: {
        properties: {
          prompt: Type.String(),
          max_concurrency: Type.Number(),
          git_worktree_dir: Type.String(),
          base_branch: Type.String(),
        },
      },
      inputBindings: { worktree: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" } },
    });
    const dir = makeGitRepo();
    const nested = join(dir, "packages", "app");
    mkdirSync(nested, { recursive: true });
    try {
      const { outputs, calls } = await runWorkflowWithCalls({
        cwd: nested,
        gitWorktreeDir: "../migration-worktree",
        baseBranch: "origin/release",
      });
      const [researchCall, literalCall, idiomaticCall] = calls;

      expect(researchCall.workflow).toBe(mockDeepResearchCodebase);
      expect(researchCall.inputs.git_worktree_dir).toBe(dir);
      expect(researchCall.inputs.git_worktree_dir).not.toBe("../migration-worktree");
      expect(researchCall.inputs.base_branch).toBe("origin/release");
      expect(researchCall.inputs.max_partitions).toBe(11);
      expect(literalCall.workflow).toBe(mockRalph);
      expect(idiomaticCall.workflow).toBe(mockRalph);
      expect(literalCall.inputs.git_worktree_dir).toBe(dir);
      expect(idiomaticCall.inputs.git_worktree_dir).toBe(dir);
      expect(literalCall.inputs.base_branch).toBe("origin/release");
      expect(idiomaticCall.inputs.base_branch).toBe("origin/release");
      expect(literalCall.inputs.max_loops).toBe(3);
      expect(idiomaticCall.inputs.max_loops).toBe(4);
      expect(literalCall.inputs).not.toHaveProperty("create_pr");
      expect(literalCall.inputs).not.toHaveProperty("pull_request_mode");
      expect(idiomaticCall.inputs).not.toHaveProperty("create_pr");
      expect(idiomaticCall.inputs).not.toHaveProperty("pull_request_mode");
      expect(outputs.worktree_dir).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deep research locality guard rejects input-name-only worktree support without a binding", async () => {
    setMockDeepResearchContract({
      inputs: {
        prompt: Type.String(),
        max_concurrency: Type.Number(),
        git_worktree_dir: Type.String(),
      },
      inputBindings: { worktree: { gitWorktreeDir: "other_worktree_dir" } },
    });
    const dir = makeGitRepo();
    try {
      const workflow = await workflowPromise;
      await expect(workflow.run({
        cwd: dir,
        inputs: {
          migration_request: "Migrate the legacy service",
          base_branch: DEFAULT_BASE_BRANCH,
          git_worktree_dir: "../migration-worktree",
          max_research_concurrency: 7,
          max_research_partitions: 11,
          max_translation_loops: 3,
          max_idiomatic_loops: 4,
        },
        workflow: async () => ({}),
        task: async () => ({ text: "unreachable" }),
      } as never)).rejects.toThrow("bind it with worktreeFromInputs/inputBindings.worktree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("README files document registry, stages, worktree behavior, PR ownership, and reports", () => {
    const readme = workflowReadme();
    const registry = workflowsReadme();

    expect(registry).toContain("codebase-migration");
    expect(readme).toContain("deep research migration surface");
    expect(readme).toContain("literal translation pass");
    expect(readme).toContain("idiomatic cleanup pass");
    expect(readme).toContain("migration handoff report");
    expect(readme).toContain("final report commit");
    expect(readme).toContain("stages `migrations/`");
    expect(readme).toContain("pushes that branch to its configured upstream");
    expect(readme).toContain("falling back to `origin`");
    expect(readme).toContain(".worktreeFromInputs");
    expect(readme).toContain("Empty `git_worktree_dir`");
    expect(readme).toContain("parent worktree binding owns `git_worktree_dir`");
    expect(readme).toContain("effective absolute worktree root");
    expect(readme).toContain("git rev-parse --show-toplevel");
    expect(readme).toContain("deep-research-codebase` must declare `git_worktree_dir`");
    expect(readme).toContain("inputBindings.worktree");
    expect(readme).toContain("same `base_branch` for review/diff semantics");
    expect(readme).toContain("./migrations/YYYY-MM-DD-<topic>.md");
    expect(readme).toContain("two imported built-in Ralph implementation passes");
    expect(readme).toContain("literal translation PR");
    expect(readme).toContain("idiomatic cleanup PR");
    expect(readme).toContain("without PR-control inputs");
    expect(readme).toContain("both PR handoffs are owned by built-in Ralph");
    expect(readme).toContain("does **not** deploy");
    expect(readme).not.toContain("create_pr: false");
    expect(readme).not.toContain('pull_request_mode: "disabled"');
    expect(readme).not.toContain("hard PR-disable input");
    expect(readme).not.toContain("Current unsafe Ralph builds");
  });
});
