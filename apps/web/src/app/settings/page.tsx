import { asc, count, desc, eq, isNotNull, and } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  cardapioEntry,
  executionAttempt,
  factoryCardapioPolicy,
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
import {
  EXECUTOR_CATALOG,
  selectionFromConfig,
} from "../../lib/executors";
import { loadModelPrices } from "../../lib/prices";
import { loadUsageRecipes } from "../../lib/recipes";
import { detectRuntime } from "../../lib/runtime";
import { detectDeployMode } from "../../lib/deploy-mode";
import {
  SOURCE_UPDATE_COMMAND,
  updateCommand,
  updaterEnableCommand,
} from "../../lib/update-commands";
import { APP_VERSION, readUpdaterState } from "../../lib/updates";
import { SettingsClient } from "./settings-client";
import {
  isExecutorPairConfigured,
  normalizeObservedExecutor,
} from "../../mcp/executor-identity";

export const dynamic = "force-dynamic";

/** The tabs the client knows, so a link can land on one (OCL-20). */
const SETTINGS_TABS = new Set([
  "exec",
  "organizations",
  "projects",
  "policy",
  "prices",
  "recipes",
  "tokens",
  "claims",
  "language",
  "updates",
]);

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
  const initialTab =
    typeof tabParam === "string" && SETTINGS_TABS.has(tabParam)
      ? tabParam
      : "exec";

  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
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

  const entries = await db()
    .select()
    .from(cardapioEntry)
    .where(eq(cardapioEntry.workspaceId, ws.id));

  // The table always shows every type: what is already stored overrides the
  // factory policy, the rest shows the default the agent already uses.
  const stored = new Map(entries.map((e) => [e.activityType, e]));
  const cardapioRows = factoryCardapioPolicy().map((f) => {
    const row = stored.get(f.type);
    // A row saved before chains existed keeps its single model, which reads as
    // a line of succession one deep. That is what it always was.
    const chain = row ? (row.chain ?? (row.model ? [row.model] : [])) : (f.chain ?? []);
    return {
      activityType: f.type,
      cli: row ? row.cli : f.cli,
      model: row ? row.model : f.model,
      chain: [...chain],
      effort: row ? row.effort : f.effort,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });

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
  const selection = selectionFromConfig(ws.executors);
  // Coverage is computed here and not in the client component: importing
  // the helper there would pull the db package's postgres client into the
  // browser bundle. Executors learned from real connections carry their
  // own label, catalog ones take the catalog's.
  const coverage = recipeCoverage(
    recipes,
    ws.executors
      .filter((row) => row.enabled)
      .map((row) => ({
        id: row.id,
        label:
          row.label ||
          EXECUTOR_CATALOG.find((d) => d.id === row.id)?.label ||
          row.id,
      })),
  );

  // Models this board has actually run, and all models shown by the
  // executor catalog. If one lacks a price yet, Settings shows it with a
  // warning so nobody has to guess which name to type.
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
  const catalogModels = Object.values(selection.models).flatMap((list) => list);
  const normalizedSeen = ws.seenExecutors.flatMap((row) => {
    const identity = normalizeObservedExecutor(row);
    return identity ? [{ ...row, ...identity }] : [];
  });
  const clean = (models: (string | null)[]) =>
    models
      .map((model) => model?.trim())
      .filter((model): model is string => Boolean(model));
  const unpriced = (models: string[]) =>
    [...new Set(models.filter((model) => findModelPrice(prices, model) == null))].sort();

  // Two lists, because they carry different weight. A model that already ran
  // cards here is spending money nobody can count; a model that is merely
  // configured has not cost anything yet.
  const unpricedRanModels = unpriced(clean(ranModels));
  const unpricedModels = unpriced(
    clean([
      ...ranModels,
      ...catalogModels,
      ...normalizedSeen.map((row) => row.model),
    ]),
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

  // Pairs observed on real connections that the config still does not cover.
  const seenSuggestions = normalizedSeen
    .filter((s) => !isExecutorPairConfigured(ws.executors, s.cli, s.model))
    .map((s) => ({
      cli: s.cli,
      model: s.model,
      count: s.count,
      lastSeenAt: s.lastSeenAt,
    }));

  return (
    <div className="nb nebula-surface">
      <SettingsClient
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
        executors={selection}
        lang={ws.language}
        updateMode={ws.updateMode}
        updateLog={ws.updateLog}
        version={APP_VERSION}
        runtime={runtime}
        updater={updater}
        enableCommand={updaterEnableCommand(deployMode)}
        manualCommand={updateCommand(deployMode)}
        sourceCommand={SOURCE_UPDATE_COMMAND}
        seenSuggestions={seenSuggestions}
        cardapio={cardapioRows}
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
