import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

type Rewrite = { upstream: string; registry: string };
type FileRecord = {
  workflow: string;
  upstream_path: string;
  local_path: string;
  upstream_sha256: string;
  rewrites: Rewrite[];
};
type Manifest = {
  upstream: { repository: string; ref: string; commit: string };
  adaptation_policy: string;
  files: FileRecord[];
};

const root = dirname(import.meta.dir);
const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "upstream-builtins-manifest.json"), "utf8"),
) as Manifest;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const EXPECTED_COMMIT = "020310225e0901e6a5e1515968500b73542f52a8";
const EXPECTED_WORKFLOWS = [
  "deep-research-codebase",
  "goal",
  "open-claude-design",
  "ralph",
] as const;
const EXPECTED_ADAPTATION_POLICY =
  "Only private Atomic SDK/type imports are rewritten to @bastani/workflows; all workflow logic remains byte-equivalent.";
const APPROVED_REWRITES = new Set([
  JSON.stringify({
    upstream: "import { workflow } from \"../src/authoring/workflow.js\";",
    registry: "import { workflow } from \"@bastani/workflows\";",
  }),
  JSON.stringify({
    upstream: "\"../src/shared/types.js\"",
    registry: "\"@bastani/workflows\"",
  }),
]);

describe("upstream Atomic builtin workflow parity", () => {
  test("pins the exact upstream source and adaptation policy", () => {
    expect(manifest.upstream).toEqual({
      repository: "https://github.com/bastani-inc/atomic.git",
      ref: "main",
      commit: EXPECTED_COMMIT,
    });
    expect(manifest.adaptation_policy).toBe(EXPECTED_ADAPTATION_POLICY);
  });

  test("records the complete, unique runtime source set", () => {
    expect(manifest.files).toHaveLength(32);
    expect([...new Set(manifest.files.map((record) => record.workflow))].sort())
      .toEqual([...EXPECTED_WORKFLOWS].sort());

    const localPaths = manifest.files.map((record) => record.local_path);
    const workflowSources = manifest.files.map(
      (record) => `${record.workflow}:${record.upstream_path}`,
    );
    expect(new Set(localPaths).size).toBe(localPaths.length);
    expect(new Set(workflowSources).size).toBe(workflowSources.length);

    for (const record of manifest.files) {
      expect(record.local_path.startsWith(`workflows/${record.workflow}/`)).toBe(true);
      expect(record.upstream_path.startsWith("packages/workflows/builtin/")).toBe(true);
      for (const rewrite of record.rewrites) {
        expect(APPROVED_REWRITES.has(JSON.stringify(rewrite))).toBe(true);
      }
    }
  });

  for (const record of manifest.files) {
    test(record.local_path + " matches " + record.upstream_path, () => {
      let local = readFileSync(join(root, record.local_path), "utf8");
      for (const rewrite of [...record.rewrites].reverse()) {
        const occurrences = local.split(rewrite.registry).length - 1;
        expect(occurrences).toBe(1);
        local = local.replace(rewrite.registry, rewrite.upstream);
      }
      expect(sha256(local)).toBe(record.upstream_sha256);
    });
  }

  for (const workflowName of EXPECTED_WORKFLOWS) {
    test(workflowName + " has no stale runtime TypeScript files", () => {
      const expected = manifest.files
        .filter((record) => record.workflow === workflowName)
        .map((record) => record.local_path.split("/").at(-1)!)
        .sort();
      const actual = readdirSync(join(root, "workflows", workflowName))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .sort();
      expect(actual).toEqual(expected);
    });
  }
});
