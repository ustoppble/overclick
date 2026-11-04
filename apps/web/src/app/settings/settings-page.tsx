import { asc, count, desc, eq, isNotNull } from "drizzle-orm";
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
import { db } from "../../lib/db";
import { EXECUTOR_CATALOG } from "../../lib/executors";
import { loadModelPrices } from "../../lib/prices";
import { loadRanClis, loadUsageRecipes } from "../../lib/recipes";
import { detectRuntime } from "../../lib/runtime";
import { detectDeployMode } from "../../lib/deploy-mode";
import {
  SOURCE_UPDATE_COMMAND,
  updateCommand,
} from "../../lib/update-commands";
import { APP_VERSION } from "../../lib/updates";
import { SettingsClient } from "./settings-client";
import { loadPendingInvitations, loadTeam } from "../../lib/invitations";
import { publicOrigin } from "../../lib/public-url";
import type { SettingsPlace } from "./groups";

/**
 * One Settings page, for an admin already checked by the route: everything
 * the panels read, and the one panel the page is (`place`). The routes are
 * `/settings/<group>` for a group with no sections and
 * `/settings/<group>/<section>` for the rest.
 */
export async function SettingsPage({
  userId,
  place,
}: {
  userId: string;
  place: SettingsPlace;
}) {
  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  const projects = await db().query.project.findMany({
    where: eq(project.workspaceId, ws.id),
    orderBy: asc(project.createdAt),
    columns: {
      id: true,
      name: true,
      idPrefix: true,
      organizationId: true,
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
  // The configured public address wins when there is one; the request's own
  // Host is only the fallback for what is printed on this page, never for an email.
  const host = h.get("host") ?? "<your-host>";
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim()
    ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = publicOrigin() ?? `${proto}://${host}`;

  // Which update advice applies here: a container is updated by a command on
  // the server, a checkout can be pulled and restarted.
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
          currentUserId: userId,
          organizations: organizations.map((row) => ({
            id: row.id,
            name: row.name,
            projects: projects
              .filter((p) => p.organizationId === row.id)
              .map((p) => ({ id: p.id, name: p.name })),
          })),
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
        manualCommand={updateCommand(deployMode)}
        sourceCommand={SOURCE_UPDATE_COMMAND}
        prices={prices}
        unpricedModels={unpricedModels}
        unpricedRanModels={unpricedRanModels}
        recipes={recipes}
        coverage={coverage}
        pricingEnabled={ws.pricingEnabled}
        claimTimeoutMinutes={ws.claimTimeoutMinutes}
        view={place}
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
