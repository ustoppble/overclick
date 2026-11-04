import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../next.config";
import {
  CARD_ROUTE_PARAM,
  CARD_ROUTE_REWRITES,
  ORGANIZATIONS_DESTINATION,
  REDIRECT_SOURCES,
  homeDestination,
  insightsDestination,
} from "./redirects";

/** Where a rewrite sends a path, as Next matches it, or null. */
function rewriteOf(pathname: string): string | null {
  for (const rule of CARD_ROUTE_REWRITES) {
    const params = getPathMatch(rule.source)(pathname);
    if (params) {
      return rule.destination.replace(/:(\w+)/g, (_, key: string) => String(params[key]));
    }
  }
  return null;
}

describe("the old board links (navigation plan E3)", () => {
  it("/home becomes /board", () => {
    expect(homeDestination({})).toBe("/board");
  });

  it("/home?card=OCL-12 goes to the card's own address, not to /board?card=", () => {
    expect(homeDestination({ card: "OCL-12" })).toBe("/cards/OCL-12");
    expect(homeDestination({ card: "OCL-12", projects: "OCL" })).toBe("/cards/OCL-12");
  });

  it("/home?projects=X&period=30d keeps the filter it carried", () => {
    expect(homeDestination({ projects: "X", period: "30d" })).toBe(
      "/board?projects=X&period=30d",
    );
  });

  it("keeps the To review list a list, with the card it opens", () => {
    expect(homeDestination({ status: "feito" })).toBe("/board?status=feito");
    expect(homeDestination({ status: "feito", card: "OCL-12" })).toBe(
      "/board?status=feito&card=OCL-12",
    );
  });

  it("keeps every value of a repeated parameter, drops empty ones, and escapes the id", () => {
    expect(homeDestination({ types: ["bug", "rfc"], mission: undefined, q: "" })).toBe(
      "/board?types=bug&types=rfc",
    );
    expect(homeDestination({ card: "a b/c" })).toBe("/cards/a%20b%2Fc");
    expect(homeDestination({ card: ["OCL-1", "OCL-2"] })).toBe("/cards/OCL-1");
  });

  it("never chains: no destination is itself a redirected source", () => {
    const destinations = [
      homeDestination({}),
      homeDestination({ card: "OCL-12" }),
      homeDestination({ status: "feito", card: "OCL-12" }),
      homeDestination({ projects: "X" }),
    ];
    for (const to of destinations) {
      const path = to.split("?")[0]!;
      expect(REDIRECT_SOURCES).not.toContain(path);
      // A card's address is read by the board, never redirected again.
      expect(path === "/board" || rewriteOf(path) !== null).toBe(true);
    }
  });
});

describe("the card's address is read by the board itself (F4)", () => {
  it("/cards/OCL-12 is served by /board, which keeps a single board mounted", () => {
    expect(rewriteOf("/cards/OCL-12")).toBe(`/board?${CARD_ROUTE_PARAM}=OCL-12`);
    expect(rewriteOf("/cards/OCL-12/more")).toBeNull();
    expect(rewriteOf("/cards")).toBeNull();
  });

  it("is what next.config asks Next for", async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toEqual(CARD_ROUTE_REWRITES);
  });
});

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
