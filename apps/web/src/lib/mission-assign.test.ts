import { describe, expect, it } from "vitest";
import { planMissionAssignment, planMissionRestore } from "./mission-assign";

const cards = [
  { id: "a", workspaceId: "w1" },
  { id: "b", workspaceId: "w1" },
  { id: "foreign", workspaceId: "w2" },
];
const mission = { id: "m1", workspaceId: "w1" };

describe("mission assignment", () => {
  it("attaches several cards to a mission of the same workspace", () => {
    expect(
      planMissionAssignment({ requestedIds: ["a", "b"], cards, mission }),
    ).toEqual({ ok: true, taskIds: ["a", "b"], missionId: "m1" });
  });

  it("detaches without asking anything of the mission", () => {
    expect(
      planMissionAssignment({ requestedIds: ["a"], cards, mission: null }),
    ).toEqual({ ok: true, taskIds: ["a"], missionId: null });
  });

  it("refuses a mission from another workspace", () => {
    const plan = planMissionAssignment({
      requestedIds: ["foreign"],
      cards,
      mission,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("another workspace");
  });

  it("refuses a mission the board could not resolve", () => {
    const plan = planMissionAssignment({
      requestedIds: ["a"],
      cards,
      mission: "missing",
    });
    expect(plan).toEqual({ ok: false, error: "Mission not found." });
  });

  it("refuses a selection with cards that no longer exist", () => {
    const plan = planMissionAssignment({
      requestedIds: ["a", "gone"],
      cards,
      mission: null,
    });
    expect(plan).toEqual({ ok: false, error: "Card not found." });
  });

  it("refuses an empty selection and dedupes the rest", () => {
    expect(planMissionAssignment({ requestedIds: [], cards, mission })).toEqual({
      ok: false,
      error: "Select at least one card.",
    });
    expect(
      planMissionAssignment({ requestedIds: ["a", "a"], cards, mission }),
    ).toEqual({ ok: true, taskIds: ["a"], missionId: "m1" });
  });
});

/**
 * Navigation plan E6: the bulk move says "N cards movidos · Desfazer", and the
 * undo puts every card back where it was — each to its own previous mission,
 * "Sem missão" included — under the same rule the move follows.
 */
describe("mission restore (the bulk move's undo)", () => {
  const missions = new Map([
    ["m1", { workspaceId: "w1" }],
    ["m2", { workspaceId: "w1" }],
    ["mx", { workspaceId: "w2" }],
  ]);

  it("sends each card back to its own previous mission, Sem missão included", () => {
    expect(
      planMissionRestore({
        moves: [
          { taskId: "a", missionId: "m1" },
          { taskId: "b", missionId: null },
          { taskId: "c", missionId: "m2" },
          { taskId: "d", missionId: "m1" },
        ],
        cards: [...cards, { id: "c", workspaceId: "w1" }, { id: "d", workspaceId: "w1" }],
        missions,
      }),
    ).toEqual({
      ok: true,
      groups: [
        { missionId: "m1", taskIds: ["a", "d"] },
        { missionId: null, taskIds: ["b"] },
        { missionId: "m2", taskIds: ["c"] },
      ],
    });
  });

  it("refuses a card the caller cannot reach, without naming it", () => {
    expect(
      planMissionRestore({
        moves: [
          { taskId: "a", missionId: "m1" },
          { taskId: "not-mine", missionId: null },
        ],
        cards,
        missions,
      }),
    ).toEqual({ ok: false, error: "Card not found." });
  });

  it("refuses a mission the caller cannot reach, or one of another workspace", () => {
    expect(
      planMissionRestore({
        moves: [{ taskId: "a", missionId: "gone" }],
        cards,
        missions,
      }),
    ).toEqual({ ok: false, error: "Mission not found." });
    const foreign = planMissionRestore({
      moves: [{ taskId: "a", missionId: "mx" }],
      cards,
      missions,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error).toContain("another workspace");
  });

  it("refuses an empty undo and a card listed twice with two answers", () => {
    expect(planMissionRestore({ moves: [], cards, missions })).toEqual({
      ok: false,
      error: "Select at least one card.",
    });
    expect(
      planMissionRestore({
        moves: [
          { taskId: "a", missionId: "m1" },
          { taskId: "a", missionId: null },
        ],
        cards,
        missions,
      }).ok,
    ).toBe(false);
  });
});
