import { notFound, redirect } from "next/navigation";
import { NebulaAtmosphere } from "../../../components/nebula-atmosphere";
import { toBoardCards } from "../../../lib/board-card";
import { boardFilterToQuery, type BoardFilter } from "../../../lib/board-filter";
import { loadBoardTotals } from "../../../lib/board-totals-query";
import { getSession } from "../../../lib/cookies";
import { db } from "../../../lib/db";
import { dict } from "../../../lib/i18n";
import { loadMissionList, loadMissionPage } from "../../../lib/mission-page";
import { loadModelPrices } from "../../../lib/prices";
import { pagePrincipal } from "../../../lib/web-scope";
import { MissionView } from "./mission-view";

export const dynamic = "force-dynamic";

/**
 * /missions/<id> (navigation plan E3). Someone else's mission, for a member,
 * is the same "mission not found" as one that does not exist.
 */
export default async function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const principal = await pagePrincipal(session);
  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  const { id } = await params;
  const page = await loadMissionPage(db(), ws.id, principal, id);
  if (!page) notFound();

  const t = dict(ws.language);
  // The whole mission, whatever the board's scope, by the Usage page's numbers.
  const filter: BoardFilter = {
    organizationIds: [],
    projectIds: [],
    missionId: page.mission.id,
    types: [],
    priorities: [],
  };
  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  const [totals, list] = await Promise.all([
    loadBoardTotals(db(), ws.id, ws.pricingEnabled, prices, filter, principal),
    loadMissionList(db(), ws.id, principal),
  ]);
  const cards = toBoardCards(page.rows, {
    tr: t,
    pricingEnabled: ws.pricingEnabled,
    viewerId: session.userId,
    claimTimeoutMinutes: ws.claimTimeoutMinutes,
  });
  const missions = list.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    objective: item.objective,
    context: "",
    counts: item.counts,
  }));

  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />
      <MissionView
        lang={ws.language}
        mission={{ ...page.mission, counts: page.counts }}
        cards={cards}
        missions={missions}
        projectNames={page.projects.map((item) => item.name)}
        ran={page.ran}
        totals={totals}
        pricingEnabled={ws.pricingEnabled}
        usageHref={`/insights?${boardFilterToQuery(filter)}`}
        viewerRole={principal.role}
      />
      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
