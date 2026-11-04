import { describe, expect, it } from "vitest";
import { USAGE_TABS, usageTab, usageTabHref, usageTables } from "./tabs";

describe("the Consumo tabs (E5)", () => {
  it("are the seven the design draws", () => {
    expect(USAGE_TABS).toEqual([
      "overview",
      "project",
      "mission",
      "agent",
      "model",
      "release",
      "card",
    ]);
  });

  it("read ?by=, and an unknown or missing one is the overview", () => {
    expect(usageTab("model")).toBe("model");
    expect(usageTab(["card", "model"])).toBe("card");
    expect(usageTab("nope")).toBe("overview");
    expect(usageTab(undefined)).toBe("overview");
  });

  it("?by=model shows only the model table", () => {
    expect(usageTables("model")).toEqual(["model"]);
    expect(usageTables("project")).toEqual(["project"]);
    expect(usageTables("card")).toEqual(["card"]);
  });

  it("the overview shows the totals and charts, and no table", () => {
    expect(usageTables("overview")).toEqual(["totals", "charts"]);
  });

  it("every tab link keeps the scope and the period the page came with", () => {
    const params = {
      projects: "OCL",
      mission: "m-1",
      period: "30d",
      periodBy: "created",
      by: "project",
    };
    expect(usageTabHref("model", params)).toBe(
      "/usage?projects=OCL&mission=m-1&period=30d&periodBy=created&by=model",
    );
  });

  it("the overview link carries no ?by=", () => {
    expect(usageTabHref("overview", { projects: "OCL", by: "model" })).toBe(
      "/usage?projects=OCL",
    );
    expect(usageTabHref("overview", {})).toBe("/usage");
  });
});
