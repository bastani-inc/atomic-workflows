import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("package workflow runtime metadata", () => {
  test("requires the Atomic runtime that provides workflow({ ... }) and typebox", () => {
    const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

    expect(packageJson.peerDependencies).toMatchObject({
      "@bastani/atomic": ">=0.9.0",
      typebox: "*",
    });
    expect(packageJson.peerDependencies).not.toHaveProperty("@bastani/workflows");
  });
});
