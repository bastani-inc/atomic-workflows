import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { defineWorkflow, Type } from "@bastani/workflows";
import { goal, ralph } from "@bastani/workflows/builtin";

const execFileAsync = promisify(execFile);
const WORKFLOW_NAME = "dex-rich-man-loop";
const FILE_ONLY_OUTPUT = "file-only" as const;

type WorkflowStatus = "approved" | "needs_human" | "failed";

type CommandResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

type PrState = {
  readonly cwd: string;
  readonly branch: string;
  readonly trackingBranch: string;
  readonly statusShortBranch: string;
  readonly prUrl: string;
  readonly prState: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly notes: readonly string[];
  readonly commands: readonly CommandResult[];
};

type PushResult = {
  readonly changed: boolean;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly commitMessage: string;
  readonly summary: string;
  readonly commands: readonly CommandResult[];
};

type IterationSummary = {
  readonly iteration: number;
  readonly feedback: string;
  readonly goalStatus: string;
  readonly goalResult: string;
  readonly pushSummary: string;
};

function text(value: unknown, fallback = ""): string {
  const result = String(value ?? fallback).trim();
  return result.length > 0 ? result : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function excerpt(value: unknown, maxLength = 4_000): string {
  const raw = text(value);
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n\n…[truncated]`;
}

function shellQuote(value: string): string {
  return value.length === 0 ? "''" : `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function runCommand(cwd: string, command: string, args: readonly string[], allowFailure = true): Promise<CommandResult> {
  const printable = [command, ...args].map(shellQuote).join(" ");
  try {
    const result = await execFileAsync(command, [...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      command: printable,
      ok: true,
      stdout: text(result.stdout),
      stderr: text(result.stderr),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown };
    const commandResult = {
      command: printable,
      ok: false,
      stdout: text(err.stdout),
      stderr: text(err.stderr),
      error: text(err.message, String(error)),
    };
    if (!allowFailure) {
      throw new Error(`Command failed: ${printable}\n${commandResult.stderr || commandResult.stdout || commandResult.error}`);
    }
    return commandResult;
  }
}

async function git(cwd: string, args: readonly string[], allowFailure = true): Promise<CommandResult> {
  return await runCommand(cwd, "git", args, allowFailure);
}

function firstUrl(textValue: unknown): string {
  const match = text(textValue).match(/https?:\/\/[^\s)>'"]+/i);
  return match?.[0] ?? "";
}

async function resolveWorkflowCheckout(effectiveCwd: string, gitWorktreeDir: string): Promise<{
  readonly cwd: string;
  readonly ralphGitWorktreeDir: string;
}> {
  if (gitWorktreeDir.trim().length === 0) {
    return { cwd: effectiveCwd, ralphGitWorktreeDir: "" };
  }

  // `.worktreeFromInputs(...)` makes ctx.cwd the reusable worktree checkout.
  // Ralph also supports git_worktree_dir, so pass the absolute root of that
  // already-selected checkout to avoid resolving a relative path twice when
  // Ralph runs as a nested child workflow.
  const root = await git(effectiveCwd, ["rev-parse", "--show-toplevel"]);
  return {
    cwd: effectiveCwd,
    ralphGitWorktreeDir: root.ok ? text(root.stdout, gitWorktreeDir) : gitWorktreeDir,
  };
}

async function discoverPrState(cwd: string, ralphOutputs: Record<string, unknown>): Promise<PrState> {
  const commands: CommandResult[] = [];
  const notes: string[] = [];

  const branch = await git(cwd, ["branch", "--show-current"]);
  commands.push(branch);

  const status = await git(cwd, ["status", "--short", "--branch"]);
  commands.push(status);

  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  commands.push(upstream);
  if (!upstream.ok) notes.push("No remote tracking branch was discovered with `git rev-parse @{u}`.");

  let prUrl = "";
  let prState = "";
  let headRefName = "";
  let baseRefName = "";

  const gh = await runCommand(cwd, "gh", ["pr", "view", "--json", "url,headRefName,baseRefName,state"]);
  commands.push(gh);
  if (gh.ok) {
    try {
      const parsed = JSON.parse(gh.stdout) as {
        url?: unknown;
        state?: unknown;
        headRefName?: unknown;
        baseRefName?: unknown;
      };
      prUrl = text(parsed.url);
      prState = text(parsed.state);
      headRefName = text(parsed.headRefName);
      baseRefName = text(parsed.baseRefName);
    } catch (error) {
      notes.push(`Could not parse gh PR JSON: ${String(error)}`);
    }
  } else {
    notes.push("`gh pr view` did not return PR metadata; falling back to Ralph reports and local git state.");
  }

  if (!prUrl) {
    prUrl = firstUrl(ralphOutputs.pr_report) || firstUrl(ralphOutputs.result) || firstUrl(ralphOutputs.plan);
    if (prUrl) notes.push("PR URL was inferred from Ralph output text rather than `gh pr view`.");
  }
  if (!prUrl) notes.push("PR URL could not be discovered; use the branch/status handoff below.");

  return {
    cwd,
    branch: text(branch.stdout),
    trackingBranch: upstream.ok ? text(upstream.stdout) : "",
    statusShortBranch: text(status.stdout),
    prUrl,
    prState,
    headRefName,
    baseRefName,
    notes,
    commands,
  };
}

async function pushPrUpdate(cwd: string, iteration: number): Promise<PushResult> {
  const commands: CommandResult[] = [];
  const status = await git(cwd, ["status", "--short", "--branch"]);
  commands.push(status);

  const porcelain = await git(cwd, ["status", "--porcelain"]);
  commands.push(porcelain);
  if (!porcelain.ok) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      commitMessage: "",
      summary: "Could not inspect git status; no commit or push attempted.",
      commands,
    };
  }

  if (text(porcelain.stdout).length === 0) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      commitMessage: "",
      summary: "No working tree changes after Goal follow-up; no commit or push needed.",
      commands,
    };
  }

  const branch = await git(cwd, ["branch", "--show-current"]);
  commands.push(branch);
  const currentBranch = text(branch.stdout);
  if (!branch.ok || currentBranch.length === 0) {
    return {
      changed: true,
      committed: false,
      pushed: false,
      commitMessage: "",
      summary: "Changes exist, but the checkout is detached or branch discovery failed; no commit or push attempted.",
      commands,
    };
  }

  commands.push(await git(cwd, ["add", "-A"]));
  const stagedQuiet = await git(cwd, ["diff", "--cached", "--quiet"]);
  commands.push(stagedQuiet);
  if (stagedQuiet.ok) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      commitMessage: "",
      summary: "Working tree changes disappeared after staging check; no commit or push needed.",
      commands,
    };
  }

  const commitMessage = `Apply PR feedback iteration ${iteration}`;
  const commit = await git(cwd, ["commit", "-m", commitMessage]);
  commands.push(commit);
  if (!commit.ok) {
    return {
      changed: true,
      committed: false,
      pushed: false,
      commitMessage,
      summary: "Failed to commit Goal follow-up changes; push was not attempted.",
      commands,
    };
  }

  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  commands.push(upstream);
  const push = upstream.ok && text(upstream.stdout).length > 0
    ? await git(cwd, ["push"])
    : await git(cwd, ["push", "-u", "origin", currentBranch]);
  commands.push(push);

  return {
    changed: true,
    committed: true,
    pushed: push.ok,
    commitMessage,
    summary: push.ok
      ? `Committed and pushed updates to ${upstream.ok ? text(upstream.stdout) : `origin/${currentBranch}`}.`
      : "Committed Goal follow-up changes, but push failed. Inspect command output before continuing.",
    commands,
  };
}

function commandLog(commands: readonly CommandResult[]): string {
  return commands.map((command) => [
    `- \`${command.command}\` — ${command.ok ? "ok" : "failed"}`,
    command.stdout ? `  - stdout: ${command.stdout.replace(/\n/g, "\n    ")}` : "",
    command.stderr ? `  - stderr: ${command.stderr.replace(/\n/g, "\n    ")}` : "",
    command.error ? `  - error: ${command.error}` : "",
  ].filter(Boolean).join("\n")).join("\n");
}

function composeRalphPrompt(request: string, researchPath: string): string {
  return [
    "You are running the initial broad refactor for a PR-backed refactor loop.",
    "",
    `Original user request:\n${request}`,
    "",
    `Read the research artifact at ${researchPath} before planning or implementing.`,
    "Use the research artifact as the source of truth for relevant files, entrypoints, architecture, existing patterns, risks, constraints, likely validation commands, and suggested refactor direction.",
    "Preserve existing behavior unless the user request explicitly says otherwise.",
    "Keep the implementation generalized to the codebase and request; do not apply framework-specific assumptions unless the request or research artifact justifies them.",
    "Create or update a PR for the refactor. Use the existing repository/provider tooling available in the checkout.",
    "When complete, report the branch, PR URL if available, validation performed, remaining risks, and any manual review notes.",
  ].join("\n");
}

function composeGoalObjective(params: {
  readonly request: string;
  readonly feedback: string;
  readonly researchPath: string;
  readonly prUrl: string;
  readonly branch: string;
  readonly baseBranch: string;
}): string {
  return [
    "Apply human PR review feedback to an existing refactor PR.",
    "",
    `Human PR feedback (verbatim):\n${params.feedback}`,
    "",
    `Original user request:\n${params.request}`,
    `Research artifact path: ${params.researchPath}`,
    `PR URL if known: ${params.prUrl || "unknown"}`,
    `Current PR branch if known: ${params.branch || "unknown"}`,
    `Base branch for comparison: ${params.baseBranch}`,
    "",
    `Read the research artifact at ${params.researchPath} before planning or implementing follow-up changes.`,
    "Apply this feedback to the existing PR branch. Do not open a new PR.",
    "Preserve existing behavior unless the original request or human feedback explicitly says otherwise.",
    "Run the most relevant validation you can discover from the research artifact and repository scripts, and report any skipped validation with reasons.",
  ].join("\n");
}

function humanGateMessage(params: {
  readonly iteration: number;
  readonly prState: PrState;
  readonly researchPath: string;
  readonly ralphSummary: string;
  readonly latestSummary: string;
}): string {
  return [
    `Refactor PR review gate (${params.iteration} follow-up rounds completed).`,
    "",
    params.prState.prUrl ? `PR: ${params.prState.prUrl}` : "PR URL: not discovered; inspect the branch/status below.",
    `Current branch: ${params.prState.branch || params.prState.headRefName || "unknown"}`,
    `Tracking branch: ${params.prState.trackingBranch || "unknown"}`,
    `Research artifact: ${params.researchPath}`,
    "",
    "Ralph / latest implementation summary:",
    excerpt(params.latestSummary || params.ralphSummary, 1_500),
    "",
    params.prState.notes.length > 0 ? `Discovery notes:\n${params.prState.notes.map((note) => `- ${note}`).join("\n")}` : "Discovery notes: none.",
    "",
    "Choose how to continue.",
  ].join("\n");
}

function finalReport(params: {
  readonly request: string;
  readonly status: WorkflowStatus;
  readonly researchPath: string;
  readonly prState: PrState;
  readonly ralphOutputs: Record<string, unknown>;
  readonly iterations: readonly IterationSummary[];
  readonly finalReason: string;
  readonly reportPath: string;
}): string {
  return [
    `# ${WORKFLOW_NAME} final report`,
    "",
    `Final status: ${params.status}`,
    `Reason: ${params.finalReason}`,
    "",
    "## Original request",
    params.request,
    "",
    "## Research artifact",
    params.researchPath,
    "",
    "## PR handoff",
    `- PR URL: ${params.prState.prUrl || "unknown"}`,
    `- Branch: ${params.prState.branch || params.prState.headRefName || "unknown"}`,
    `- Tracking branch: ${params.prState.trackingBranch || "unknown"}`,
    `- PR state: ${params.prState.prState || "unknown"}`,
    "",
    "## Initial Ralph summary",
    `- Approved by Ralph reviewers: ${String(params.ralphOutputs.approved ?? "unknown")}`,
    `- Ralph iterations completed: ${String(params.ralphOutputs.iterations_completed ?? "unknown")}`,
    `- Plan path: ${text(params.ralphOutputs.plan_path, "unknown")}`,
    `- Implementation notes: ${text(params.ralphOutputs.implementation_notes_path, "unknown")}`,
    `- Review report: ${text(params.ralphOutputs.review_report_path || params.ralphOutputs.review_report, "unknown")}`,
    "",
    excerpt(params.ralphOutputs.result, 3_000) || "No Ralph result text returned.",
    "",
    "## Follow-up iterations",
    params.iterations.length === 0
      ? "No Goal follow-up iterations were run."
      : params.iterations.map((iteration) => [
        `### Iteration ${iteration.iteration}`,
        "",
        "Feedback:",
        iteration.feedback,
        "",
        `Goal status: ${iteration.goalStatus}`,
        "",
        "Goal result:",
        excerpt(iteration.goalResult, 2_000),
        "",
        "Push summary:",
        iteration.pushSummary,
      ].join("\n")).join("\n\n"),
    "",
    "## PR discovery commands",
    commandLog(params.prState.commands),
    "",
    "## Remaining risks / manual next steps",
    params.status === "approved"
      ? "Human reviewer approved the PR loop. Merge remains a manual repository-owner decision."
      : params.status === "needs_human"
        ? "Human attention is still needed: review the PR, inspect any push/validation gaps above, and rerun or resume with more feedback if desired."
        : "The workflow failed or was aborted. Inspect the stage graph and command logs before reusing the branch.",
    "",
    `Saved report path: ${params.reportPath}`,
  ].join("\n");
}

export default defineWorkflow(WORKFLOW_NAME)
  .description("Research a target area, have Ralph open a PR, then loop human PR feedback through Goal on the same branch until approval.")
  .input("request", Type.String({ description: "The user's generalized refactor request." }))
  .input("base_branch", Type.String({ default: "origin/main", description: "Base branch for Ralph/Goal comparison." }))
  .input("git_worktree_dir", Type.String({ default: "", description: "Optional reusable worktree used consistently for Ralph and follow-up Goal work." }))
  .input("max_ralph_loops", Type.Number({ default: 5, description: "Maximum Ralph loops for the initial implementation." }))
  .input("max_goal_turns", Type.Number({ default: 5, description: "Maximum Goal turns for each follow-up feedback pass." }))
  .worktreeFromInputs({ gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" })
  .output("status", Type.Union([
    Type.Literal("approved"),
    Type.Literal("needs_human"),
    Type.Literal("failed"),
  ], { description: "Final loop status." }))
  .output("pr_url", Type.String({ description: "Best-effort PR URL if discovered; empty string when unknown." }))
  .output("research_path", Type.String({ description: "Path to the research artifact used by Ralph and Goal." }))
  .output("iterations_completed", Type.Number({ description: "Human-feedback Goal follow-up rounds completed after the initial PR." }))
  .output("final_report", Type.String({ description: "Human-readable summary of the workflow run." }))
  .run(async (ctx) => {
    const request = text(ctx.inputs.request);
    const baseBranch = text(ctx.inputs.base_branch, "origin/main");
    const gitWorktreeDir = text(ctx.inputs.git_worktree_dir);
    const maxRalphLoops = positiveInteger(ctx.inputs.max_ralph_loops, 5);
    const maxGoalTurns = positiveInteger(ctx.inputs.max_goal_turns, 5);
    const invocationCwd = ctx.cwd ?? process.cwd();
    const startedAt = new Date();
    const runDir = resolve(invocationCwd, ".atomic", "workflows", "runs", WORKFLOW_NAME, timestampSlug(startedAt));
    await mkdir(runDir, { recursive: true });

    const researchPath = join(runDir, "research.md");
    const ralphPromptPath = join(runDir, "ralph-prompt.md");
    const finalReportPath = join(runDir, "final-report.md");
    const iterations: IterationSummary[] = [];
    let prState: PrState = {
      cwd: invocationCwd,
      branch: "",
      trackingBranch: "",
      statusShortBranch: "",
      prUrl: "",
      prState: "",
      headRefName: "",
      baseRefName: "",
      notes: ["PR discovery did not run."],
      commands: [],
    };
    let ralphOutputs: Record<string, unknown> = {};

    try {
      const checkout = await resolveWorkflowCheckout(invocationCwd, gitWorktreeDir);
      prState = { ...prState, cwd: checkout.cwd };

      // Authored workflows cannot directly run slash skills. This stage is the
      // workflow-native adaptation of /skill:research-codebase: it instructs the
      // agent to follow that skill's research shape and saves a durable artifact.
      await ctx.task("research", {
        context: "fresh",
        output: researchPath,
        outputMode: FILE_ONLY_OUTPUT,
        prompt: [
          "Follow the Atomic research-codebase skill process for this refactor request.",
          "Always perform fresh read-only codebase research before suggesting implementation work, even if the request seems specific.",
          "Use parallel sub-agents when useful for locating files, analyzing current behavior, and finding existing patterns. Document what exists; do not implement changes in this stage.",
          "If compatibility posture is not explicit, infer conservatively that existing behavior must be preserved for this refactor loop and document that assumption rather than stopping for clarification.",
          "",
          `Original user intent:\n${request}`,
          "",
          "Write a durable Markdown research artifact with these sections:",
          "- original user intent",
          "- relevant files and entrypoints",
          "- current architecture",
          "- existing patterns",
          "- risks and constraints",
          "- likely validation commands",
          "- suggested implementation/refactor direction",
          "- open questions or unknowns",
          "",
          `Save the final research artifact to ${researchPath}.`,
        ].join("\n"),
      });

      const ralphPrompt = composeRalphPrompt(request, researchPath);
      await writeFile(ralphPromptPath, `${ralphPrompt}\n`, "utf8");

      const initialRalph = await ctx.workflow(ralph, {
        stageName: "initial-ralph",
        inputs: {
          prompt: ralphPrompt,
          max_loops: maxRalphLoops,
          base_branch: baseBranch,
          git_worktree_dir: checkout.ralphGitWorktreeDir,
          create_pr: true,
        },
      });
      ralphOutputs = initialRalph.outputs as Record<string, unknown>;

      prState = await discoverPrState(checkout.cwd, ralphOutputs);
      let latestSummary = excerpt(ralphOutputs.result || ralphOutputs.pr_report || ralphOutputs.review_report, 3_000);
      let finalStatus: WorkflowStatus = "needs_human";
      let finalReason = "Human attention requested.";

      while (true) {
        const choice = await ctx.ui.select(
          humanGateMessage({
            iteration: iterations.length,
            prState,
            researchPath,
            ralphSummary: excerpt(ralphOutputs.result || ralphOutputs.pr_report, 2_000),
            latestSummary,
          }),
          ["approve and finish", "provide feedback", "pause / needs human", "abort / fail"],
        );

        if (choice === "approve and finish") {
          finalStatus = "approved";
          finalReason = "Human reviewer approved the PR.";
          break;
        }
        if (choice === "pause / needs human") {
          finalStatus = "needs_human";
          finalReason = "Human reviewer paused the PR loop for manual attention.";
          break;
        }
        if (choice === "abort / fail") {
          finalStatus = "failed";
          finalReason = "Human reviewer aborted the PR loop.";
          break;
        }

        const feedback = text(await ctx.ui.editor([
          "Provide PR feedback for the next Goal follow-up pass.",
          "Goal will apply this to the existing PR branch and must not open a new PR.",
          "",
        ].join("\n")));

        if (!feedback) {
          finalStatus = "needs_human";
          finalReason = "Feedback pass requested but no feedback was provided.";
          break;
        }

        const iterationNumber = iterations.length + 1;
        const goalObjective = composeGoalObjective({
          request,
          feedback,
          researchPath,
          prUrl: prState.prUrl,
          branch: prState.branch || prState.headRefName,
          baseBranch,
        });

        const followup = await ctx.workflow(goal, {
          stageName: `goal-followup-${iterationNumber}`,
          inputs: {
            objective: goalObjective,
            max_turns: maxGoalTurns,
            base_branch: baseBranch,
          },
        });

        const push = await pushPrUpdate(checkout.cwd, iterationNumber);
        const pushReportPath = join(runDir, `push-pr-update-${iterationNumber}.md`);
        await writeFile(pushReportPath, [
          `# push-pr-update ${iterationNumber}`,
          "",
          push.summary,
          "",
          `Committed: ${push.committed}`,
          `Pushed: ${push.pushed}`,
          `Commit message: ${push.commitMessage || "n/a"}`,
          "",
          "## Commands",
          commandLog(push.commands),
        ].join("\n"), "utf8");

        const goalOutputs = followup.outputs as Record<string, unknown>;
        latestSummary = [
          `Goal status: ${text(goalOutputs.status, "unknown")}`,
          excerpt(goalOutputs.result || goalOutputs.remaining_work || goalOutputs.review_report, 2_500),
          "",
          `Push summary: ${push.summary}`,
          `Push report: ${pushReportPath}`,
        ].join("\n");

        iterations.push({
          iteration: iterationNumber,
          feedback,
          goalStatus: text(goalOutputs.status, "unknown"),
          goalResult: excerpt(goalOutputs.result || goalOutputs.remaining_work || goalOutputs.review_report, 4_000),
          pushSummary: `${push.summary}\n\nPush report: ${pushReportPath}\n\n${commandLog(push.commands)}`,
        });

        prState = await discoverPrState(checkout.cwd, {
          ...ralphOutputs,
          pr_report: ralphOutputs.pr_report || prState.prUrl,
        });
      }

      const report = finalReport({
        request,
        status: finalStatus,
        researchPath,
        prState,
        ralphOutputs,
        iterations,
        finalReason,
        reportPath: finalReportPath,
      });
      await writeFile(finalReportPath, `${report}\n`, "utf8");

      return {
        status: finalStatus,
        pr_url: prState.prUrl,
        research_path: researchPath,
        iterations_completed: iterations.length,
        final_report: report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      const report = finalReport({
        request,
        status: "failed",
        researchPath,
        prState,
        ralphOutputs,
        iterations,
        finalReason: message,
        reportPath: finalReportPath,
      });
      await writeFile(finalReportPath, `${report}\n`, "utf8");
      return {
        status: "failed" as const,
        pr_url: prState.prUrl,
        research_path: researchPath,
        iterations_completed: iterations.length,
        final_report: report,
      };
    }
  })
  .compile();
