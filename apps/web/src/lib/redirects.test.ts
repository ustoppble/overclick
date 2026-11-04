import { describe, expect, it } from "vitest";
import {
  ORGANIZATIONS_DESTINATION,
  insightsDestination,
} from "./redirects";

describe("the old Insights and Organizations links (E5)", () => {
  it("/insights becomes /usage, with the filter the link carried", () => {
    expect(insightsDestination({})).toBe("/usage");
    expect(
      insightsDestination({ projects: "OCL", period: "7d", periodBy: "created" }),
    ).toBe("/usage?projects=OCL&period=7d&periodBy=created");
  });

  it("keeps every value of a repeated parameter and drops empty ones", () => {
    expect(insightsDestination({ types: ["bug", "rfc"], mission: undefined })).toBe(
      "/usage?types=bug&types=rfc",
    );
  });

  it("/organizations lands on Organizations and projects", () => {
    expect(ORGANIZATIONS_DESTINATION).toBe("/settings/organizations-projects");
  });
});
