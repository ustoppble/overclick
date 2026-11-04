import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { organization, project, user } from "@agent-board/db";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { formatElapsed, formatMoney, formatTokens } from "../../lib/format";
import { dict, isLang } from "../../lib/i18n";
import { loadMissionList, loadMissionUsage } from "../../lib/mission-page";
import { loadModelPrices } from "../../lib/prices";
import { boardFilterFromQuery } from "../../lib/board-filter";
import { organizationScope, projectScope } from "../../lib/scope";
import { pagePrincipal } from "../../lib/web-scope";
import { MissionProgressBar } from "../board/mission-progress-bar";
import { MissionStatus } from "./mission-status";
import { NewMission } from "./new-mission";

export const dynamic = "force-dynamic";

/** The objective's first line, as plain words for the list. */
function firstLine(markdown: string): string {
  const line = markdown.split("\n").find((item) => item.trim()) ?? "";
  return line.replace(/[#*_`>[\]]/g, "").replace(/\(([^)]*)\)/g, "").trim();
}

/**
 * The missions (navigation plan E3): in progress (active and paused) or
 * completed, the most recently changed first. "A mission groups cards from one
 * or more projects", said once here (F12). A member sees the missions they
 * created.
 */
export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const principal = await pagePrincipal(session);
  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  const t = dict(ws.language);
  const lang = isLang(ws.language) ? ws.language : "en";
  const admin = principal.role === "admin";

  const params = await searchParams;
  const showDone = params.status === "done";
  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  // The scope of the global bar (E4): the URL's, or the remembered one.
  const [projectRows, organizationRows, [me]] = await Promise.all([
    db()
      .select({ id: project.id, organizationId: project.organizationId })
      .from(project)
      .where(and(eq(project.workspaceId, ws.id), projectScope(principal)))
      .orderBy(asc(project.createdAt)),
    db()
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.workspaceId, ws.id), organizationScope(principal)))
      .orderBy(asc(organization.name)),
    db()
      .select({ organizationId: user.boardOrganizationId, projectId: user.boardProjectId })
      .from(user)
      .where(eq(user.id, session.userId))
      .limit(1),
  ]);
  const scope = boardFilterFromQuery(
    { organizations: one(params.organizations), projects: one(params.projects) },
    projectRows,
    [],
    undefined,
    organizationRows,
    { organizationId: me?.organizationId ?? null, projectId: me?.projectId ?? null, period: null, periodBy: null },
  );
  const [missions, usage] = await Promise.all([
    loadMissionList(db(), ws.id, principal, scope),
    loadMissionUsage(db(), ws.id, ws.pricingEnabled, prices, principal),
  ]);
  const active = missions.filter((item) => item.status !== "concluida");
  const done = missions.filter((item) => item.status === "concluida");
  const shown = showDone ? done : active;
  const now = Date.now();

  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />
      <div className="ms-page">
        <div className="ms-head">
          <div className="ms-head-text">
            <h1 className="ms-title">{t.missions.title}</h1>
            <p className="ms-lead">
              {t.missions.lead}
              {admin ? "" : ` ${t.missions.leadMember}`}
            </p>
          </div>
          <NewMission lang={ws.language} />
        </div>

        <nav className="ms-tabs" aria-label={t.missions.tabsLabel}>
          <a href="/missions" aria-current={showDone ? undefined : "page"}>
            {t.missions.tabActive} <span className="ms-num">{active.length}</span>
          </a>
          <a href="/missions?status=done" aria-current={showDone ? "page" : undefined}>
            {t.missions.tabDone} <span className="ms-num">{done.length}</span>
          </a>
        </nav>

        {shown.length === 0 ? (
          <section className="ms-empty">
            <h2>{t.missions.empty}</h2>
            <p>{t.missions.emptyBody}</p>
          </section>
        ) : (
          <div className="ms-list">
            {shown.map((item) => {
              const spent = usage.get(item.id);
              const review = item.counts.feito;
              return (
                <a key={item.id} className="ms-row" href={`/missions/${item.id}`}>
                  <div>
                    <h2>
                      {item.title} <MissionStatus status={item.status} t={t} />
                    </h2>
                    {item.objective.trim() ? (
                      <p className="ms-obj">{firstLine(item.objective)}</p>
                    ) : null}
                    <div className="ms-projs">
                      {item.projectNames.length > 0
                        ? t.missions.projects(item.projectNames.join(", "))
                        : t.missions.noCardsYet}
                      {" · "}
                      {t.missions.updated(formatElapsed(now - item.updatedAt.getTime()))}
                    </div>
                  </div>
                  <MissionProgressBar counts={item.counts} t={t} />
                  <div className="ms-r">
                    {review > 0 ? (
                      <span className="ms-rev">
                        {admin ? t.missions.toReview(review) : t.missions.awaiting(review)}
                      </span>
                    ) : (
                      t.missions.nothingToReview
                    )}
                  </div>
                  <div className="ms-r ms-upd">
                    {spent ? (
                      <>
                        <b>
                          {spent.costUsd !== null
                            ? formatMoney(spent.costUsd, lang)
                            : formatTokens(spent.tokens)}
                        </b>
                        {spent.costUsd !== null
                          ? `${formatTokens(spent.tokens)} ${t.missions.tokens}`
                          : t.missions.tokens}
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}

/** One value of a query parameter; a repeated one reads as its first. */
function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? null;
}
