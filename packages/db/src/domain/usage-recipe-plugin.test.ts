import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginMeasureCommand, pluginMeasureScript } from "./usage-recipe";

const PLUGIN_FILE = resolve(__dirname, "../../../../plugin/bin/measure.cjs");

describe("plugin measure script", () => {
  it("is the committed copy of the shipped recipes", () => {
    const generated = pluginMeasureScript();
    if (process.env.WRITE_PLUGIN_MEASURE === "1") {
      writeFileSync(PLUGIN_FILE, generated);
    }
    // Edited a recipe? Regenerate with WRITE_PLUGIN_MEASURE=1 and commit it:
    // the claim cites this file, so a stale copy measures the old way.
    expect(readFileSync(PLUGIN_FILE, "utf8")).toBe(generated);
  });

  it("cites the local file by one shell-neutral line, without any board address", () => {
    const line = pluginMeasureCommand("claude-code", {
      claimed_at: "2026-09-19T01:03:10.235Z",
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("'measure.cjs'");
    expect(line).toContain("cli=claude-code claimed_at=2026-09-19T01:03:10.235Z");
    expect(line).not.toMatch(/https?:/);
    // The characters bash, zsh and PowerShell disagree about inside "...".
    const script = line.slice('node -e "'.length, line.lastIndexOf('"'));
    expect(script).not.toMatch(/["$`\\]/);
  });
});
