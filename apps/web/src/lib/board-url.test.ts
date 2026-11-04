import { describe, expect, it } from "vitest";
import type { BoardFilter } from "./board-filter";
import { boardAddressQuery } from "./board-url";

const filter: BoardFilter = {
  organizationIds: ["o1"],
  projectIds: ["p1"],
  missionId: null,
  types: ["feature", "rfc"],
  priorities: [],
  period: "30d",
  periodBy: "updated",
};

describe("the board's address carries its filter and its search (E4)", () => {
  it("writes the scope, the period and what narrows, explicitly", () => {
    const query = new URLSearchParams(boardAddressQuery(filter, "login", ""));
    expect(query.get("organizations")).toBe("o1");
    expect(query.get("projects")).toBe("p1");
    expect(query.get("types")).toBe("feature,rfc");
    expect(query.get("period")).toBe("30d");
    expect(query.get("periodBy")).toBe("updated");
    expect(query.get("q")).toBe("login");
  });

  it("replaces what it owns, keeps what it does not, and drops a search that was cleared", () => {
    const query = new URLSearchParams(
      boardAddressQuery({ ...filter, types: [] }, "  ", "types=bug&q=old&card=OCL-12"),
    );
    expect(query.get("types")).toBeNull();
    expect(query.get("q")).toBeNull();
    expect(query.get("card")).toBe("OCL-12");
  });
});
