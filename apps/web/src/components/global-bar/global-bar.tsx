import { organization, project } from "@agent-board/db";
import { and, asc, eq } from "drizzle-orm";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { loadVisiblePeople, readBoardPerson } from "../../lib/person-filter";
import { countCardsByStatus, readReviewScope } from "../../lib/review-queue";
import { organizationScope, projectScope } from "../../lib/scope";
import { sessionPrincipal } from "../../lib/web-scope";
import { GlobalBarClient, type GlobalPlace } from "./global-bar-client";
import "../../styles/global-bar.css";

/**
 * The global bar, read on the server (navigation plan E1): who is signed in,
 * as what, the two numbers for their remembered scope, and since E4 the
 * organizations and projects the scope picker offers. Mounted by each
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
  // The scope picker's choices (E4), read once: the remembered scope and the
  // counts resolve against the same list.
  const [projects, organizations] = await Promise.all([
    db()
      .select({ id: project.id, name: project.name, organizationId: project.organizationId })
      .from(project)
      .where(and(eq(project.workspaceId, ws.id), projectScope(principal)))
      .orderBy(asc(project.createdAt)),
    db()
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(and(eq(organization.workspaceId, ws.id), organizationScope(principal)))
      .orderBy(asc(organization.name)),
  ]);
  // The person picker's choices: the people on a card this reader can see,
  // read once for the list and for reading the remembered pick back.
  const people = await loadVisiblePeople(db(), ws.id, principal);
  const [remembered, rememberedPerson] = await Promise.all([
    readReviewScope(db(), ws.id, principal, { projects, people }),
    readBoardPerson(db(), ws.id, principal, undefined, { people }),
  ]);
  const [counts, org] = await Promise.all([
    countCardsByStatus(db(), principal, remembered, ["em_execucao", "feito"]).then((byStatus) => ({
      running: byStatus.em_execucao,
      review: byStatus.feito,
    })),
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
      scope={{
        organizations,
        projects,
        remembered: {
          organizationIds: remembered.organizationIds,
          projectIds: remembered.projectIds,
        },
      }}
      person={{ people, viewerId: principal.userId, remembered: rememberedPerson.choice }}
    />
  );
}
