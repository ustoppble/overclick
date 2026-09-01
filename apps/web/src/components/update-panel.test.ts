import { describe, expect, it } from "vitest";
import { dict } from "../lib/i18n";
import { updateCommand } from "../lib/update-commands";
import { sidecarCanUpdate } from "../lib/updates";

/**
 * The panel itself pulls server actions (and the db package) into the
 * module graph, so these lock the contract the panel is wired to: hosted
 * never offers a click, and the command it shows is the one compose
 * already documents.
 */
describe("the update panel per deploy mode (OCL-157)", () => {
  it("hosted: does not offer the click, and the command it shows is ./deploy/deploy.sh", () => {
    expect(sidecarCanUpdate("hosted")).toBe(false);
    expect(updateCommand("hosted")).toBe("./deploy/deploy.sh");
    expect(dict("en").updates.hostedPullIsNoop).toContain("built from source");
    expect(dict("pt-BR").updates.hostedPullIsNoop).toContain("construído do fonte");
  });

  it("quickstart: keeps the button, because that compose file has an image to pull", () => {
    expect(sidecarCanUpdate("quickstart")).toBe(true);
    expect(updateCommand("quickstart")).toContain("docker compose");
    expect(dict("en").updates.updateBtn).toBe("Update");
    expect(dict("pt-BR").updates.updateBtn).toBe("Atualizar");
  });
});
