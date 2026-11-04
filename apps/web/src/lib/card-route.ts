import type { Database } from "@agent-board/db";
import { findBoardTaskByShortId, type BoardTaskRow } from "./board-tasks";
import { cardPath } from "./card-path";
import type { MaybePrincipal } from "./scope";

export { cardIdFromPath, cardPath } from "./card-path";

export type CardRoute =
  | { kind: "open"; row: BoardTaskRow }
  | { kind: "moved"; to: string }
  | { kind: "not-found" };

/**
 * What `/cards/<id>` shows. The card that owns the id opens, whatever the
 * board's period; an id the card had before it moved project, or the id typed
 * in another case, hops once to the address it has now. A card the reader may
 * not see answers exactly like one that does not exist.
 */
export async function resolveCardRoute(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  asked: string,
): Promise<CardRoute> {
  const wanted = asked.trim();
  if (!wanted) return { kind: "not-found" };
  const row = await findBoardTaskByShortId(database, projectIds, principal, wanted);
  if (!row) return { kind: "not-found" };
  if (row.shortId !== wanted) return { kind: "moved", to: cardPath(row.shortId) };
  return { kind: "open", row };
}
