import { organization } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { loadGlobalCounts } from "../../lib/global-counts";
import { sessionPrincipal } from "../../lib/web-scope";
import { GlobalBarClient, type GlobalPlace } from "./global-bar-client";
import "../../styles/global-bar.css";

/**
 * The global bar, read on the server (navigation plan E1): who is signed in,
 * as what, and the two numbers for their remembered scope. Mounted by each
 * route's layout with the place it is. Nothing when nobody is signed in: the
 * page itself sends that reader to the login.
 */
export async function GlobalBar({ current }: { current: GlobalPlace | null }) {
  const session = await getSession();
  if (!session) return null;
  const principal = await sessionPrincipal(session);
  if (!principal) return null;
  const ws = await db().query.workspace.findFirst({ columns: { id: true, language: true } });
  if (!ws) return null;
  const [counts, org] = await Promise.all([
    loadGlobalCounts(db(), ws.id, principal),
    principal.organizationId
      ? db()
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, principal.organizationId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  return (
    <GlobalBarClient
      current={current}
      lang={ws.language}
      email={session.email}
      role={principal.role}
      organizationName={org?.name ?? null}
      counts={counts}
    />
  );
}
