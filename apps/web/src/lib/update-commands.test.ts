import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateCommand } from "./update-commands";

describe("the manual update command per deploy mode", () => {
  it("never offers the quickstart's raw compose command on a hosted instance", () => {
    // This is the exact command the OCL-43 incident traced back to: run
    // against the hosted project it collides with the pinned compose files
    // and the deploy lock. A hosted instance must only ever be told to run
    // the script that holds both.
    expect(updateCommand("hosted")).toBe("./deploy/deploy.sh");
    expect(updateCommand("hosted")).not.toContain("docker compose up");
  });

  it("keeps the checkout command for the quickstart install", () => {
    expect(updateCommand("quickstart")).toBe("git pull && docker compose up -d --build --remove-orphans");
  });
});

describe("the retired updater sidecar", () => {
  it("also drops the old sidecar container when the quickstart is updated", () => {
    expect(updateCommand("quickstart")).toContain("--remove-orphans");
  });

  it("leaves no command that turns it on, in any mode", () => {
    for (const mode of ["hosted", "quickstart"] as const) {
      expect(updateCommand(mode)).not.toContain("--profile");
    }
  });
});

describe("nothing in the app talks to an update sidecar", () => {
  const src = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")
          ? [join(dir, entry.name)]
          : [],
    );

  it("has no trigger directory, heartbeat or trigger action left", () => {
    const needles = [
      "UPDATE_TRIGGER_DIR",
      "updater-alive",
      "update-requested",
      "triggerUpdateAction",
      "readUpdaterStateAction",
      "readUpdaterState",
      "updaterEnableCommand",
    ];
    const hits = files(src).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return needles.filter((needle) => text.includes(needle)).map((n) => `${file}: ${n}`);
    });
    expect(hits).toEqual([]);
  });
});
