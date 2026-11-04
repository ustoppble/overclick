import { mcpToken, project, task, user, type Database } from "@agent-board/db";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { looksLikeUuid } from "../mcp/map";
import { projectScope, taskScope, type MaybePrincipal } from "./scope";

/**
 * The board's person filter: "show me only the work linked to this person".
 *
 * A card is linked to a person when
 * - they wrote it (`task.created_by_user_id`), or
 * - the claim on it is theirs (`task.claimed_by_token_id` is a token they
 *   own, `mcp_token.owner_user_id`). That one column answers both "who holds
 *   it now" and "who delivered it": task_deliver keeps the claim's token on
 *   the card, and only a release, a reopen or a discard clears it. A card
 *   reopened after its delivery is the next claimer's, as it should be.
 *
 * The filter only ever narrows: it is ANDed with `taskScope`, so it cannot
 * show a member a card outside the projects linked to them. The people it
 * offers are the ones on a card the reader can see, so a name is never
 * revealed through it either; an id the reader cannot see reads as everyone.
 */

/** Everyone: no person filter. */
export const PERSON_ALL = "all";
/** The reader themselves. Stored and carried as the word, so a link means "whoever opens it". */
export const PERSON_ME = "me";

/** What the address or the memory says: all, me, or a user id. */
export type PersonChoice = string;

export type VisiblePerson = { id: string; email: string };

/**
 * The cards linked to one person, as a condition on `task`. The token table is
 * aliased so the subquery never collides with the query it filters.
 */
export function personCondition(userId: string): SQL {
  return or(
    eq(task.createdByUserId, userId),
    sql`${task.claimedByTokenId} in (select person_tok.id from mcp_token person_tok
      where person_tok.owner_user_id = ${userId})`,
  )!;
}

/**
 * The people on a card the reader can see, by email: the ones who wrote one,
 * or whose agent holds or delivered one. Read through the reader's scope, so a
 * member is offered the people of their linked projects and nobody else.
 */
export async function loadVisiblePeople(
  database: Pick<Database, "select" | "selectDistinct">,
  workspaceId: string,
  principal: MaybePrincipal,
): Promise<VisiblePerson[]> {
  if (!principal) return [];
  const visible = and(eq(project.workspaceId, workspaceId), projectScope(principal), taskScope(principal));
  const writers = database
    .selectDistinct({ id: task.createdByUserId })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(and(visible, sql`${task.createdByUserId} is not null`));
  const claimers = database
    .selectDistinct({ id: mcpToken.ownerUserId })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .innerJoin(mcpToken, eq(task.claimedByTokenId, mcpToken.id))
    .where(and(visible, sql`${mcpToken.ownerUserId} is not null`));
  const [a, b] = await Promise.all([writers, claimers]);
  const ids = [...new Set([...a, ...b].flatMap((row) => (row.id ? [row.id] : [])))];
  if (ids.length === 0) return [];
  return database
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(inArray(user.id, ids))
    .orderBy(asc(user.email));
}

/**
 * A choice read back for this reader: the user id to filter by, or null for
 * everyone. `me` is always the reader. Any other id must be one of the people
 * they can see; anything else (an id out of their scope, a deleted user,
 * garbage) is everyone, the way a stale project reads as all projects.
 */
export function resolvePersonChoice(
  choice: string | null | undefined,
  principal: MaybePrincipal,
  people: readonly { id: string }[],
): { choice: PersonChoice; userId: string | null } {
  if (!principal || !choice || choice === PERSON_ALL) return { choice: PERSON_ALL, userId: null };
  if (choice === PERSON_ME || choice === principal.userId) {
    return { choice: PERSON_ME, userId: principal.userId };
  }
  if (looksLikeUuid(choice) && people.some((person) => person.id === choice)) {
    return { choice, userId: choice };
  }
  return { choice: PERSON_ALL, userId: null };
}

/** Whether a choice needs the people list to be read back: only another person's id does. */
function needsPeople(choice: string | null | undefined): boolean {
  return Boolean(choice) && choice !== PERSON_ALL && choice !== PERSON_ME;
}

/**
 * The person on the reader's board: the address's when it says one, the
 * remembered one when it does not (the scope's rule, E4 F2).
 */
export async function readBoardPerson(
  database: Pick<Database, "select" | "selectDistinct">,
  workspaceId: string,
  principal: MaybePrincipal,
  override?: { person?: string },
  known?: { people?: readonly VisiblePerson[]; remembered?: string | null },
): Promise<{ choice: PersonChoice; userId: string | null }> {
  if (!principal) return { choice: PERSON_ALL, userId: null };
  let choice = override?.person;
  if (choice === undefined) {
    if (known && known.remembered !== undefined) {
      choice = known.remembered ?? undefined;
    } else {
      const [me] = await database
        .select({ person: user.boardPerson })
        .from(user)
        .where(eq(user.id, principal.userId))
        .limit(1);
      choice = me?.person ?? undefined;
    }
  }
  // Not a word and not an id: everyone, without reading the people for it.
  if (needsPeople(choice) && !looksLikeUuid(choice!)) return { choice: PERSON_ALL, userId: null };
  const people = needsPeople(choice)
    ? (known?.people ?? (await loadVisiblePeople(database, workspaceId, principal)))
    : [];
  return resolvePersonChoice(choice, principal, people);
}

/** A person as the bar writes them: the part of the email before the @. */
export function personShortName(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
