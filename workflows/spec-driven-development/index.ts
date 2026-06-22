import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { type TaskContext, renderTaskContexts } from "./helpers.ts";
import { reportFilenameSummary } from "./report-output.js";
import {
  createWorkflowArtifactRun,
  displayPath,
  manifestArtifactPaths,
  markdownArtifact,
  writeWorkflowManifest,
} from "./workflow-artifacts.js";

const WORKFLOW_NAME = "spec-driven-development";
const DEFAULT_MAX_LOOPS = 5;
const MAX_SPEC_REVIEW_ITERATIONS = 10;
const DEFAULT_RESEARCH_CONCURRENCY = 4;
const FILE_ONLY_OUTPUT = "file-only" as const;

const RESEARCH_SKILL_NAME = "research-codebase";
const CREATE_SPEC_SKILL_NAME = "create-spec";
const RALPH_HANDOFF_NOTICE = [
  "Important Ralph handoff behavior:",
  "- This workflow researches, writes, and human-approves a spec; it does not implement code itself.",
  "- After approval it ends with status `approved-ready-for-ralph` and returns a `/workflow ralph ...` command plus machine-readable launch metadata.",
  "- If the parent chat/agent auto-starts Ralph from that metadata, Ralph runs as a separate top-level workflow. The spec-driven workflow can look finished while Ralph is still running.",
  "- Watch the follow-on work with `/workflow status`, open it with `/workflow connect <ralph-run-id>` or F2, and attach with `/workflow attach <ralph-run-id> <stage>`.",
  "- If Ralph or one of its workers uses tmux, the exact tmux attach command is emitted by the Ralph stage/worker output; this workflow cannot know that command before Ralph starts.",
].join("\n");
const CE_BRAINSTORM_SOURCE =
  "https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/skills/ce-brainstorm.md";
const GRILL_ME_SOURCE = "https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me";

const BRAINSTORM_DEFAULT_QUESTION_LIMIT = 3;
const BRAINSTORM_MAX_QUESTION_LIMIT = 6;

type BrainstormQuestion = {
  id?: string;
  kind?: "product" | "technical" | "core_intent";
  probe?: string;
  question: string;
  why?: string;
  recommendation?: string;
  options?: string[];
};

type BrainstormPlan = {
  triage?: "product" | "technical" | "too_vague" | "concrete_enough";
  concrete_enough?: boolean;
  repo_answered?: string[];
  questions?: BrainstormQuestion[];
  assumptions?: string[];
};

type BrainstormAnswer = {
  question: BrainstormQuestion;
  answer: string;
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function artifactPath(directory: string, prompt: string, fallback: string): string {
  const slug = reportFilenameSummary(prompt, fallback);
  return join(directory, `${today()}-${slug}.md`);
}

async function writeArtifact(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");
  return path;
}

function stripMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonObject<T>(content: string, fallback: T): T {
  const stripped = stripJsonFence(content);
  const candidates = [stripped];
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(stripped.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }

  return fallback;
}

function fallbackBrainstormPlan(prompt: string): BrainstormPlan {
  const triage = looksVague(prompt)
    ? "too_vague"
    : isProductShaping(prompt)
      ? "product"
      : "technical";
  const question = triage === "too_vague"
    ? "What core user problem or implementation outcome should this spec focus on first?"
    : triage === "product"
      ? "What user or actor is this primarily for, and what should change for them?"
      : "Which behavior should win if the existing implementation pattern and the requested behavior conflict?";

  return {
    triage,
    concrete_enough: false,
    repo_answered: [],
    assumptions: [],
    questions: [
      {
        kind: triage === "too_vague" ? "core_intent" : triage,
        probe: triage === "too_vague" ? "core intent" : triage === "product" ? "specificity" : "ambiguous behavior",
        question,
        why: "This resolves the highest-impact ambiguity before codebase research and spec writing.",
      },
    ],
  };
}

function normalizeBrainstormPlan(plan: BrainstormPlan, prompt: string): Required<BrainstormPlan> {
  const fallback = fallbackBrainstormPlan(prompt);
  const triage = plan.triage ?? fallback.triage ?? "technical";
  const concreteEnough = Boolean(plan.concrete_enough) || triage === "concrete_enough";
  const rawQuestions = Array.isArray(plan.questions) ? plan.questions : [];
  const questions = rawQuestions
    .filter((question): question is BrainstormQuestion => typeof question?.question === "string" && question.question.trim().length > 0)
    .slice(0, BRAINSTORM_MAX_QUESTION_LIMIT)
    .map((question, index) => ({
      ...question,
      id: question.id ?? `q${index + 1}`,
      question: question.question.trim(),
      options: Array.isArray(question.options)
        ? question.options.filter((option) => typeof option === "string" && option.trim().length > 0).slice(0, 4)
        : undefined,
    }));

  return {
    triage,
    concrete_enough: concreteEnough,
    repo_answered: Array.isArray(plan.repo_answered) ? plan.repo_answered : [],
    questions: concreteEnough ? [] : questions.length > 0 ? questions : fallback.questions ?? [],
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions : [],
  };
}

function formatBrainstormQuestion(question: BrainstormQuestion, index: number): string {
  const parts = [`Question ${index + 1}: ${question.question}`];

  if (question.why) {
    parts.push(`Why this matters: ${question.why}`);
  }

  if (question.recommendation) {
    const recommendation = /^recommended:/i.test(question.recommendation)
      ? question.recommendation
      : `Recommended: ${question.recommendation}`;
    parts.push(recommendation);
  }

  if (question.options && question.options.length > 0) {
    parts.push(`Choices:\n${question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`).join("\n")}`);
  }

  parts.push("Reply with a choice, accept the recommendation, or write a different answer.");
  return parts.join("\n\n");
}

function looksVague(prompt: string): boolean {
  const words = prompt.split(/\s+/).filter(Boolean);
  const hasConcreteTechnicalSignal = /\b(api|endpoint|redis|database|schema|migration|test|bug|error|rate limit|auth|oauth|cli|config|typescript|react|sql|cache|queue|worker)\b/i.test(
    prompt,
  );
  const hasVagueProductSignal = /\b(improve|better|onboarding|activation|experience|flow|idea|explore|maybe|help users|make it easier|something|feature)\b/i.test(
    prompt,
  );

  return words.length < 8 || (hasVagueProductSignal && !hasConcreteTechnicalSignal);
}

function isProductShaping(prompt: string): boolean {
  return /\b(onboarding|activation|retention|pricing|strategy|roadmap|positioning|market|platform|user journey|product)\b/i.test(
    prompt,
  );
}

const APPROVED_STATUS = "Approved";

const INITIAL_FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const YAML_STATUS_PATTERN = /^(\s*)status\s*:.*$/im;
const APPROVED_YAML_STATUS_PATTERN = /^\s*status\s*:\s*Approved\s*$/im;
const TABLE_STATUS_PATTERN = /^(\s*)\|\s*Status\s*\|[^\r\n]*\|\s*$/gim;
const APPROVED_TABLE_STATUS_PATTERN = /^\s*\|\s*Status\s*\|\s*Approved\s*\|\s*$/im;
const BOLD_BULLET_STATUS_PATTERN = /^(\s*[-*]\s+\*\*)Status(\s*:\s*\*\*\s*)[^\r\n]*$/gim;
const APPROVED_BOLD_BULLET_STATUS_PATTERN = /^\s*[-*]\s+\*\*Status\s*:\s*\*\*\s*Approved\s*$/im;
const PLAIN_BULLET_STATUS_PATTERN = /^(\s*[-*]\s+)Status(\s*:\s*)[^\r\n]*$/gim;
const APPROVED_PLAIN_BULLET_STATUS_PATTERN = /^\s*[-*]\s+Status\s*:\s*Approved\s*$/im;
const PLAIN_BODY_STATUS_PATTERN = /^(\s*)Status(\s*:\s*)[^\r\n]*$/gim;
const APPROVED_PLAIN_BODY_STATUS_PATTERN = /^\s*Status\s*:\s*Approved\s*$/im;
const APPROVED_BODY_STATUS_PATTERNS = [
  APPROVED_TABLE_STATUS_PATTERN,
  APPROVED_BOLD_BULLET_STATUS_PATTERN,
  APPROVED_PLAIN_BULLET_STATUS_PATTERN,
  APPROVED_PLAIN_BODY_STATUS_PATTERN,
];

type MarkdownParts = {
  frontmatter?: string;
  body: string;
};

function splitInitialFrontmatter(content: string): MarkdownParts {
  const match = content.match(INITIAL_FRONTMATTER_PATTERN);
  if (!match) {
    return { body: content };
  }

  return {
    frontmatter: match[1],
    body: content.slice(match[0].length),
  };
}

function joinMarkdownParts(parts: MarkdownParts): string {
  if (parts.frontmatter === undefined) {
    return parts.body;
  }

  return `---\n${parts.frontmatter}\n---\n${parts.body}`;
}

function normalizeYamlStatus(frontmatter: string): string {
  if (YAML_STATUS_PATTERN.test(frontmatter)) {
    return frontmatter.replace(YAML_STATUS_PATTERN, `$1status: ${APPROVED_STATUS}`);
  }

  return `${frontmatter.trimEnd()}\nstatus: ${APPROVED_STATUS}`;
}

function normalizeBodyStatuses(body: string): { body: string; hadStatus: boolean } {
  let hadStatus = false;
  let nextBody = body.replace(TABLE_STATUS_PATTERN, (_match: string, indent: string) => {
    hadStatus = true;
    return `${indent}| Status | ${APPROVED_STATUS} |`;
  });

  nextBody = nextBody.replace(BOLD_BULLET_STATUS_PATTERN, (_match: string, prefix: string, suffix: string) => {
    hadStatus = true;
    return `${prefix}Status${suffix}${APPROVED_STATUS}`;
  });

  nextBody = nextBody.replace(PLAIN_BULLET_STATUS_PATTERN, (_match: string, prefix: string, suffix: string) => {
    hadStatus = true;
    return `${prefix}Status${suffix}${APPROVED_STATUS}`;
  });

  nextBody = nextBody.replace(PLAIN_BODY_STATUS_PATTERN, (_match: string, prefix: string, suffix: string) => {
    hadStatus = true;
    return `${prefix}Status${suffix}${APPROVED_STATUS}`;
  });

  return { body: nextBody, hadStatus };
}

function insertApprovedStatus(body: string): string {
  const withHeadingStatus = body.replace(/^(# .+\n)/, `$1\nStatus: ${APPROVED_STATUS}\n`);
  return withHeadingStatus === body ? `Status: ${APPROVED_STATUS}\n\n${body}` : withHeadingStatus;
}

function markApproved(content: string): string {
  const parts = splitInitialFrontmatter(content);
  let hadStatus = false;

  if (parts.frontmatter !== undefined) {
    parts.frontmatter = normalizeYamlStatus(parts.frontmatter);
    hadStatus = true;
  }

  const normalizedBody = normalizeBodyStatuses(parts.body);
  parts.body = normalizedBody.body;
  hadStatus = hadStatus || normalizedBody.hadStatus;

  if (!hadStatus) {
    parts.body = insertApprovedStatus(parts.body);
  }

  return joinMarkdownParts(parts);
}

function containsMatch(content: string, pattern: RegExp): boolean {
  return content.search(pattern) !== -1;
}

function hasApprovedStatus(content: string): boolean {
  const parts = splitInitialFrontmatter(content);
  return Boolean(
    (parts.frontmatter !== undefined && containsMatch(parts.frontmatter, APPROVED_YAML_STATUS_PATTERN))
      || APPROVED_BODY_STATUS_PATTERNS.some((pattern) => containsMatch(parts.body, pattern)),
  );
}

type SpecReviewDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "revise"; feedback: string };

const SPEC_APPROVAL_REPLIES = new Set([
  "approve",
  "approved",
  "lgtm",
  "looks good",
  "looks good to me",
  "ship",
  "ship it",
]);

const SPEC_REJECTION_REPLIES = new Set([
  "reject",
  "rejected",
  "cancel",
  "stop",
]);

function normalizeSpecReviewReply(reply: string): string {
  return reply
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSpecReviewDecision(reply: string): SpecReviewDecision {
  const normalized = normalizeSpecReviewReply(reply);

  if (SPEC_APPROVAL_REPLIES.has(normalized)) {
    return { action: "approve" };
  }

  if (SPEC_REJECTION_REPLIES.has(normalized)) {
    return { action: "reject" };
  }

  return { action: "revise", feedback: reply.trim() };
}

function specReviewPrompt(specPath: string, reviewIteration: number): string {
  const reviewLabel = reviewIteration === 1 ? "draft" : `revision ${reviewIteration - 1}`;

  return [
    `Spec ${reviewLabel} is ready:`,
    "",
    specPath,
    "",
    "Open/read that Markdown file in the repo, then reply in this same box with one of:",
    "- approve / approved / lgtm / looks good / ship",
    "- reject / rejected / cancel / stop",
    "- requested changes, questions, or edits for another revision",
    "",
    "The workflow will keep updating this same spec file until you approve or reject it.",
  ].join("\n");
}

function stageTools(extra: string[] = []): string[] {
  return [
    "read",
    "bash",
    "todo",
    "web_search",
    "code_search",
    "fetch_content",
    "get_search_content",
    ...extra,
  ];
}

function researchTools(extra: string[] = []): string[] {
  return [
    "read",
    "bash",
    "web_search",
    "code_search",
    "fetch_content",
    "get_search_content",
    ...extra,
  ];
}

function commandText(command: string, args: string[], fallback: string): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function researchFrontmatter(topic: string): string {
  const gitCommit = commandText("git", ["rev-parse", "--verify", "HEAD"], "no-commits");
  const branch = commandText(
    "git",
    ["branch", "--show-current"],
    commandText("git", ["rev-parse", "--abbrev-ref", "HEAD"], "unborn"),
  );
  const root = commandText("git", ["rev-parse", "--show-toplevel"], "");
  const repository = root.length > 0 ? basename(root) : "unknown-repo";

  return [
    "---",
    `date: ${yamlString(new Date().toISOString())}`,
    `researcher: ${yamlString("Atomic spec-driven-development workflow")}`,
    `git_commit: ${yamlString(gitCommit)}`,
    `branch: ${yamlString(branch)}`,
    `repository: ${yamlString(repository)}`,
    `topic: ${yamlString(topic)}`,
    "tags: [research, codebase, spec-driven-development]",
    "status: complete",
    `last_updated: ${yamlString(today())}`,
    `last_updated_by: ${yamlString("Atomic spec-driven-development workflow")}`,
    "---",
  ].join("\n");
}

export default workflow({
  name: "spec-driven-development",
  description: "Spec Driven Development wrapper: brainstorm/direct intake → research → spec → HIL approval → separate Ralph handoff; monitor follow-on Ralph with /workflow status/connect.",
  inputs: {
    "mode": Type.Union([
    Type.Literal("brainstorm"),
    Type.Literal("direct"),
    Type.Literal("auto"),
  ], {
    default: "auto",
    description: "brainstorm does silent triage, repo scout, focused clarification, and a compact brief; direct skips it; auto chooses based on prompt specificity.",
  }),
    "prompt": Type.String({
    description: "Feature idea, implementation intent, or problem statement to turn into an approved spec.",
  }),
    "max_loops": Type.Number({
    default: DEFAULT_MAX_LOOPS,
    description: "Maximum Ralph implementation loop count after spec approval. Used by the follow-on Ralph workflow; this workflow ends at handoff.",
  }),
  },
  outputs: {
    "status": Type.Union([
    Type.Literal("approved-ready-for-ralph"),
    Type.Literal("rejected"),
    Type.Literal("stopped"),
  ], { description: "Final spec-driven workflow status." }),
    "mode": Type.Union([
    Type.Literal("brainstorm"),
    Type.Literal("direct"),
    Type.Literal("auto"),
  ], { description: "Resolved intake mode used for the workflow run." }),
    "brainstorm_brief_path": Type.Optional(Type.String({ description: "Path to the brainstorm brief when brainstorm mode produced one." })),
    "research_path": Type.String({ description: "Path to the saved codebase research artifact." }),
    "research_artifact_dir": Type.String({ description: "Per-run artifact directory containing intermediate research artifacts." }),
    "research_manifest_path": Type.String({ description: "Path to the research artifact manifest JSON." }),
    "spec_path": Type.String({ description: "Path to the generated spec document." }),
    "approved_spec_path": Type.Optional(Type.String({ description: "Path to the approved spec when the review gate approved it." })),
    "ralph_workflow": Type.Optional(Type.String({ description: "Follow-on workflow name to launch after approval." })),
    "ralph_prompt": Type.Optional(Type.String({ description: "Prompt to pass to the follow-on Ralph workflow after approval." })),
    "ralph_inputs": Type.Optional(Type.Object({
    prompt: Type.String(),
    max_loops: Type.Number(),
  }, { description: "Inputs to pass to the follow-on Ralph workflow after approval." })),
    "ralph_command": Type.Optional(Type.String({ description: "Copyable command to launch the follow-on Ralph workflow after approval." })),
    "max_loops": Type.Optional(Type.Number({ description: "Maximum Ralph implementation loop count requested for the follow-on workflow." })),
    "message": Type.String({ description: "Human-readable completion or handoff message." }),
  },
  run: async (ctx) => {
    const initialPrompt = text(ctx.inputs.prompt);
    const requestedMode = text(ctx.inputs.mode, "auto") as "brainstorm" | "direct" | "auto";
    const resolvedMode = requestedMode === "auto"
      ? looksVague(initialPrompt)
        ? "brainstorm"
        : "direct"
      : requestedMode;
    const maxLoops = positiveInteger(ctx.inputs.max_loops, DEFAULT_MAX_LOOPS);

    let implementationIntent: TaskContext;
    let brainstormBriefPath = "";

    if (resolvedMode === "brainstorm") {
      const brainstormScout = await ctx.task("brainstorm-context-scout", {
        prompt: `Before asking the user anything, do a lightweight repo/context scout for this requested brainstorm.

Original prompt:
${initialPrompt}

Look only for high-signal context; this is not full research. Borrow the /grill-me rule: if the repo can answer it, do not ask the user.

Scout for:
- existing specs, brainstorms, research, docs, ADRs, tickets, or README guidance
- similar features, commands, workflows, options, components, tests, or implementation patterns
- obvious architecture/product constraints that should shape recommended answers

Return concise Markdown with:
1. Existing specs/docs found
2. Similar features or patterns
3. Obvious constraints
4. Questions the repo already answers
5. Remaining ambiguity candidates`,
        tools: researchTools(),
      });

      const brainstormPlanDraft = await ctx.task("brainstorm-silent-triage", {
        previous: brainstormScout,
        prompt: `Silently triage this spec-driven-development brainstorm using ideas from:
- Compound Engineering ce-brainstorm: ${CE_BRAINSTORM_SOURCE}
- Matt Pocock /grill-me: ${GRILL_ME_SOURCE}

Original prompt:
${initialPrompt}

Lightweight repo/context scout:
{previous}

Decide whether the unresolved ambiguity is product-shaped, technical/design-shaped, too vague, or concrete enough. Do not add user-facing ceremony. Do not ask questions whose answers were discoverable from the repo scout.

Select only the top unresolved questions, in priority order:
- 0 questions if the prompt is concrete enough
- 1-2 questions for the common case
- 3 questions by default for vague but manageable prompts
- up to 6 only as reserve questions if the user later asks to brainstorm more

Allowed product probes:
- Specificity: who is this for?
- Outcome: what changes for them?
- Evidence/current pain: why now?
- Counterfactual: what happens today if we do nothing?
- Scope boundary: what should this not do?

Allowed technical probes:
- Which behavior should win in ambiguous cases?
- What is the rollout/backcompat expectation?
- What existing pattern should we preserve?
- What failure mode matters most?
- What is explicitly out of scope?

For every technical question, include a recommended answer that cites the repo pattern or constraint it matches.

Output only JSON, no code fences, with this shape:
{
  "triage": "product" | "technical" | "too_vague" | "concrete_enough",
  "concrete_enough": boolean,
  "repo_answered": ["short facts the repo answered"],
  "assumptions": ["assumptions safe to carry into the direction check"],
  "questions": [
    {
      "id": "q1",
      "kind": "product" | "technical" | "core_intent",
      "probe": "specificity | outcome | evidence | counterfactual | scope boundary | ambiguous behavior | rollout/backcompat | existing pattern | failure mode | core intent",
      "question": "one user-facing question",
      "why": "short reason this is unresolved and high-value",
      "recommendation": "for technical questions: Recommended: X, because it matches the existing pattern in path/symbol Y; optional for product/core-intent",
      "options": ["optional concise choice", "optional concise choice", "optional concise choice"]
    }
  ]
}`,
        tools: [],
      });
      const brainstormPlan = normalizeBrainstormPlan(
        parseJsonObject<BrainstormPlan>(brainstormPlanDraft.text, fallbackBrainstormPlan(initialPrompt)),
        initialPrompt,
      );
      const brainstormAnswers: BrainstormAnswer[] = [];
      const firstQuestionCount = Math.min(
        brainstormPlan.questions.length,
        brainstormPlan.concrete_enough ? 0 : BRAINSTORM_DEFAULT_QUESTION_LIMIT,
      );

      for (let index = 0; index < firstQuestionCount; index += 1) {
        const question = brainstormPlan.questions[index];
        const answer = await ctx.ui.input(formatBrainstormQuestion(question, index));
        brainstormAnswers.push({ question, answer: text(answer, "No explicit answer provided.") });
      }

      let scopeAdjustment = "";
      let directionShape = await ctx.task("brainstorm-direction-check", {
        previous: renderTaskContexts([
          { name: "context-scout", text: brainstormScout.text },
          { name: "silent-triage", text: JSON.stringify(brainstormPlan, null, 2) },
          { name: "answers", text: JSON.stringify(brainstormAnswers, null, 2) },
        ]),
        prompt: `Create one compact direction check for this brainstorm. Keep it short; this replaces any large synthesis phase.

Original prompt:
${initialPrompt}

Context:
{previous}

Output exactly this Markdown shape and fill every bullet concisely:
Here’s the shape I’ll spec:

- User/problem:
- Desired outcome:
- Key behavior:
- Important constraints:
- Non-goals:
- Assumptions I’ll carry into research/spec:

Proceed with codebase research?`,
        tools: [],
      });

      let directionDecision = await ctx.ui.select(
        stripMarkdownFence(directionShape.text),
        ["Proceed", "Adjust scope", "Ask me another question", "Skip brainstorm / use original prompt"] as const,
      );
      let askedQuestionCount = brainstormAnswers.length;

      while (directionDecision === "Ask me another question" && askedQuestionCount < BRAINSTORM_MAX_QUESTION_LIMIT) {
        const nextQuestion = brainstormPlan.questions[askedQuestionCount] ?? {
          kind: brainstormPlan.triage === "product" ? "product" : "technical",
          probe: brainstormPlan.triage === "product" ? "scope boundary" : "explicitly out of scope",
          question: "What is explicitly out of scope for this spec?",
          why: "You asked to brainstorm more, and an explicit non-goal is the safest remaining boundary to clarify.",
          recommendation: brainstormPlan.triage === "technical"
            ? "Recommended: preserve the smallest behavior change that fits existing patterns found in the repo scout."
            : undefined,
        };
        const answer = await ctx.ui.input(formatBrainstormQuestion(nextQuestion, askedQuestionCount));
        brainstormAnswers.push({ question: nextQuestion, answer: text(answer, "No explicit answer provided.") });
        askedQuestionCount = brainstormAnswers.length;

        directionShape = await ctx.task(`brainstorm-direction-check-${askedQuestionCount}`, {
          previous: renderTaskContexts([
            { name: "context-scout", text: brainstormScout.text },
            { name: "silent-triage", text: JSON.stringify(brainstormPlan, null, 2) },
            { name: "answers", text: JSON.stringify(brainstormAnswers, null, 2) },
            { name: "scope-adjustment", text: scopeAdjustment },
          ]),
          prompt: `Refresh the compact direction check after the latest brainstorm answer.

Original prompt:
${initialPrompt}

Context:
{previous}

Output exactly this Markdown shape and fill every bullet concisely:
Here’s the shape I’ll spec:

- User/problem:
- Desired outcome:
- Key behavior:
- Important constraints:
- Non-goals:
- Assumptions I’ll carry into research/spec:

Proceed with codebase research?`,
          tools: [],
        });
        directionDecision = await ctx.ui.select(
          stripMarkdownFence(directionShape.text),
          ["Proceed", "Adjust scope", "Ask me another question", "Skip brainstorm / use original prompt"] as const,
        );
      }

      if (directionDecision === "Ask me another question") {
        directionDecision = await ctx.ui.select(
          `Brainstorm question limit reached.\n\n${stripMarkdownFence(directionShape.text)}`,
          ["Proceed", "Adjust scope", "Skip brainstorm / use original prompt"] as const,
        );
      }

      if (directionDecision === "Adjust scope") {
        scopeAdjustment = await ctx.ui.input(
          `What should I adjust before research/spec generation?\n\nCurrent direction:\n\n${stripMarkdownFence(directionShape.text)}`,
        );
        directionShape = await ctx.task("brainstorm-direction-check-adjusted", {
          previous: renderTaskContexts([
            { name: "context-scout", text: brainstormScout.text },
            { name: "silent-triage", text: JSON.stringify(brainstormPlan, null, 2) },
            { name: "answers", text: JSON.stringify(brainstormAnswers, null, 2) },
            { name: "scope-adjustment", text: scopeAdjustment },
          ]),
          prompt: `Apply the user's scope adjustment and create the final compact direction check.

Original prompt:
${initialPrompt}

Context:
{previous}

Output exactly this Markdown shape and fill every bullet concisely:
Here’s the shape I’ll spec:

- User/problem:
- Desired outcome:
- Key behavior:
- Important constraints:
- Non-goals:
- Assumptions I’ll carry into research/spec:

Proceed with codebase research?`,
          tools: [],
        });
        directionDecision = await ctx.ui.select(
          stripMarkdownFence(directionShape.text),
          ["Proceed", "Ask me another question", "Skip brainstorm / use original prompt"] as const,
        );
      }

      if (directionDecision === "Ask me another question" && askedQuestionCount < BRAINSTORM_MAX_QUESTION_LIMIT) {
        const nextQuestion = brainstormPlan.questions[askedQuestionCount] ?? {
          kind: "technical",
          probe: "explicitly out of scope",
          question: "What is explicitly out of scope for this spec?",
          why: "This is the safest final branch to resolve before codebase research.",
          recommendation: "Recommended: keep anything not required for the clarified outcome out of this spec.",
        };
        const answer = await ctx.ui.input(formatBrainstormQuestion(nextQuestion, askedQuestionCount));
        brainstormAnswers.push({ question: nextQuestion, answer: text(answer, "No explicit answer provided.") });
        directionShape = await ctx.task("brainstorm-direction-check-final-extra", {
          previous: renderTaskContexts([
            { name: "context-scout", text: brainstormScout.text },
            { name: "silent-triage", text: JSON.stringify(brainstormPlan, null, 2) },
            { name: "answers", text: JSON.stringify(brainstormAnswers, null, 2) },
            { name: "scope-adjustment", text: scopeAdjustment },
          ]),
          prompt: `Create the final compact direction check after the final extra brainstorm question.

Original prompt:
${initialPrompt}

Context:
{previous}

Output exactly this Markdown shape and fill every bullet concisely:
Here’s the shape I’ll spec:

- User/problem:
- Desired outcome:
- Key behavior:
- Important constraints:
- Non-goals:
- Assumptions I’ll carry into research/spec:

Proceed with codebase research?`,
          tools: [],
        });
        directionDecision = await ctx.ui.select(
          stripMarkdownFence(directionShape.text),
          ["Proceed", "Skip brainstorm / use original prompt"] as const,
        );
      }

      if (directionDecision === "Ask me another question") {
        directionDecision = await ctx.ui.select(
          `No more brainstorm questions are available before research.\n\n${stripMarkdownFence(directionShape.text)}`,
          ["Proceed", "Skip brainstorm / use original prompt"] as const,
        );
      }

      if (directionDecision === "Skip brainstorm / use original prompt") {
        implementationIntent = {
          name: "original-prompt",
          text: `Brainstorm skipped at confirmation. Treat the original prompt as implementation intent and proceed to codebase research.\n\n${initialPrompt}`,
        };
      } else {
        const brainstormBrief = await ctx.task("brainstorm-brief", {
          previous: renderTaskContexts([
            { name: "context-scout", text: brainstormScout.text },
            { name: "silent-triage", text: JSON.stringify(brainstormPlan, null, 2) },
            { name: "answers", text: JSON.stringify(brainstormAnswers, null, 2) },
            { name: "scope-adjustment", text: scopeAdjustment },
            { name: "direction-check", text: stripMarkdownFence(directionShape.text) },
          ]),
          prompt: `Write a small brainstorm brief to feed codebase research and spec generation. This should not become a second PRD.

Original prompt:
${initialPrompt}

Brainstorm context:
{previous}

Output only concise Markdown with these sections:
- Original prompt
- Clarified intent
- User / actor
- Desired outcome
- Decisions made
- Non-goals
- Assumptions / open questions
- Research focus`,
          tools: [],
        });

        brainstormBriefPath = artifactPath("docs/brainstorms", initialPrompt, "brainstorm-brief");
        await writeArtifact(brainstormBriefPath, stripMarkdownFence(brainstormBrief.text));
        implementationIntent = {
          name: "brainstorm-brief",
          text: `Brainstorm brief written to ${brainstormBriefPath}.\n\n${stripMarkdownFence(brainstormBrief.text)}`,
        };
      }
    } else {
      implementationIntent = {
        name: "direct-implementation-intent",
        text: `Direct mode: skip product brainstorming. Treat the following prompt as implementation intent and proceed to codebase research.\n\n${initialPrompt}`,
      };
    }

    const researchPath = artifactPath("research/docs", initialPrompt, "spec-driven-development-research");
    const researchStartedAt = new Date();
    const { runId: researchRunId, artifactDir: researchArtifactDir } = await createWorkflowArtifactRun(
      `${WORKFLOW_NAME}-research`,
      researchStartedAt,
    );
    const researchArtifactPathsByName = new Map<string, string>();
    const addResearchArtifact = (name: string, filename: string): string => {
      const path = markdownArtifact(researchArtifactDir, filename);
      researchArtifactPathsByName.set(name, path);
      return path;
    };
    const fileOnlyOutput = (output: string) => ({ output, outputMode: FILE_ONLY_OUTPUT });

    const researchIntakePath = addResearchArtifact("research-intake", "00-research-intake.md");
    const liveLocatorPath = addResearchArtifact("live-codebase-locator", "01-live-codebase-locator.md");
    const historyLocatorPath = addResearchArtifact("research-history-locator", "02-research-history-locator.md");
    const externalScoutPath = addResearchArtifact("external-relevance-scout", "03-external-relevance-scout.md");
    const analyzerPath = addResearchArtifact("codebase-analyzer", "04-codebase-analyzer.md");
    const patternFinderPath = addResearchArtifact("pattern-finder", "05-pattern-finder.md");
    const historyAnalyzerPath = addResearchArtifact("research-history-analyzer", "06-research-history-analyzer.md");
    const onlineResearchPath = addResearchArtifact("online-research", "07-online-research.md");

    const researchIntake = await ctx.task("research-intake-and-question", {
      previous: implementationIntent,
      prompt: `Port the behavior of the built-in ${RESEARCH_SKILL_NAME} skill into this workflow-owned research plan. Do not launch subagents and do not ask the user questions.

Implementation intent / requirements input:
{previous}

Hard constraints:
- Do not implement anything.
- If the input directly mentions files, tickets, specs, docs, or notes, read those files fully before producing this artifact.
- Optimize/refine the research question for codebase investigation.
- Decompose the work into live codebase research, prior research/history, pattern discovery, and external-doc research only when material.
- Document ambiguity as Open Questions instead of asking for clarification.
- Keep this artifact compact but evidence-oriented.

Output Markdown with these sections:
1. Original Input
2. Optimized Research Question
3. Directly Mentioned Files Read
4. Research Areas
5. Expected Evidence Sources
6. Open Questions`,
      tools: researchTools(),
      ...fileOnlyOutput(researchIntakePath),
    });

    const initialResearch = await ctx.parallel(
      [
        {
          name: "live-codebase-locator",
          previous: researchIntake,
          reads: [researchIntakePath],
          prompt: `Act as the workflow-native equivalent of the research-codebase live locator branch.

Read the research intake artifact at ${displayPath(researchIntakePath)}. Compact saved-output reference: {previous}

Find where the relevant code, tests, configs, docs, commands, entry points, and symbols live. Inspect the live repository as source of truth. Document what exists; do not recommend changes and do not implement anything.

Return Markdown with:
1. Must-read paths
2. Supporting paths
3. Entry points / symbols
4. Tests and validation locations
5. Gaps or uncertainty`,
          tools: researchTools(),
          ...fileOnlyOutput(liveLocatorPath),
        },
        {
          name: "research-history-locator",
          previous: researchIntake,
          reads: [researchIntakePath],
          prompt: `Act as the workflow-native equivalent of the research-codebase history locator branch.

Read the research intake artifact at ${displayPath(researchIntakePath)}. Compact saved-output reference: {previous}

Search research/, specs/, docs, tickets, ADRs, notes, README files, and similar project-history locations for prior decisions or historical context relevant to the optimized research question. Document what exists, including stale or superseded signals.

Return a Markdown table with columns: Path, Evidence, Relevance, Confidence, Freshness / Staleness Notes. If nothing relevant exists, state where you looked.`,
          tools: researchTools(),
          ...fileOnlyOutput(historyLocatorPath),
        },
        {
          name: "external-relevance-scout",
          previous: researchIntake,
          reads: [researchIntakePath],
          prompt: `Decide whether external documentation or online research materially affects this codebase research.

Read the research intake artifact at ${displayPath(researchIntakePath)}. Compact saved-output reference: {previous}

Inspect dependency manifests, imports, lockfiles, package metadata, config, and code references as needed. Do not browse just to browse. Identify external libraries, standards, APIs, or framework behavior that should be verified later, and explain why. If online research is unnecessary, say so clearly.

Return Markdown with:
1. External research needed? yes/no/uncertain
2. Candidate sources or libraries
3. Local evidence that makes them relevant
4. Questions for the online research branch`,
          tools: researchTools(),
          ...fileOnlyOutput(externalScoutPath),
        },
      ],
      { concurrency: DEFAULT_RESEARCH_CONCURRENCY, failFast: false },
    );

    const detailedResearch = await ctx.parallel(
      [
        {
          name: "codebase-behavior-analyzer",
          previous: initialResearch,
          reads: [researchIntakePath, liveLocatorPath],
          prompt: `Act as the workflow-native equivalent of the research-codebase analyzer branch.

Read:
- Research intake: ${displayPath(researchIntakePath)}
- Live locator: ${displayPath(liveLocatorPath)}

Compact saved-output references: {previous}

Analyze how the relevant code currently works: behavior, control flow, data flow, lifecycle, error handling, invariants, tests, and integration points. Prioritize concrete file paths and line references. Document what exists; do not critique, recommend, or implement.

Return Markdown with:
1. Behavioral model
2. Key flows and invariants
3. Cross-component connections
4. Tests / validation
5. Unknowns and how to verify them`,
          tools: researchTools(),
          ...fileOnlyOutput(analyzerPath),
        },
        {
          name: "codebase-pattern-finder",
          previous: initialResearch,
          reads: [researchIntakePath, liveLocatorPath],
          prompt: `Act as the workflow-native equivalent of the research-codebase pattern-finder branch.

Read:
- Research intake: ${displayPath(researchIntakePath)}
- Live locator: ${displayPath(liveLocatorPath)}

Compact saved-output references: {previous}

Find analogous implementations, recurring conventions, naming patterns, abstractions, tests, and examples relevant to the research question. Distinguish established patterns from one-off details. Document examples with concrete paths and line references. Do not recommend changes and do not implement.

Return Markdown with:
1. Established patterns
2. Representative examples
3. Variations / exceptions
4. Evidence index`,
          tools: researchTools(),
          ...fileOnlyOutput(patternFinderPath),
        },
        {
          name: "research-history-analyzer",
          previous: initialResearch,
          reads: [researchIntakePath, historyLocatorPath],
          prompt: `Act as the workflow-native equivalent of the research-codebase historical analyzer branch.

Read:
- Research intake: ${displayPath(researchIntakePath)}
- Research-history locator: ${displayPath(historyLocatorPath)}

Compact saved-output references: {previous}

Extract decisions, constraints, design rationale, stale assumptions, related research, and unresolved questions from prior project documents. Quote or cite paths from the locator artifact for every important claim. Use live-code findings as the eventual source of truth, and label history as supplementary context.

Return Markdown with:
1. Prior decisions
2. Relevant research artifacts
3. Constraints and rationale
4. Stale or superseded assumptions
5. Open questions`,
          tools: researchTools(),
          ...fileOnlyOutput(historyAnalyzerPath),
        },
        {
          name: "online-researcher",
          previous: initialResearch,
          reads: [researchIntakePath, liveLocatorPath, externalScoutPath],
          prompt: `Act as the workflow-native equivalent of the research-codebase online researcher branch.

Read:
- Research intake: ${displayPath(researchIntakePath)}
- Live locator: ${displayPath(liveLocatorPath)}
- External relevance scout: ${displayPath(externalScoutPath)}

Compact saved-output references: {previous}

Use online research only when external dependencies, APIs, standards, or framework docs materially affect the answer. If research is needed, prefer authoritative sources and include links. Persist reusable fetched source notes under research/web/<YYYY-MM-DD>-<kebab-case-topic>.md when practical, with frontmatter for source_url, fetched_at, and fetch_method. If external research is unnecessary or unavailable, say so and explain the local evidence.

Return Markdown with:
1. Relevant external facts
2. Source links
3. Local implications
4. Version/API assumptions
5. Unverified or unnecessary research`,
          tools: researchTools(["write"]),
          ...fileOnlyOutput(onlineResearchPath),
        },
      ],
      { concurrency: DEFAULT_RESEARCH_CONCURRENCY, failFast: false },
    );

    const researchSynthesis = await ctx.task("codebase-research-synthesis", {
      previous: detailedResearch,
      reads: [
        researchIntakePath,
        liveLocatorPath,
        historyLocatorPath,
        externalScoutPath,
        analyzerPath,
        patternFinderPath,
        historyAnalyzerPath,
        onlineResearchPath,
      ],
      prompt: `Write the final research-codebase-style Markdown document for ${displayPath(researchPath)}.

This workflow has already expanded the ${RESEARCH_SKILL_NAME} process into visible workflow stages. Synthesize the artifacts below; do not launch subagents, do not ask the user questions, and do not implement anything.

Artifacts to read as source material:
- Research intake: ${displayPath(researchIntakePath)}
- Live codebase locator: ${displayPath(liveLocatorPath)}
- Research-history locator: ${displayPath(historyLocatorPath)}
- External relevance scout: ${displayPath(externalScoutPath)}
- Codebase analyzer: ${displayPath(analyzerPath)}
- Pattern finder: ${displayPath(patternFinderPath)}
- Research-history analyzer: ${displayPath(historyAnalyzerPath)}
- Online research: ${displayPath(onlineResearchPath)}

Compact saved-output references: {previous}

Required frontmatter exactly follows this shape; preserve these concrete metadata values unless you have stronger directly verified metadata:
${researchFrontmatter(initialPrompt)}

Required document body:
# Research

## Research Question
[Original user query plus optimized question]

## Summary
[High-level documentation of what exists, prioritizing live codebase findings]

## Detailed Findings
[Component/area sections with path and line references]

## Code References
[Bulleted file:line references and descriptions]

## Architecture Documentation
[Current patterns, conventions, and implementation shape]

## Historical Context (from research/)
[Supplementary prior research/spec/doc context]

## Related Research
[Links to related research documents]

## Open Questions
[Missing, ambiguous, misframed, or unverified areas]

Rules:
- Document what IS, not what SHOULD BE.
- No recommendations, no implementation plan, no critique language.
- Prioritize live codebase evidence over historical docs.
- Include online source links only when the online research artifact found material sources.
- If the original question was misframed, flag that in Summary and Open Questions rather than hiding it.
- Output only the final Markdown content for ${displayPath(researchPath)}; no code fences and no commentary outside the artifact.`,
      tools: researchTools(),
    });
    const researchContent = stripMarkdownFence(researchSynthesis.text);
    await writeArtifact(researchPath, researchContent);
    researchArtifactPathsByName.set("final-research", researchPath);
    const researchManifestPath = join(researchArtifactDir, "manifest.json");
    await writeWorkflowManifest(researchManifestPath, {
      runId: researchRunId,
      startedAt: researchStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      input: { mode: resolvedMode, prompt: initialPrompt, implementationIntent: implementationIntent.name },
      finalReportPath: displayPath(researchPath),
      artifacts: manifestArtifactPaths(researchArtifactPathsByName, researchManifestPath),
    });

    const specPath = artifactPath("specs", initialPrompt, "spec-driven-development-spec");
    const specDraft = await ctx.task("create-spec", {
      previous: renderTaskContexts([
        implementationIntent,
        { name: "research-artifact", text: `Research artifact path: ${researchPath}\n\n${researchContent}` },
      ]),
      prompt: `Use the built-in Atomic ${CREATE_SPEC_SKILL_NAME} skill's document structure and output contract as a template, but do not load the skill dynamically, do not spawn helper agents, do not write files yourself, and do not ask the user questions during this stage; put unresolved decisions in Open Questions for the HIL review gate.

Input and research:
{previous}

Hard constraints:
- Do not implement anything.
- Do not launch subagents; use the supplied research artifact as the evidence base.
- Consume and cite the research artifact path: ${researchPath}.
- Write a technical spec intended for ${specPath}.
- Include goals, non-goals, proposed solution, detailed design, alternatives, risks, rollout/testing, and open questions.
- Cite research paths and code references.
- Include a metadata/status section with Status initially Draft or In Review.
- Do not include concrete dates/timelines for implementation duration.

Output only the final Markdown spec content for ${specPath}; no code fences and no commentary outside the spec.`,
      tools: stageTools(),
    });

    let specContent = stripMarkdownFence(specDraft.text);
    await writeArtifact(specPath, specContent);

    let reviewIterations = 0;
    while (reviewIterations < MAX_SPEC_REVIEW_ITERATIONS) {
      reviewIterations += 1;
      const reviewReply = await ctx.ui.input(specReviewPrompt(specPath, reviewIterations));
      const reviewDecision = parseSpecReviewDecision(reviewReply);

      if (reviewDecision.action === "approve") {
        specContent = markApproved(specContent);
        await writeArtifact(specPath, specContent);
        break;
      }

      if (reviewDecision.action === "reject") {
        return {
          status: "rejected",
          mode: resolvedMode,
          brainstorm_brief_path: brainstormBriefPath,
          research_path: researchPath,
          research_artifact_dir: displayPath(researchArtifactDir),
          research_manifest_path: displayPath(researchManifestPath),
          spec_path: specPath,
          message: "Spec rejected by human reviewer; Ralph was not called.",
        };
      }

      if (reviewDecision.feedback.length === 0) {
        continue;
      }

      const revised = await ctx.task(`spec-revision-${reviewIterations}`, {
        previous: renderTaskContexts([
          { name: "current-spec", text: specContent },
          { name: "review-feedback", text: reviewDecision.feedback },
          { name: "research-artifact", text: `Research path: ${researchPath}` },
        ]),
        prompt: `Revise the spec using the human review feedback.

Context:
{previous}

Constraints:
- Do not implement anything.
- Do not launch subagents; revise from the current spec, research path, and human feedback.
- Preserve the spec's structure and evidence citations.
- Resolve feedback directly where possible.
- Keep unresolved decisions in Open Questions.
- Keep Status as Draft/In Review until explicit approval.
- Keep writing to the same spec path so the review link remains stable: ${specPath}.

Output only the complete revised Markdown spec for ${specPath}; no code fences and no extra commentary.`,
        tools: stageTools(),
      });
      specContent = stripMarkdownFence(revised.text);
      await writeArtifact(specPath, specContent);
    }

    if (!hasApprovedStatus(specContent)) {
      return {
        status: "stopped",
        mode: resolvedMode,
        brainstorm_brief_path: brainstormBriefPath,
        research_path: researchPath,
        research_artifact_dir: displayPath(researchArtifactDir),
        research_manifest_path: displayPath(researchManifestPath),
        spec_path: specPath,
        message: `Spec was not approved within ${MAX_SPEC_REVIEW_ITERATIONS} review iterations; Ralph was not called.`,
      };
    }

    const ralphPrompt = `Implement ${specPath}`;
    const ralphInputs = { prompt: ralphPrompt, max_loops: maxLoops };
    const ralphCommand = `/workflow ralph prompt=${JSON.stringify(ralphPrompt)} max_loops=${maxLoops}`;
    const ralphReadyText = [
      "Spec approved and ready for Ralph.",
      `Approved spec path: ${specPath}`,
      `Ralph prompt: ${ralphPrompt}`,
      `Ralph command: ${ralphCommand}`,
      "Parent chat/agent should launch Ralph as a separate top-level workflow so Ralph has normal workflow status, graph, attach, pause, interrupt, and resume visibility.",
    ].join("\n");

    await ctx.stage("ralph-handoff-notice").complete(RALPH_HANDOFF_NOTICE);
    await ctx.stage("ralph-ready").complete(ralphReadyText);

    return {
      status: "approved-ready-for-ralph",
      mode: resolvedMode,
      brainstorm_brief_path: brainstormBriefPath,
      research_path: researchPath,
      research_artifact_dir: displayPath(researchArtifactDir),
      research_manifest_path: displayPath(researchManifestPath),
      spec_path: specPath,
      approved_spec_path: specPath,
      ralph_workflow: "ralph",
      ralph_prompt: ralphPrompt,
      ralph_inputs: ralphInputs,
      ralph_command: ralphCommand,
      max_loops: maxLoops,
      message: "Spec approved. Launch Ralph as a separate top-level workflow using ralph_workflow and ralph_inputs for full Ralph visibility/control. If a parent chat/agent auto-starts Ralph, check /workflow status for the new Ralph run, connect with /workflow connect <ralph-run-id> or F2, and read Ralph's active stage output for any tmux attach command.",
    };
  },
});
