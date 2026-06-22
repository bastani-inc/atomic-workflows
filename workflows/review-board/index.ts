import { join } from "node:path";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
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

const WORKFLOW_NAME = "review-board";
const REVIEW_DEPTH = "deep";
const MODEL_STRATEGY = "default best available multi-model strategy";
const FILE_ONLY_OUTPUT = "file-only" as const;
const CANONICAL_REVIEWERS = ["correctness", "architecture", "testing", "security", "performance"] as const;

type ReviewerRole = (typeof CANONICAL_REVIEWERS)[number];

function targetGuidance(target: string): string {
  return [
    `User target: ${target || "repo"}`,
    "Infer whether the target is a PR number/URL, branch, commit range, current diff, path, or whole repo.",
    "Derive base/head comparison guidance from the target and repository state instead of requiring explicit base/head fields.",
    "If the target is ambiguous, prefer safe local evidence: git status, current diff, recent commits, mentioned paths, and repository metadata.",
  ].join("\n");
}

function rolePrompt(role: ReviewerRole, focus: string): string {
  const shared = `Review focus from user: ${focus || "(none; run a broad deep review)"}\nReview depth: ${REVIEW_DEPTH}\nModel strategy: ${MODEL_STRATEGY}\nInspect files directly and use artifact files supplied via reads. Provide severity-ranked findings with evidence, affected paths, validation steps, confidence, and prose-only remediation suggestions. Do not edit files or post comments.`;

  switch (role) {
    case "correctness":
      return `Review functional correctness, state transitions, edge cases, error handling, compatibility, and user-visible behavior.\n\n${shared}`;
    case "architecture":
      return `Review architecture, maintainability, API boundaries, coupling, migrations, data flow, and consistency with repository patterns.\n\n${shared}`;
    case "testing":
      return `Review test coverage, fixtures, CI impact, regression gaps, and validation quality. Run only safe local read-only or targeted validation commands if useful; if tools or dependencies are missing, say so and continue.\n\n${shared}`;
    case "security":
      return `Review security, privacy, auth/authz, secrets handling, input validation, dependency/supply-chain signals, and sensitive data exposure. Use local evidence only and do not call external services.\n\n${shared}`;
    case "performance":
      return `Review performance, scalability, concurrency, caching, resource usage, latency, memory, and operational risk.\n\n${shared}`;
  }
}

export default workflow({
  name: WORKFLOW_NAME,
  description: "Run a full specialist review board and synthesize an evidence-backed code review without posting comments.",
  inputs: {
    "target": Type.String({
    description: "PR number/URL, branch, commit range, current diff, path, or repo.",
  }),
    "focus": Type.String({
    default: "",
    description: "Optional review emphasis, risk area, subsystem, or reviewer guidance.",
  }),
  },
  outputs: {
    "summary": Type.String({ description: "Short summary of the saved review board report." }),
    "report_path": Type.String({ description: "Path to the saved final review board report." }),
    "filename_summary": Type.String({ description: "Short filename-safe topic summary used for the report." }),
    "artifact_dir": Type.String({ description: "Per-run artifact directory containing intermediate review artifacts." }),
    "manifest_path": Type.String({ description: "Path to the workflow artifact manifest JSON." }),
    "stages": Type.Array(Type.String(), { description: "Stage names completed during the review board run." }),
  },
  run: async (ctx) => {
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

    const targetPath = addArtifact("review-target", "00-review-target.md");
    const packetPath = addArtifact("review-packet", "01-review-packet.md");
    const reviewerPaths: Record<ReviewerRole, string> = {
      correctness: addArtifact("correctness-review", "correctness-review.md"),
      architecture: addArtifact("architecture-review", "architecture-review.md"),
      testing: addArtifact("testing-review", "testing-review.md"),
      security: addArtifact("security-review", "security-review.md"),
      performance: addArtifact("performance-review", "performance-review.md"),
    };
    const consensusPath = addArtifact("consensus", "consensus.md");
    const prCommentPath = addArtifact("pr-comment-draft", "pr-comment-draft.md");

    const target = await ctx.task("review-target-collection", {
      prompt: `You are collecting the target for an Atomic review-board run.\n\n${targetGuidance(targetInput)}\nUser focus: ${focus || "(none)"}\nInternal defaults: deep review, all reviewers enabled (${CANONICAL_REVIEWERS.join(", ")}), ${MODEL_STRATEGY}, PR comment draft enabled, auto-generated report path.\n\nInspect the repository directly. Use git/gh/local files when available to identify changed files, commits, risk areas, base/head guidance, and missing context. If git, gh, network, or provider CLI access is unavailable, degrade gracefully and continue from local diff/files.\n\nDo not modify files, apply patches, or post comments. Cite file paths, commands, outputs, and confidence.`,
      ...fileOnlyOutput(targetPath),
    });

    const packet = await ctx.task("review-packet", {
      previous: target,
      reads: [targetPath],
      prompt: `Prepare the shared review packet for specialist reviewers.\n\nRead the target artifact at ${displayPath(targetPath)}. Compact saved-output reference: {previous}\n\n${targetGuidance(targetInput)}\nUser focus: ${focus || "(none)"}\nBoard composition: all reviewers enabled (${CANONICAL_REVIEWERS.join(", ")}).\n\nSummarize changed behavior, affected files, inferred base/head comparison, architecture context, tests touched/missing, operational risk, and open questions. Include exact paths, relevant symbols, and safe validation commands. Note unavailable tools or incomplete PR metadata. Do not modify files.`,
      ...fileOnlyOutput(packetPath),
    });

    const specialistReports = await ctx.parallel(
      CANONICAL_REVIEWERS.map((role) => ({
        name: `${role}-review`,
        previous: packet,
        reads: [targetPath, packetPath],
        prompt: `${rolePrompt(role, focus)}\n\nRead the shared artifacts before reviewing:\n- Target: ${displayPath(targetPath)}\n- Review packet: ${displayPath(packetPath)}\n\nCompact saved-output reference: {previous}`,
        ...fileOnlyOutput(reviewerPaths[role]),
      })),
      { concurrency: 3, failFast: false },
    );

    const consensus = await ctx.task("consensus-judge", {
      previous: specialistReports,
      reads: CANONICAL_REVIEWERS.map((role) => reviewerPaths[role]),
      prompt: `Judge and synthesize the specialist review reports.\n\nRead all reviewer artifacts instead of relying on inline transcripts:\n${CANONICAL_REVIEWERS.map((role) => `- ${role}: ${displayPath(reviewerPaths[role])}`).join("\n")}\n\nCompact saved-output references: {previous}\nBoard composition: all reviewers (${CANONICAL_REVIEWERS.join(", ")}).\n\nDeduplicate findings, resolve disagreements, discard unsupported claims, and rank issues as blocking, recommended, or informational. For each retained finding include evidence, affected files, validation status, severity, owner-friendly explanation, and confidence. Do not modify files.`,
      ...fileOnlyOutput(consensusPath),
    });

    const prComment = await ctx.task("pr-comment-draft", {
      previous: consensus,
      reads: [consensusPath],
      prompt: `Draft a PR review comment for humans to copy manually.\n\nRead consensus at ${displayPath(consensusPath)}. Compact saved-output reference: {previous}\n\nKeep it concise and actionable. Include blocking findings first, then recommendations and validation notes. Do not auto-post, call PR APIs, or modify files.`,
      ...fileOnlyOutput(prCommentPath),
    });

    const finalReadPaths = [
      targetPath,
      packetPath,
      ...CANONICAL_REVIEWERS.map((role) => reviewerPaths[role]),
      consensusPath,
      prCommentPath,
    ];
    const finalOutput = await ctx.task("final-output", {
      previous: prComment,
      reads: finalReadPaths,
      prompt: `Write the final review-board output.\n\nUse the artifact files as the source of detailed evidence instead of relying on inline specialist transcripts:\n${finalReadPaths.map((path) => `- ${displayPath(path)}`).join("\n")}\n\nCompact saved-output reference from PR comment stage: {previous}\n\nInclude review target, inferred refs/comparison scope, depth (${REVIEW_DEPTH}), board composition (all reviewers), evidence summary, blocking findings, non-blocking recommendations, testing/validation notes, gaps/unknowns, next steps, and the copyable PR comment draft. State explicitly that no changes were applied and no PR comments were posted.`,
    });

    const reportSummary = await ctx.task("report-filename-summary", {
      previous: finalOutput,
      prompt: `Create a short topic summary for this review-board report filename and return metadata.\n\nFinal review report:\n{previous}\n\nUser context:\n- Target: ${targetInput}\n- Focus: ${focus || "(none)"}\n\nReturn exactly 2-5 plain words. No markdown, punctuation, quotes, dates, or workflow name.`,
    });

    const savedReport = await writeWorkflowReport({
      workflowName: WORKFLOW_NAME,
      summary: reportSummary.text,
      report: finalOutput.text,
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
    const summary = reportSummaryText(reportSummary.text, "review board report");

    return {
      summary,
      report_path: savedReport.reportPath,
      filename_summary: savedReport.filenameSummary,
      artifact_dir: displayPath(artifactDir),
      manifest_path: displayPath(manifestPath),
      stages: [
        target.stageName,
        packet.stageName,
        ...specialistReports.map((review) => review.stageName),
        consensus.stageName,
        prComment.stageName,
        finalOutput.stageName,
        reportSummary.stageName,
      ],
    };
  },
});
