import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkflowArtifactRun {
  runId: string;
  artifactDir: string;
}

export interface WorkflowArtifactManifest {
  runId: string;
  startedAt: string;
  completedAt?: string;
  input: Record<string, unknown>;
  finalStatus?: string;
  pr?: Record<string, unknown>;
  commitsPushed?: readonly string[];
  finalReportPath: string;
  artifacts: Record<string, string>;
}

export function displayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function sanitizeRunId(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

export function timestampRunId(now = new Date()): string {
  return sanitizeRunId(now.toISOString().replace(/[:.]/g, "-"));
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && (error as { readonly code?: string }).code === "EEXIST";
}

export async function createWorkflowArtifactRun(
  workflowName: string,
  startedAt: Date,
  cwd = process.cwd(),
): Promise<WorkflowArtifactRun> {
  const baseRunId = timestampRunId(startedAt);

  for (let suffix = 0; ; suffix += 1) {
    const runId = suffix === 0 ? baseRunId : `${baseRunId}-${suffix + 1}`;
    const artifactDir = join(cwd, `.${workflowName}-${runId}`);

    try {
      await mkdir(artifactDir, { recursive: false });
      return { runId, artifactDir };
    } catch (error) {
      if (isFileExistsError(error)) continue;
      throw error;
    }
  }
}

export function manifestArtifactPaths(
  artifactPathsByName: ReadonlyMap<string, string>,
  manifestPath?: string,
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const [name, path] of artifactPathsByName) artifacts[name] = displayPath(path);
  if (manifestPath !== undefined) artifacts.manifest = displayPath(manifestPath);
  return artifacts;
}

export async function writeWorkflowManifest(path: string, manifest: WorkflowArtifactManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function markdownArtifact(artifactDir: string, filename: string): string {
  return join(artifactDir, filename);
}

export function jsonArtifact(artifactDir: string, filename: string): string {
  return join(artifactDir, filename);
}

export async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeMarkdownArtifact(path: string, value: string): Promise<void> {
  await writeFile(path, `${value.trimEnd()}\n`, "utf8");
}
