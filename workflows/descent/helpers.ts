const SAFE_GIT_REF_INPUT_PATTERN = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

export const DEFAULT_DESCENT_BASE_BRANCH = "origin/main";

export type DescentEvaluationDecision = "approve" | "reject" | "error";
export type DescentWorkspaceMode = "primary_checkout" | "reusable_worktree";
export type InspectionTransitionAction =
  | "accepted_evaluation"
  | "rejected_left_for_inspection"
  | "error_left_for_inspection";

export type PreparedDescentWorkspace = {
  readonly mode: DescentWorkspaceMode;
  readonly requestedGitWorktreeDir?: string;
  readonly effectiveWorkflowCwd: string;
};

export function normalizeGitRefInput(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return SAFE_GIT_REF_INPUT_PATTERN.test(trimmed) ? trimmed : fallback;
}

export function normalizeBaseBranchInput(
  value: string | undefined,
  fallback = DEFAULT_DESCENT_BASE_BRANCH,
): string {
  return normalizeGitRefInput(value, fallback);
}

export function normalizeRequestedGitWorktreeDir(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function workspaceModeFromRequestedGitWorktreeDir(
  requestedGitWorktreeDir: string | undefined,
): DescentWorkspaceMode {
  return requestedGitWorktreeDir === undefined
    ? "primary_checkout"
    : "reusable_worktree";
}

export function transitionActionForDecision(
  decision: DescentEvaluationDecision,
): InspectionTransitionAction {
  switch (decision) {
    case "approve":
      return "accepted_evaluation";
    case "reject":
      return "rejected_left_for_inspection";
    case "error":
      return "error_left_for_inspection";
  }
}

export function prepareDescentWorkspace(input: {
  readonly gitWorktreeDir?: string;
  readonly effectiveWorkflowCwd: string;
}): PreparedDescentWorkspace {
  const requestedGitWorktreeDir = normalizeRequestedGitWorktreeDir(
    input.gitWorktreeDir,
  );

  if (requestedGitWorktreeDir === undefined) {
    return {
      mode: "primary_checkout",
      effectiveWorkflowCwd: input.effectiveWorkflowCwd,
    };
  }

  return {
    mode: "reusable_worktree",
    requestedGitWorktreeDir,
    effectiveWorkflowCwd: input.effectiveWorkflowCwd,
  };
}

export const WORKER_PREFLIGHT_CONTRACT = [
  "Before normal implementation delegation, determine whether this checkout appears initialized for its actual language, framework, and build system.",
  "Do not rely on hard-coded assumptions about JavaScript, TypeScript, Python, Rust, Go, Java, mobile, or any other ecosystem. Infer the project type and setup requirements from repository evidence.",
  "Inspect source layout, setup docs, package/build manifests, lockfiles, toolchain files, generated-artifact conventions, CI workflows, workflow configuration, and package scripts or equivalent task definitions.",
  "Look for evidence that dependencies, generated files, local toolchains, submodules, codegen outputs, or other project-specific initialization artifacts are missing for this checkout.",
  "When repository evidence shows missing initialization, run or delegate the appropriate documented setup command before implementation work.",
  "You are responsible for initializing the checkout when setup commands are documented; missing dependencies, generated files, or local toolchains are setup work, not user handoff work.",
  "Once setup succeeds, continue normal implementation orchestration. Do not treat missing dependencies or generated setup artifacts in a fresh worktree as implementation failures.",
  "If setup requirements cannot be determined confidently, delegate a focused discovery task before implementation instead of guessing.",
  "If setup remains blocked after evidence-based discovery and setup attempts, report the blocker with commands tried and the exact evidence needed to continue.",
].join("\n");
