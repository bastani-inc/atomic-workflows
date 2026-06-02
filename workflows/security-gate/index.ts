import { join } from "node:path";
import { defineWorkflow, Type } from "@bastani/workflows";
import { reportSummaryText, writeWorkflowReport } from "./report-output.js";
import {
  createWorkflowArtifactRun,
  displayPath,
  manifestArtifactPaths,
  markdownArtifact,
  writeWorkflowManifest,
} from "./workflow-artifacts.js";

function text(value: unknown, fallback = ""): string {
  const result = String(value ?? fallback).trim();
  return result.length > 0 ? result : fallback;
}

const WORKFLOW_NAME = "security-gate";
const PROFILE = "deep risk-based";
const FILE_ONLY_OUTPUT = "file-only" as const;
const GATE_DECISIONS = ["pass", "pass-with-warnings", "fail", "inconclusive"] as const;

type GateDecision = (typeof GATE_DECISIONS)[number];

function normalizeGateDecision(output: string): GateDecision {
  const match = output.match(/^\s*Decision:\s*(pass|pass-with-warnings|fail|inconclusive)\s*$/im);
  const decision = match?.[1];
  if (!decision) {
    return "inconclusive";
  }

  return decision.toLowerCase() as GateDecision;
}

function targetGuidance(target: string): string {
  return [
    `User target: ${target || "repo"}`,
    "Infer whether the target is a PR number/URL, branch, commit range, current diff, path, or whole repo.",
    "Derive base/head comparison guidance from the target and repository state instead of requiring explicit base/head fields.",
    "If the target is ambiguous, prefer safe local evidence: git status, current diff, recent commits, mentioned paths, and repository metadata.",
  ].join("\n");
}

export default defineWorkflow(WORKFLOW_NAME)
  .description("Run a local evidence-backed security gate for a PR, branch, diff, path, or repository without applying fixes.")
  .input("target", Type.String({
    description: "PR number/URL, branch, commit range, current diff, path, or repo.",
  }))
  .input("focus", Type.String({
    default: "",
    description: "Optional security-sensitive areas, assets, services, or assumptions.",
  }))
  .output("summary", Type.String({ description: "Short summary of the saved security gate report." }))
  .output("report_path", Type.String({ description: "Path to the saved final security gate report." }))
  .output("filename_summary", Type.String({ description: "Short filename-safe topic summary used for the report." }))
  .output("artifact_dir", Type.String({ description: "Per-run artifact directory containing intermediate security gate artifacts." }))
  .output("manifest_path", Type.String({ description: "Path to the workflow artifact manifest JSON." }))
  .output("stages", Type.Array(Type.String(), { description: "Stage names completed during the security gate run." }))
  .output("decision", Type.Union([
    Type.Literal("pass"),
    Type.Literal("pass-with-warnings"),
    Type.Literal("fail"),
    Type.Literal("inconclusive"),
  ], { description: "Normalized final security gate decision." }))
  .run(async (ctx) => {
    const targetInput = text(ctx.inputs.target, "repo");
    const focus = text(ctx.inputs.focus);
    const startedAt = new Date();
    const { runId, artifactDir } = await createWorkflowArtifactRun(WORKFLOW_NAME, startedAt);
    const artifactPathsByName = new Map<string, string>();
    const addArtifact = (name: string, filename: string): string => {
      const path = markdownArtifact(artifactDir, filename);
      artifactPathsByName.set(name, path);
      return path;
    };
    const fileOnlyOutput = (output: string) => ({ output, outputMode: FILE_ONLY_OUTPUT });
    const scanPolicy = "Run only safe local read-only security scans where useful, such as git diff/status, rg-based secret/config searches, dependency audit commands that do not require risky network access, lint/security scripts, or language-specific analyzers already installed. If a tool, lockfile, dependency install, container, or network access is missing, record the limitation and continue from file evidence. Do not install dependencies, change files, mutate lockfiles, or call external services.";

    const scopePath = addArtifact("scope-detection", "00-scope-detection.md");
    const toolingPath = addArtifact("tooling-discovery", "01-tooling-discovery.md");
    const scansPath = addArtifact("automated-scans", "02-automated-scans.md");
    const reviewPath = addArtifact("secure-code-review", "03-secure-code-review.md");
    const threatModelPath = addArtifact("threat-model-delta", "04-threat-model-delta.md");

    const scopeDetection = await ctx.task("security-scope-detection", {
      prompt: `You are detecting scope for an Atomic security-gate run.\n\n${targetGuidance(targetInput)}\nUser security focus: ${focus || "(none)"}\nInternal defaults: ${PROFILE} profile, safe local read-only scans enabled, threat model delta enabled, auto-generated report path.\n\nInspect the repository directly. Identify changed files, sensitive components, trust boundaries, data classes, auth/authz paths, input surfaces, secrets/config areas, dependency surfaces, and security-relevant unknowns. ${scanPolicy}\n\nDo not modify files, apply remediations, or post comments. Use local evidence and cite paths, commands, outputs, and confidence.`,
      ...fileOnlyOutput(scopePath),
    });

    const tooling = await ctx.task("tooling-discovery", {
      previous: scopeDetection,
      reads: [scopePath],
      prompt: `Discover security tooling and validation options.\n\nRead scope artifact at ${displayPath(scopePath)}. Compact saved-output reference: {previous}\n\nInspect package manifests, lockfiles, CI, scripts, linters, SAST/secret scanning configs, container/devcontainer files, language-specific security tools, and audit commands. Explain what can run safely in this environment and what is unavailable. ${scanPolicy}\n\nDo not install dependencies, change config, or edit files.`,
      ...fileOnlyOutput(toolingPath),
    });

    const automatedScans = await ctx.task("automated-scans", {
      previous: tooling,
      reads: [scopePath, toolingPath],
      prompt: `Run or plan automated scans for the security gate.\n\nRead artifacts before scanning:\n- Scope: ${displayPath(scopePath)}\n- Tooling: ${displayPath(toolingPath)}\n\nCompact saved-output reference: {previous}\nResolved scan policy: safe local read-only scans are enabled.\n\nRun only safe high-signal read-only feasible scans. Capture exact commands, exit status, relevant output, false-positive caveats, and skipped scans. If tools are missing, produce a clear scan plan for a human.\n\nDo not remediate, install packages, mutate lockfiles, or call external services.`,
      ...fileOnlyOutput(scansPath),
    });

    const secureCodeReview = await ctx.task("contextual-secure-code-review", {
      previous: automatedScans,
      reads: [scopePath, toolingPath, scansPath],
      prompt: `Perform contextual secure code review.\n\nRead gate artifacts before reviewing:\n- Scope: ${displayPath(scopePath)}\n- Tooling: ${displayPath(toolingPath)}\n- Automated scans: ${displayPath(scansPath)}\n\nCompact saved-output reference: {previous}\nProfile: ${PROFILE}. Focus: ${focus || "(none)"}.\n\nReview auth/authz, input validation, injection, secrets handling, logging, data exposure, serialization, file/process/network boundaries, dependency/supply-chain risk, CI/release hardening, and operational controls relevant to the target.\n\nFor each finding include severity, exploitability, evidence, affected files, validation status, confidence, and remediation guidance in prose only. Do not change files.`,
      ...fileOnlyOutput(reviewPath),
    });

    const threatModelDelta = await ctx.task("threat-model-delta", {
      previous: secureCodeReview,
      reads: [scopePath, reviewPath],
      prompt: `Create the threat model delta for this gate.\n\nRead artifacts before writing:\n- Scope: ${displayPath(scopePath)}\n- Secure code review: ${displayPath(reviewPath)}\n\nCompact saved-output reference: {previous}\n\nSummarize assets, actors, entry points, trust boundaries, changed assumptions, abuse cases, new or reduced risks, and residual risk. Keep it evidence-backed and scoped to the target/change. Do not modify files.`,
      ...fileOnlyOutput(threatModelPath),
    });

    const gateReadPaths = [scopePath, toolingPath, scansPath, reviewPath, threatModelPath];
    const gateDecision = await ctx.task("gate-decision", {
      previous: threatModelDelta,
      reads: gateReadPaths,
      prompt: `Write the final security-gate decision.\n\nUse the artifact files as the source of detailed evidence instead of relying on inline transcripts:\n${gateReadPaths.map((path) => `- ${displayPath(path)}`).join("\n")}\n\nCompact saved-output reference from threat model stage: {previous}\n\nBegin with a line exactly: Decision: <one of pass, pass-with-warnings, fail, inconclusive>. Use only those four decision labels, with these meanings: pass means no blocking findings; pass-with-warnings means non-blocking risks or notable caveats remain; fail means blocking security risk; inconclusive means evidence is insufficient to decide.\n\nInclude target, inferred refs/comparison scope, focus, profile (${PROFILE}), tooling discovered, scans run/skipped, contextual secure-code-review findings, threat model delta, severity buckets (critical, high, medium, low, informational), evidence for each finding, remediation guidance, false positives/unverified items, residual risk, and next human actions. Be explicit that no remediation was applied and no PR comment was posted.\n\nThe workflow runtime will save this report to disk after this stage. Do not include save-location boilerplate in the report body.`,
    });

    const reportSummary = await ctx.task("report-filename-summary", {
      previous: gateDecision,
      prompt: `Create a short topic summary for this security-gate report filename and return metadata.\n\nGate report:\n{previous}\n\nUser context:\n- Target: ${targetInput}\n- Focus: ${focus || "(none)"}\n\nReturn exactly 2-5 plain words. No markdown, punctuation, quotes, dates, or workflow name.`,
    });

    const savedReport = await writeWorkflowReport({
      workflowName: WORKFLOW_NAME,
      summary: reportSummary.text,
      report: gateDecision.text,
    });
    const manifestPath = join(artifactDir, "manifest.json");
    const completedAt = new Date();
    await writeWorkflowManifest(manifestPath, {
      runId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      input: { target: targetInput, focus },
      finalReportPath: displayPath(savedReport.reportPath),
      artifacts: manifestArtifactPaths(artifactPathsByName, manifestPath),
    });
    const decision = normalizeGateDecision(gateDecision.text);
    const summary = reportSummaryText(reportSummary.text, "security gate report");

    return {
      summary,
      report_path: savedReport.reportPath,
      filename_summary: savedReport.filenameSummary,
      artifact_dir: displayPath(artifactDir),
      manifest_path: displayPath(manifestPath),
      stages: [
        scopeDetection.stageName,
        tooling.stageName,
        automatedScans.stageName,
        secureCodeReview.stageName,
        threatModelDelta.stageName,
        gateDecision.stageName,
        reportSummary.stageName,
      ],
      decision,
    };
  })
  .compile();
