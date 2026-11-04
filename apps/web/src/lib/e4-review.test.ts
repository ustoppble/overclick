import { executionAttempt, mission, project, task, user, type Database } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import type { AuthContext } from "../mcp/types";
import { boardPeriodToRemember, scopeOverrideFromSearch } from "./board-filter";
import { loadGlobalCounts } from "./global-counts";
import { loadMissionUsage } from "./mission-page";
import { readReviewScope } from "./review-queue";
import { principalFromUserId, type Principal } from "./scope";

/**
 * The E4 review (h-ipv) left five notes; E6 owns home-shell and the bar now
 * and closes them. Items 1, 2 and 5 are here; 3 is in app/home/page.test.ts
 * and 4 in components/global-bar/restore.test.ts.
 */

let world: TestWorld;
let admin: AuthContext;
let adminP: Principal;
let siteId: string;
const origem = { session_id: "sess_e4_review", cli: "test" };
const database = () => world.db as unknown as Database;

async function deliveredCard(projectId: string, title: string) {
  const created = await invokeTool(world.db, admin, "task_create", {
    title,
    type: "feature",
    o_que: "what",
    por_que: "why",
    como_confirmo: [{ step: "run", expected: "works" }],
    origem,
    project_id: projectId,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const id = (created.value as { task: { id: string } }).task.id;
  await invokeTool(world.db, admin, "task_claim", { task_id: id, executor: { cli: "claude", model: "sonnet-5" } });
  const done = await invokeTool(world.db, admin, "task_deliver", {
    task_id: id,
    summary: "delivered",
    usage: { segments: [{ model: "sonnet-5", input: 10, output: 5, cache_read: 0, cache_write: 0 }], duration_ms: 1, turns: 1 },
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  return id;
}

beforeEach(async () => {
  world = await createTestWorld();
  admin = {
    tokenId: world.tokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "admin",
    userId: world.adminUserId,
    role: "admin",
    canManage: true,
  };
  adminP = (await principalFromUserId(world.db, world.adminUserId))!;
  const [site] = await world.db
    .insert(project)
    .values({ workspaceId: world.workspaceId, organizationId: world.organizationId, name: "Site", idPrefix: "OVW", nextNumber: 1 })
    .returning({ id: project.id });
  siteId = site!.id;
});

afterEach(async () => {
  if (world) await closeTestWorld(world);
});

describe("1 · the address's scope reaches the chips, the review list and the poll", () => {
  it("reads the scope from the query, the memory filling only what the query does not say", () => {
    expect(scopeOverrideFromSearch("?projects=p1&period=30d")).toEqual({ projects: "p1" });
    expect(scopeOverrideFromSearch("organizations=o1&projects=all")).toEqual({
      organizations: "o1",
      projects: "all",
    });
    expect(scopeOverrideFromSearch("?types=bug&status=feito")).toBeUndefined();
    expect(scopeOverrideFromSearch({ projects: ["p1", "p2"], q: "x" })).toEqual({ projects: "p1" });
  });

  it("readReviewScope: a project in the address wins over the remembered one", async () => {
    await world.db.update(user).set({ boardProjectId: world.projectId }).where(eq(user.id, world.adminUserId));
    const remembered = await readReviewScope(database(), world.workspaceId, adminP);
    expect(remembered.projectIds).toEqual([world.projectId]);
    const fromUrl = await readReviewScope(database(), world.workspaceId, adminP, undefined, { projects: siteId });
    expect(fromUrl.projectIds).toEqual([siteId]);
    expect(fromUrl.label.project).toBe("Site");
    // "all" in the address is every project, whatever the memory says.
    const all = await readReviewScope(database(), world.workspaceId, adminP, undefined, { projects: "all" });
    expect(all.projectIds).toEqual([]);
  });

  it("the bar's numbers follow the address, not the memory", async () => {
    await deliveredCard(world.projectId, "here");
    await deliveredCard(siteId, "there one");
    await deliveredCard(siteId, "there two");
    await world.db.update(user).set({ boardProjectId: world.projectId }).where(eq(user.id, world.adminUserId));
    expect(await loadGlobalCounts(database(), world.workspaceId, adminP)).toEqual({ running: 0, review: 1 });
    expect(
      await loadGlobalCounts(database(), world.workspaceId, adminP, undefined, { projects: siteId }),
    ).toEqual({ running: 0, review: 2 });
  });

  it("a project the reader cannot see in the address narrows nothing and leaks nothing", async () => {
    const [m] = await world.db
      .insert(user)
      .values({ email: "m@example.test", passwordHash: "x", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    const memberP = (await principalFromUserId(world.db, m!.id))!;
    const unknown = "00000000-0000-4000-8000-000000000000";
    const remembered = await readReviewScope(database(), world.workspaceId, memberP);
    const scope = await readReviewScope(database(), world.workspaceId, memberP, undefined, {
      projects: unknown,
    });
    // An id the reader cannot see resolves like no pick at all.
    expect(scope.projectIds).not.toContain(unknown);
    expect(scope.projectIds).toEqual(remembered.projectIds);
  });
});

describe("2 · the missions list's usage follows the bar's scope", () => {
  it("counts only the attempts of the projects in scope", async () => {
    const here = await deliveredCard(world.projectId, "here");
    const there = await deliveredCard(siteId, "there");
    await world.db.update(task).set({ missionId: world.missionId });
    const attempts = await world.db.select({ id: executionAttempt.id }).from(executionAttempt);
    expect(attempts.length).toBe(2);
    expect([here, there].length).toBe(2);

    const all = await loadMissionUsage(database(), world.workspaceId, false, [], adminP);
    expect(all.get(world.missionId)?.attempts).toBe(2);
    const site = await loadMissionUsage(database(), world.workspaceId, false, [], adminP, {
      organizationIds: [],
      projectIds: [siteId],
    });
    expect(site.get(world.missionId)?.attempts).toBe(1);
  });

  it("a mission always has an organization, so the organization filter hides none", () => {
    expect(mission.organizationId.notNull).toBe(true);
  });
});

describe("5 · only scope and period are remembered, and the filter line remembers only the period", () => {
  const base = {
    organizationIds: ["o-url"],
    projectIds: ["p-url"],
    missionId: null,
    types: [],
    priorities: [],
    period: "7d" as const,
    periodBy: "updated" as const,
  };

  it("type, priority or mission changes remember nothing", () => {
    expect(boardPeriodToRemember(base, { ...base, types: ["bug"] })).toBeNull();
    expect(boardPeriodToRemember(base, { ...base, priorities: ["alta"] })).toBeNull();
    expect(boardPeriodToRemember(base, { ...base, missionId: "m1" })).toBeNull();
  });

  it("a period change remembers the period, never the address's scope", () => {
    const saved = boardPeriodToRemember(base, { ...base, period: "30d" });
    expect(saved).toEqual({ period: "30d", periodBy: "updated" });
    expect(saved).not.toHaveProperty("projectIds");
    expect(boardPeriodToRemember(base, { ...base, periodBy: "created" })).toEqual({
      period: "7d",
      periodBy: "created",
    });
  });
});
