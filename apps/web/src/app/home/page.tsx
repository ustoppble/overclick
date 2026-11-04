import { and, eq } from "drizzle-orm";
import { permanentRedirect } from "next/navigation";
import { project } from "@agent-board/db";
import { resolveCardRoute } from "../../lib/card-route";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { homeCardAsked, homeDestination, withQuery } from "../../lib/redirects";
import { projectScope } from "../../lib/scope";
import { sessionPrincipal } from "../../lib/web-scope";

export const dynamic = "force-dynamic";

/**
 * The board moved to /board (navigation plan E3). Links to /home are in
 * bookmarks, histories and messages: each goes where it meant, in one hop.
 * Permanent (308) since E4, the release after the one that introduced it.
 *
 * A link to a card whose id has since changed (it moved project) goes straight
 * to the card's current address, not to the old one and then on (E3 review):
 * the card is looked up here, through the reader's scope, before the redirect.
 */
export default async function OldHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const card = homeCardAsked(query);
  if (card) {
    const moved = await currentCardAddress(card);
    if (moved) permanentRedirect(withQuery(moved, query, ["card"]));
  }
  permanentRedirect(homeDestination(query));
}

/** The card's address now, when the id asked for is an old one; null otherwise. */
async function currentCardAddress(asked: string): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  const principal = await sessionPrincipal(session);
  if (!principal) return null;
  const ws = await db().query.workspace.findFirst({ columns: { id: true } });
  if (!ws) return null;
  const visible = await db()
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, ws.id), projectScope(principal)));
  const route = await resolveCardRoute(
    db(),
    visible.map((item) => item.id),
    principal,
    asked,
  );
  return route.kind === "moved" ? route.to : null;
}
