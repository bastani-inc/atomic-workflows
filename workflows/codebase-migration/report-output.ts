import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface SavedMigrationReport {
  reportPath: string;
  filenameSummary: string;
}

export interface WriteMigrationReportOptions {
  outputPath?: string;
  summary: string;
  report: string;
  cwd?: string;
}

export function reportSummaryText(value: unknown, fallback: string): string {
  const summary = String(value ?? "")
    .replace(/[`*_#[\]()>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (summary.length === 0) {
    return fallback;
  }

  return summary.split(/\s+/).slice(0, 12).join(" ");
}

export function reportFilenameSummary(value: unknown, fallback: string): string {
  const normalized = reportSummaryText(value, fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = normalized.split("-").filter(Boolean).slice(0, 6).join("-");
  const fallbackSlug = String(fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : fallbackSlug || "migration";
}

export function resolveMigrationReportPath(
  options: Omit<WriteMigrationReportOptions, "report">,
): SavedMigrationReport {
  const cwd = options.cwd ?? process.cwd();
  const explicitOutputPath = String(options.outputPath ?? "").trim();
  const filenameSummary = reportFilenameSummary(options.summary, "migration");

  if (explicitOutputPath.length > 0) {
    return {
      reportPath: isAbsolute(explicitOutputPath) ? explicitOutputPath : resolve(cwd, explicitOutputPath),
      filenameSummary,
    };
  }

  const date = new Date().toISOString().slice(0, 10);

  return {
    reportPath: join(cwd, "migrations", `${date}-${filenameSummary}.md`),
    filenameSummary,
  };
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function collisionReportPathCandidate(reportPath: string, suffix: number): string {
  const extension = extname(reportPath);
  if (extension.length === 0) {
    return `${reportPath}-${suffix}`;
  }

  return `${reportPath.slice(0, -extension.length)}-${suffix}${extension}`;
}

async function writeNewReportFile(reportPath: string, content: string): Promise<boolean> {
  try {
    await writeFile(reportPath, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isFileExistsError(error)) {
      return false;
    }

    throw error;
  }
}

export async function writeMigrationReport(options: WriteMigrationReportOptions): Promise<SavedMigrationReport> {
  const savedReport = resolveMigrationReportPath(options);
  const content = `${options.report.trimEnd()}\n`;
  const explicitOutputPath = String(options.outputPath ?? "").trim();

  await mkdir(dirname(savedReport.reportPath), { recursive: true });

  if (explicitOutputPath.length > 0) {
    await writeFile(savedReport.reportPath, content, "utf8");
    return savedReport;
  }

  if (await writeNewReportFile(savedReport.reportPath, content)) {
    return savedReport;
  }

  for (let suffix = 2; ; suffix += 1) {
    const reportPath = collisionReportPathCandidate(savedReport.reportPath, suffix);

    if (await writeNewReportFile(reportPath, content)) {
      return { ...savedReport, reportPath };
    }
  }
}
