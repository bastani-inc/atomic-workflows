import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("package workflow runtime metadata", () => {
  test("requires the Atomic runtime that provides workflow groups and typebox", () => {
    const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

    expect(packageJson.peerDependencies).toMatchObject({
      "@bastani/atomic": ">=0.9.10",
      typebox: "*",
    });
    expect(packageJson.peerDependencies).not.toHaveProperty("@bastani/workflows");
  });

  test("opts pure workflow sources into the public SDK and Bun types", () => {
    const tsconfig = JSON.parse(readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8"));

    expect(tsconfig.compilerOptions).toMatchObject({
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["bun", "@bastani/atomic/workflows/ambient"],
    });
    expect(tsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(tsconfig.include).toEqual([
      "workflows/deep-research-codebase/**/*.ts",
      "workflows/goal/**/*.ts",
      "workflows/open-claude-design/**/*.ts",
      "workflows/ralph/**/*.ts",
    ]);
  });

  test("packs synced-workflow provenance and its type-check config", () => {
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: import.meta.dir,
      encoding: "utf8",
    });

    expect(packed.status, packed.stderr).toBe(0);
    const files = new Set(
      JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path),
    );
    expect(files).toContain("tsconfig.json");
    expect(files).toContain("workflows/upstream-builtins-manifest.json");
  });
});
