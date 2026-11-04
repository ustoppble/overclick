import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { mission, organization, project, task, user } from "@agent-board/db";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { UpdateBanner } from "../../components/update-banner";
import { InstallNotice } from "../../components/install-notice";
import { loadInstallNotices } from "../../lib/invitations";
import {
  boardFilterFromQuery,
  filterBoardCards,
  releaseValueOptions,
  scopeOverrideFromSearch,
} from "../../lib/board-filter";
import { resolveCardRoute, type CardRoute } from "../../lib/card-route";
import { CARD_ROUTE_PARAM, withQuery } from "../../lib/redirects";
import { toBoardCards } from "../../lib/board-card";
import { findLinkedCard } from "../../lib/board-window";
import {
  boardWindowStart,
  findBoardTaskByShortId,
  loadBoardTasks,
  loadBoardTasksByIds,
} from "../../lib/board-tasks";
import { loadReviewQueue, readReviewScope } from "../../lib/review-queue";
import { readBoardPerson } from "../../lib/person-filter";
import { joinReviewQueue } from "../../lib/review-queue-order";
import { loadBoardSignature } from "../../lib/board-signature";
import { loadBoardTotals } from "../../lib/board-totals-query";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { dict } from "../../lib/i18n";
import { loadModelPrices } from "../../lib/prices";
import {
  missionScope,
  organizationScope,
  projectScope,
  taskScope,
} from "../../lib/scope";
import { pagePrincipal } from "../../lib/web-scope";
import { detectRuntime } from "../../lib/runtime";
import { detectDeployMode } from "../../lib/deploy-mode";
import {
  SOURCE_UPDATE_COMMAND,
  updateCommand,
  updaterEnableCommand,
} from "../../lib/update-commands";
import { scheduledUpdateCheck } from "../../lib/update-scheduler";
import { scheduledProjectContextRefresh } from "../../lib/project-context-scheduler";
import { readUpdaterState } from "../../lib/updates";
import { BoardLoading } from "./board-loading";
import { HomeShell } from "./home-shell";
import { ReviewQueueView } from "./review-queue-view";

export const dynamic = "force-dynamic";

function formatProjectContextStatus(
  updatedAt: Date,
  source: { releasesRepo?: string; contextFile?: string } | null,
  lang: string,
): string {
  const days = Math.max(
    0,
    Math.floor((Date.now() - updatedAt.getTime()) / 86_400_000),
  );
  const sourceLabel = source?.releasesRepo ?? source?.contextFile ?? "manual";
  if (lang === "pt-BR") {
    return `contexto atualizado há ${days} dias · ${sourceLabel}`;
  }
  return `context updated ${days} days ago · ${sourceLabel}`;
}

type Params = Record<string, string | string[] | undefined>;

/**
 * /board, and /cards/<id> (a rewrite to this page, navigation plan E3). A
 * card's address is decided before anything streams, so an old id answers a
 * real 307 to the current one and a card the reader may not see a real 404,
 * the same as one that does not exist. The board then streams behind its
 * skeleton.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const params = await searchParams;
  const cardAsked =
    typeof params[CARD_ROUTE_PARAM] === "string" ? params[CARD_ROUTE_PARAM] : null;
  let cardRoute: CardRoute | null = null;
  if (cardAsked) {
    const principal = await pagePrincipal(session);
    const ws = await db().query.workspace.findFirst({ columns: { id: true } });
    if (!ws) redirect("/setup");
    const visible = await db()
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.workspaceId, ws.id), projectScope(principal)));
    cardRoute = await resolveCardRoute(
      db(),
      visible.map((item) => item.id),
      principal,
      cardAsked,
    );
    if (cardRoute.kind === "not-found") notFound();
    // The query the address carried rides along (E3 review): the board
    // behind the card keeps the period and the filters the link meant.
    if (cardRoute.kind === "moved") redirect(withQuery(cardRoute.to, params, [CARD_ROUTE_PARAM]));
  }
  return (
    <Suspense fallback={<BoardLoading />}>
      <BoardContent params={params} cardRoute={cardRoute} />
    </Suspense>
  );
}

async function BoardContent({
  params,
  cardRoute,
}: {
  params: Params;
  cardRoute: CardRoute | null;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Everything below reads through this: a member's board is only their own
  // cards and missions and their organization's projects.
  const principal = await pagePrincipal(session);

  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  const projects = await db().query.project.findMany({
    where: and(eq(project.workspaceId, ws.id), projectScope(principal)),
    orderBy: asc(project.createdAt),
    columns: {
      id: true,
      name: true,
      organizationId: true,
      context: true,
      contextSource: true,
      contextUpdatedAt: true,
    },
  }).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      organizationId: row.organizationId,
      hasContext: Boolean(row.context?.trim()),
      contextStatus: row.contextUpdatedAt
        ? formatProjectContextStatus(
            row.contextUpdatedAt,
            row.contextSource,
            ws.language,
          )
        : null,
    })),
  );
  // Setup is the admin's. A member whose organization has no project yet is
  // not lost (OCL-227): they get their board, empty, like any new member.
  if (projects.length === 0 && principal.role === "admin") redirect("/setup");

  // Named, not creation-ordered: the filter is read as a list of businesses.
  const organizations = await db()
    .select({
      id: organization.id,
      name: organization.name,
      context: organization.context,
    })
    .from(organization)
    .where(and(eq(organization.workspaceId, ws.id), organizationScope(principal)))
    .orderBy(asc(organization.name))
    .then((rows) =>
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        hasContext: Boolean(row.context?.trim()),
      })),
    );

  const missionRows = await db().query.mission.findMany({
    where: and(eq(mission.workspaceId, ws.id), missionScope(principal)),
    orderBy: asc(mission.createdAt),
    columns: {
      id: true,
      title: true,
      status: true,
      objective: true,
      context: true,
    },
  });
  const missionCountRows =
    missionRows.length === 0
      ? []
      : await db()
          .select({ missionId: task.missionId, status: task.status, n: count() })
          .from(task)
          .where(
            and(
              inArray(task.missionId, missionRows.map((item) => item.id)),
              taskScope(principal),
            ),
          )
          .groupBy(task.missionId, task.status);
  const missionCounts = new Map<
    string,
    {
      total: number;
      aberto: number;
      em_execucao: number;
      feito: number;
      validado: number;
      descartado: number;
    }
  >();
  for (const row of missionCountRows) {
    if (!row.missionId) continue;
    const counts = missionCounts.get(row.missionId) ?? {
      total: 0,
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
      descartado: 0,
    };
    const value = Number(row.n);
    counts[row.status] += value;
    counts.total += value;
    missionCounts.set(row.missionId, counts);
  }
  const missions = missionRows.map((item) => ({
    ...item,
    counts: missionCounts.get(item.id) ?? {
      total: 0,
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
      descartado: 0,
    },
  }));

  // The To review list (navigation plan E1): every delivery waiting in the
  // reader's scope, oldest first, whatever the board's period and filters.
  if (params.status === "feito" && !cardRoute) {
    const t = dict(ws.language);
    // The address's scope wins over the remembered one (E4 review, item 1):
    // a link to the list of one project shows that project's deliveries.
    const scope = await readReviewScope(
      db(),
      ws.id,
      principal,
      undefined,
      scopeOverrideFromSearch(params),
    );
    const queue = await loadReviewQueue(db(), principal, scope);
    const queueRows = await loadBoardTasksByIds(
      db(),
      projects.map((item) => item.id),
      principal,
      queue.map((entry) => entry.id),
    );
    const cards = toBoardCards(queueRows, {
      tr: t,
      pricingEnabled: ws.pricingEnabled,
      viewerId: session.userId,
      claimTimeoutMinutes: ws.claimTimeoutMinutes,
    });
    // The list's number is the queue's length, the chip's count (B2); a line
    // the card query could not read does not quietly lower it.
    const { rows, count: queueCount, missing } = joinReviewQueue(queue, cards);
    if (missing.length > 0) {
      console.warn(`[review] ${missing.length} card(s) in the queue had no line to show`);
    }
    const { organization: org, project: proj } = scope.label;
    const scopeLabel = org && proj ? `${org} › ${proj}` : (proj ?? org ?? t.review.scopeAll);
    const asked = typeof params.card === "string" ? params.card.toUpperCase() : null;
    const openCardId = asked
      ? (rows.find((row) => row.card.shortId.toUpperCase() === asked)?.card.id ?? null)
      : null;
    const signature = await loadBoardSignature(
      db(),
      ws.id,
      projects.map((item) => item.id),
      principal,
    );
    return (
      <div className="nb nebula-surface">
        <NebulaAtmosphere />
        <ReviewQueueView
          lang={ws.language}
          rows={rows}
          missions={missions}
          viewerRole={principal.role}
          scopeLabel={scopeLabel}
          count={queueCount}
          openCardId={openCardId}
          boardSignature={signature}
        />
      </div>
    );
  }

  // Only the tags the workspace actually uses. This stays a small indexed-ish
  // dimension query instead of loading attempts or handoffs to build a menu.
  const releaseRows = await db()
    .selectDistinct({ value: task.resolvedIn })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(
      and(
        eq(project.workspaceId, ws.id),
        projectScope(principal),
        taskScope(principal),
        isNotNull(task.resolvedIn),
      ),
    )
    .orderBy(desc(task.resolvedIn));
  // Only the values that name a release. A delivery that stamped resolved_in
  // with its branch used to hand that branch to the RELEASE filter (OCL-128).
  const releases = releaseValueOptions(
    releaseRows.flatMap((row) => (row.value ? [{ value: row.value }] : [])),
  );

  // Only the scope, the person and the period are remembered (navigation plan E4, F2).
  // The mission, type, priority and release columns are still on the user,
  // from before, and are not read.
  const [me] = await db()
    .select({
      boardOrganizationId: user.boardOrganizationId,
      boardProjectId: user.boardProjectId,
      boardPeriod: user.boardPeriod,
      boardPeriodBy: user.boardPeriodBy,
      boardPerson: user.boardPerson,
    })
    .from(user)
    .where(eq(user.id, session.userId))
    .limit(1);

  const t = dict(ws.language);
  // Opt-in only: in the default mode this instance makes zero outbound calls.
  // In automatic it also starts the update here, without holding the render.
  // Updating the instance is the admin's; a member is not offered it.
  const release = principal.role === "admin" ? await scheduledUpdateCheck(ws) : null;
  // The admin learns here that a member's install worked (OCL-222).
  const installNotices =
    principal.role === "admin"
      ? await loadInstallNotices(db(), { workspaceId: ws.id, adminUserId: principal.userId })
      : [];
  scheduledProjectContextRefresh(db(), ws.id);
  // Only a live sidecar makes the banner's button do anything. Read it just
  // when there is a banner to draw.
  const updater = release ? await readUpdaterState() : null;
  const projectIds = projects.map((item) => item.id);
  // The URL wins over the memory, and the memory only fills what the URL
  // does not say (E4, F2): a link with ?period=30d shows 30 days to whoever
  // opens it. The period is part of the filter, and the window is built from it.
  const rememberedFilter = boardFilterFromQuery(
    {
      organizations: one(params.organizations),
      projects: one(params.projects),
      mission: one(params.mission),
      types: one(params.types),
      priorities: one(params.priorities),
      release: one(params.release),
      period: one(params.period),
      periodBy: one(params.periodBy),
    },
    projects,
    missions,
    releases,
    organizations,
    {
      organizationId: me?.boardOrganizationId ?? null,
      projectId: me?.boardProjectId ?? null,
      period: me?.boardPeriod ?? null,
      periodBy: me?.boardPeriodBy ?? null,
    },
  );
  // A card's address opens over the board of the card's project when the
  // remembered filter would hide it. Nothing is saved: the next visit to
  // /board is the reader's own board again.
  const addressed = cardRoute?.kind === "open" ? cardRoute.row : null;
  const initialFilter =
    addressed &&
    filterBoardCards(
      [{ ...addressed, organizationId: addressed.project.organizationId }],
      rememberedFilter,
    ).length === 0
      ? {
          organizationIds: [],
          projectIds: [addressed.projectId],
          missionId: null,
          types: [],
          priorities: [],
          period: rememberedFilter.period,
          periodBy: rememberedFilter.periodBy,
        }
      : rememberedFilter;
  // The window is the period, in every column: the cards that changed (or were
  // created, if the reader picked that date) in the last 7 days unless they
  // chose otherwise. The rest come in through the search or a link.
  const windowNow = new Date();
  // Read before the cards, so a write landing in between makes the poll
  // refresh once more instead of hiding behind a fingerprint newer than the page.
  const boardSignature = await loadBoardSignature(db(), ws.id, projectIds, principal);
  // The person filter of the global bar (person-filter.ts): the address's
  // ?person= first, the remembered one otherwise, read back against the
  // people this reader can see. It narrows inside the scope, on the server.
  const person = await readBoardPerson(db(), ws.id, principal, scopeOverrideFromSearch(params), {
    remembered: me?.boardPerson ?? null,
  });
  const rows = await loadBoardTasks(db(), projectIds, principal, {
    now: windowNow,
    period: initialFilter.period,
    periodBy: initialFilter.periodBy,
    personUserId: person.userId,
  });
  // A link to one card (?card=OCL-12) opens it even when the window left it
  // out. Out of scope reads as no card, the same as an id that matches none.
  const linked = typeof params.card === "string" ? params.card : null;
  const linkedRow =
    addressed ??
    (linked
      ? (findLinkedCard(rows, linked) ??
        (await findBoardTaskByShortId(db(), projectIds, principal, linked)))
      : null);
  if (linkedRow && !rows.some((row) => row.id === linkedRow.id)) {
    rows.push(linkedRow);
  }
  // Same rule as the Insights page: no money layer, no price table to read.
  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  // Each card's line only: the panel's share (contract, handoff, timeline,
  // transcript) is read when a card is opened (loadBoardCardDetailAction).
  const cards = toBoardCards(rows, {
    tr: t,
    pricingEnabled: ws.pricingEnabled,
    viewerId: session.userId,
    claimTimeoutMinutes: ws.claimTimeoutMinutes,
  });
  // The topbar total, aggregated by the same code the Insights page runs so
  // the board and the page can only report the same numbers for one filter.
  const initialTotals = await loadBoardTotals(
    db(),
    ws.id,
    ws.pricingEnabled,
    prices,
    initialFilter,
    principal,
  );

  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />

      {release ? (
        <UpdateBanner
          version={release.version}
          changelog={release.changelog}
          url={release.url}
          helper={updater?.running ?? false}
          runtime={detectRuntime()}
          lang={ws.language}
          manualCommand={updateCommand(detectDeployMode())}
          enableCommand={updaterEnableCommand(detectDeployMode())}
          sourceCommand={SOURCE_UPDATE_COMMAND}
        />
      ) : null}

      <InstallNotice members={installNotices} lang={ws.language} />

      <HomeShell
        lang={ws.language}
        missions={missions}
        releases={releases}
        cards={cards}
        initialFilter={initialFilter}
        initialTotals={initialTotals}
        openCardId={linkedRow?.id ?? null}
        openedByAddress={addressed !== null}
        windowSince={boardWindowStart(windowNow, initialFilter.period)?.toISOString() ?? null}
        boardSignature={boardSignature}
        viewerRole={principal.role}
        initialQuery={one(params.q) ?? ""}
      />

      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}

/** One value of a query parameter; a repeated one reads as its first. */
function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? null;
}
