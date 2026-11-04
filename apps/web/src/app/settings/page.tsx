import { asc, count, desc, eq, isNotNull, and } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  executionAttempt,
  findModelPrice,
  mcpToken,
  mission,
  organization,
  project,
  recipeCoverage,
  task,
} from "@agent-board/db";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { EXECUTOR_CATALOG } from "../../lib/executors";
import { loadModelPrices } from "../../lib/prices";
import { loadRanClis, loadUsageRecipes } from "../../lib/recipes";
import { detectRuntime } from "../../lib/runtime";
import { detectDeployMode } from "../../lib/deploy-mode";
import {
  SOURCE_UPDATE_COMMAND,
  updateCommand,
  updaterEnableCommand,
} from "../../lib/update-commands";
import { APP_VERSION, readUpdaterState, type UpdaterState } from "../../lib/updates";
import type { UpdateMode } from "@agent-board/db";

const EMPTY_UPDATER: UpdaterState = { running: false, lastSeenAt: null, status: null };
import { SettingsClient } from "./settings-client";
import { loadPendingInvitations, loadTeam } from "../../lib/invitations";
import { pagePrincipal } from "../../lib/web-scope";
import { settingsInitialTab } from "./tabs";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  // The topbar's unpriced-model warning links here straight to the price
  // table; an unknown tab is the same as no tab.
  const tabParam = (await searchParams).tab;
  const principal = await pagePrincipal(session);
  const admin = principal.role === "admin";
  const initialTab = settingsInitialTab(tabParam, admin);

  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  if (!admin) return <MemberSettings ws={ws} userId={principal.userId} organizationId={principal.organizationId} />;
  const projects = await db().query.project.findMany({
    where: eq(project.workspaceId, ws.id),
    orderBy: asc(project.createdAt),
    columns: {
      id: true,
      name: true,
      idPrefix: true,
      context: true,
      currentVersion: true,
      contextSource: true,
    },
  });
  const proj = projects[0];

  // The counts the delete refusal is made of, read here so the editor can say
  // what blocks a deletion before anyone clicks it.
  const organizations = await db()
    .select({
      id: organization.id,
      name: organization.name,
      context: organization.context,
    })
    .from(organization)
    .where(eq(organization.workspaceId, ws.id))
    .orderBy(asc(organization.name));
  const projectsPerOrganization = await db()
    .select({ organizationId: project.organizationId, n: count() })
    .from(project)
    .where(eq(project.workspaceId, ws.id))
    .groupBy(project.organizationId);
  const missionsPerOrganization = await db()
    .select({ organizationId: mission.organizationId, n: count() })
    .from(mission)
    .where(eq(mission.workspaceId, ws.id))
    .groupBy(mission.organizationId);
  const projectCounts = new Map(
    projectsPerOrganization.map((row) => [row.organizationId, Number(row.n)]),
  );
  const missionCounts = new Map(
    missionsPerOrganization.map((row) => [row.organizationId, Number(row.n)]),
  );

  const tokens = await db()
    .select({
      id: mcpToken.id,
      label: mcpToken.label,
      tokenPrefix: mcpToken.tokenPrefix,
      canManage: mcpToken.canManage,
      revoked: mcpToken.revoked,
      lastUsedAt: mcpToken.lastUsedAt,
      createdAt: mcpToken.createdAt,
    })
    .from(mcpToken)
    .where(eq(mcpToken.workspaceId, ws.id))
    .orderBy(desc(mcpToken.createdAt));

  const prices = await loadModelPrices(db(), ws.id);
  const recipes = await loadUsageRecipes(db(), ws.id);
  // Coverage is computed here and not in the client component: importing
  // the helper there would pull the db package's postgres client into the
  // browser bundle. The CLIs are the ones the attempts recorded (E2): the
  // board no longer keeps a list of enabled executors.
  const coverage = recipeCoverage(recipes, await loadRanClis(db(), ws.id));

  // Models this board has actually run, and the models the built-in catalog
  // suggests. If one lacks a price yet, Settings shows it with a warning so
  // nobody has to guess which name to type.
  // Both the model recorded at claim and every model the run actually
  // switched to: a segment nobody priced spends just as much as the first one.
  const attemptModels = await db()
    .select({
      model: executionAttempt.model,
      segments: executionAttempt.usageSegments,
    })
    .from(executionAttempt)
    .innerJoin(task, eq(executionAttempt.taskId, task.id))
    .innerJoin(project, eq(task.projectId, project.id))
    .where(eq(project.workspaceId, ws.id));
  const ranModels = attemptModels.flatMap((row) => [
    row.model,
    ...(row.segments ?? []).map((segment) => segment.model),
  ]);
  const catalogModels = EXECUTOR_CATALOG.flatMap((def) => def.models);
  const clean = (models: (string | null)[]) =>
    models
      .map((model) => model?.trim())
      .filter((model): model is string => Boolean(model));
  const unpriced = (models: string[]) =>
    [...new Set(models.filter((model) => findModelPrice(prices, model) == null))].sort();

  // Two lists, because they carry different weight. A model that already ran
  // cards here is spending money nobody can count; a model that is merely
  // suggested has not cost anything yet.
  const unpricedRanModels = unpriced(clean(ranModels));
  const unpricedModels = unpriced(
    clean([...ranModels, ...catalogModels]),
  );

  const h = await headers();
  // A TLS instance sits behind a proxy that terminates it, so the scheme comes
  // from the forwarded header. Never hardcode http: the commands we print carry
  // a bearer token.
  const host = h.get("host") ?? "<your-host>";
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim()
    ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = `${proto}://${host}`;

  // Read on the server, from the volume the sidecar shares: a mounted trigger
  // directory says nothing, only a fresh heartbeat means somebody can pull.
  const updater = await readUpdaterState();

  // Which update advice can possibly apply here: a container can be recreated,
  // a checkout can only be pulled and restarted.
  const runtime = detectRuntime();
  // Hosted vs quickstart (OCL-73): picks the command that matches the compose
  // project this instance actually runs under, so a hosted instance is never
  // shown the quickstart's raw docker compose command.
  const deployMode = detectDeployMode();

  const [members, invitations] = await Promise.all([
    loadTeam(db(), ws.id),
    loadPendingInvitations(db(), ws.id),
  ]);

  return (
    <div className="nb nebula-surface">
      <SettingsClient
        isAdmin
        team={{
          currentUserId: session.userId,
          organizations: organizations.map((row) => ({ id: row.id, name: row.name })),
          members,
          invitations,
        }}
        host={host}
        origin={origin}
        workspaceName={ws.name}
        projectName={proj?.name ?? ws.name}
        organizations={organizations.map((row) => ({
          id: row.id,
          name: row.name,
          context: row.context ?? "",
          projectCount: projectCounts.get(row.id) ?? 0,
          missionCount: missionCounts.get(row.id) ?? 0,
        }))}
        projects={projects.map((row) => ({
          id: row.id,
          name: row.name,
          idPrefix: row.idPrefix,
          context: row.context ?? "",
          currentVersion: row.currentVersion ?? "",
          contextSource: row.contextSource
            ? {
                releasesRepo: row.contextSource.releasesRepo,
                contextFile: row.contextSource.contextFile,
                refresh: row.contextSource.refresh,
              }
            : null,
        }))}
        lang={ws.language}
        updateMode={ws.updateMode}
        updateLog={ws.updateLog}
        version={APP_VERSION}
        runtime={runtime}
        updater={updater}
        enableCommand={updaterEnableCommand(deployMode)}
        manualCommand={updateCommand(deployMode)}
        sourceCommand={SOURCE_UPDATE_COMMAND}
        prices={prices}
        unpricedModels={unpricedModels}
        unpricedRanModels={unpricedRanModels}
        recipes={recipes}
        coverage={coverage}
        pricingEnabled={ws.pricingEnabled}
        claimTimeoutMinutes={ws.claimTimeoutMinutes}
        initialTab={initialTab}
        tokens={tokens.map((t) => ({
          id: t.id,
          label: t.label,
          masked: `${t.tokenPrefix ?? "ocb_"}••••••••`,
          canManage: t.canManage,
          revoked: t.revoked,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}

/** The request origin, for the commands and links Settings prints. */
async function requestOrigin(): Promise<{ host: string; origin: string }> {
  const h = await headers();
  const host = h.get("host") ?? "<your-host>";
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim()
    ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return { host, origin: `${proto}://${host}` };
}

/**
 * Settings as a member sees it: their own tokens and the pairing with the
 * Overclock app. Nothing of the workspace configuration is read, so nothing of
 * it can reach the page even hidden.
 */
async function MemberSettings({
  ws,
  userId,
  organizationId,
}: {
  ws: { id: string; name: string; language: string; updateMode: UpdateMode; claimTimeoutMinutes: number };
  userId: string;
  organizationId: string | null;
}) {
  const tokens = await db()
    .select({
      id: mcpToken.id,
      label: mcpToken.label,
      tokenPrefix: mcpToken.tokenPrefix,
      canManage: mcpToken.canManage,
      revoked: mcpToken.revoked,
      lastUsedAt: mcpToken.lastUsedAt,
      createdAt: mcpToken.createdAt,
    })
    .from(mcpToken)
    .where(and(eq(mcpToken.workspaceId, ws.id), eq(mcpToken.ownerUserId, userId)))
    .orderBy(desc(mcpToken.createdAt));
  const [proj] = organizationId
    ? await db()
        .select({ name: project.name })
        .from(project)
        .where(and(eq(project.workspaceId, ws.id), eq(project.organizationId, organizationId)))
        .orderBy(asc(project.createdAt))
        .limit(1)
    : [];
  const { host, origin } = await requestOrigin();

  return (
    <div className="nb nebula-surface">
      <SettingsClient
        isAdmin={false}
        team={null}
        host={host}
        origin={origin}
        workspaceName={ws.name}
        projectName={proj?.name ?? ws.name}
        organizations={[]}
        projects={[]}
        lang={ws.language}
        updateMode={ws.updateMode}
        updateLog={null}
        version={APP_VERSION}
        runtime={detectRuntime()}
        updater={EMPTY_UPDATER}
        enableCommand=""
        manualCommand=""
        sourceCommand=""
        prices={[]}
        unpricedModels={[]}
        unpricedRanModels={[]}
        recipes={[]}
        coverage={[]}
        pricingEnabled={false}
        claimTimeoutMinutes={ws.claimTimeoutMinutes}
        initialTab="tokens"
        tokens={tokens.map((t) => ({
          id: t.id,
          label: t.label,
          masked: `${t.tokenPrefix ?? "ocb_"}••••••••`,
          canManage: t.canManage,
          revoked: t.revoked,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
