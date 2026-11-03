import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { mission, organization, project, task, user } from "@agent-board/db";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { UpdateBanner } from "../../components/update-banner";
import { InstallNotice } from "../../components/install-notice";
import { loadInstallNotices } from "../../lib/invitations";
import {
  releaseValueOptions,
  resolveBoardFilter,
} from "../../lib/board-filter";
import { toBoardCards } from "../../lib/board-card";
import { findLinkedCard } from "../../lib/board-window";
import {
  boardWindowStart,
  findBoardTaskByShortId,
  loadBoardTasks,
} from "../../lib/board-tasks";
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
import { loadUsageRecipes } from "../../lib/recipes";
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
import { HomeShell } from "./home-shell";

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

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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

  const [me] = await db()
    .select({
      boardOrganizationId: user.boardOrganizationId,
      boardProjectId: user.boardProjectId,
      boardMissionId: user.boardMissionId,
      boardTaskTypes: user.boardTaskTypes,
      boardPriorities: user.boardPriorities,
      boardResolvedIn: user.boardResolvedIn,
      boardPeriod: user.boardPeriod,
      boardPeriodBy: user.boardPeriodBy,
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
  // The period is part of the filter, and the window is built from it.
  const initialFilter = resolveBoardFilter(
    {
      organizationId: me?.boardOrganizationId ?? null,
      projectId: me?.boardProjectId ?? null,
      missionId: me?.boardMissionId ?? null,
      types: me?.boardTaskTypes ?? null,
      priorities: me?.boardPriorities ?? null,
      resolvedIn: me?.boardResolvedIn ?? null,
      period: me?.boardPeriod ?? null,
      periodBy: me?.boardPeriodBy ?? null,
    },
    projects,
    missions,
    releases,
    organizations,
  );
  // The window is the period, in every column: the cards that changed (or were
  // created, if the reader picked that date) in the last 7 days unless they
  // chose otherwise. The rest come in through the search or a link.
  const windowNow = new Date();
  // Read before the cards, so a write landing in between makes the poll
  // refresh once more instead of hiding behind a fingerprint newer than the page.
  const boardSignature = await loadBoardSignature(db(), ws.id, projectIds, principal);
  const rows = await loadBoardTasks(db(), projectIds, principal, {
    now: windowNow,
    period: initialFilter.period,
    periodBy: initialFilter.periodBy,
  });
  // A link to one card (?card=OCL-12) opens it even when the window left it
  // out. Out of scope reads as no card, the same as an id that matches none.
  const params = await searchParams;
  const linked = typeof params.card === "string" ? params.card : null;
  const linkedRow = linked
    ? (findLinkedCard(rows, linked) ??
      (await findBoardTaskByShortId(db(), projectIds, principal, linked)))
    : null;
  if (linkedRow && !rows.some((row) => row.id === linkedRow.id)) {
    rows.push(linkedRow);
  }
  // Same rule as the Insights page: no money layer, no price table to read.
  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  // The same recipes the briefing hands agents, so the card's recompute
  // command is the one that measured the run, pinned to its transcript.
  const recipes = await loadUsageRecipes(db(), ws.id);
  const cards = toBoardCards(rows, {
    tr: t,
    pricingEnabled: ws.pricingEnabled,
    recipes,
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
        organizations={organizations}
        projects={projects}
        missions={missions}
        releases={releases}
        cards={cards}
        initialFilter={initialFilter}
        initialTotals={initialTotals}
        openCardId={linkedRow?.id ?? null}
        windowSince={boardWindowStart(windowNow, initialFilter.period)?.toISOString() ?? null}
        boardSignature={boardSignature}
      />

      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
