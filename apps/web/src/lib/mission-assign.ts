/**
 * The rule that decides whether a mission move is allowed, kept away from the
 * database so both entry points agree: the mission field of the card detail
 * and the bulk bar the board uses to rescue a whole orphaned instance.
 *
 * A mission groups work inside one workspace, so a card only ever joins a
 * mission of its own workspace. Detaching (`null`) is always allowed, because
 * a card without a mission is the state every card was born in.
 */

export type MissionAssignCard = { id: string; workspaceId: string };

/** `null` detaches; "missing" is an id that resolved to no mission at all. */
export type MissionAssignTarget =
  | { id: string; workspaceId: string }
  | null
  | "missing";

export type MissionAssignPlan =
  | { ok: true; taskIds: string[]; missionId: string | null }
  | { ok: false; error: string };

export function planMissionAssignment(input: {
  requestedIds: string[];
  /** The cards the board could load, each with the workspace it belongs to. */
  cards: MissionAssignCard[];
  mission: MissionAssignTarget;
}): MissionAssignPlan {
  const requested = [...new Set(input.requestedIds.filter((id) => id.trim()))];
  if (requested.length === 0) {
    return { ok: false, error: "Select at least one card." };
  }
  if (input.mission === "missing") {
    return { ok: false, error: "Mission not found." };
  }

  const byId = new Map(input.cards.map((card) => [card.id, card]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        unknown.length === 1
          ? "Card not found."
          : `${unknown.length} of the selected cards no longer exist.`,
    };
  }

  const mission = input.mission;
  if (mission) {
    const foreign = requested.filter(
      (id) => byId.get(id)!.workspaceId !== mission.workspaceId,
    );
    if (foreign.length > 0) {
      return {
        ok: false,
        error: "That mission belongs to another workspace.",
      };
    }
  }

  return { ok: true, taskIds: requested, missionId: mission?.id ?? null };
}

/** One card and the mission it goes back to; `null` is "Sem missão". */
export type MissionRestoreMove = { taskId: string; missionId: string | null };

export type MissionRestorePlan =
  | { ok: true; groups: { missionId: string | null; taskIds: string[] }[] }
  | { ok: false; error: string };

/**
 * The bulk move's undo (navigation plan E6): every card goes back to its own
 * previous mission, so the plan is one move per mission it found. The same
 * rule as the move holds for each of them: the card is one the caller reaches,
 * the mission too, and both live in one workspace. One card out of reach
 * refuses the whole undo, with the answer an unknown id gets.
 */
export function planMissionRestore(input: {
  moves: MissionRestoreMove[];
  /** The cards the caller may touch, each with the workspace it belongs to. */
  cards: MissionAssignCard[];
  /** The missions the caller may touch, by id. */
  missions: Map<string, { workspaceId: string }>;
}): MissionRestorePlan {
  const moves = input.moves.filter((move) => move.taskId.trim());
  if (moves.length === 0) {
    return { ok: false, error: "Select at least one card." };
  }

  const byId = new Map(input.cards.map((card) => [card.id, card]));
  const groups = new Map<string | null, string[]>();
  const seen = new Map<string, string | null>();
  for (const move of moves) {
    if (seen.has(move.taskId)) {
      if (seen.get(move.taskId) === move.missionId) continue;
      return { ok: false, error: "A card cannot go back to two missions." };
    }
    seen.set(move.taskId, move.missionId);

    const found = byId.get(move.taskId);
    if (!found) return { ok: false, error: "Card not found." };
    if (move.missionId !== null) {
      const target = input.missions.get(move.missionId);
      if (!target) return { ok: false, error: "Mission not found." };
      if (target.workspaceId !== found.workspaceId) {
        return { ok: false, error: "That mission belongs to another workspace." };
      }
    }
    groups.set(move.missionId, [...(groups.get(move.missionId) ?? []), move.taskId]);
  }

  return {
    ok: true,
    groups: [...groups].map(([missionId, taskIds]) => ({ missionId, taskIds })),
  };
}
