import {
  executionAttempt,
  mission,
  project,
  task,
  user,
  type Database,
} from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  linkProjects,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";
import { loadMissionList, loadMissionPage } from "./mission-page";
import type { Principal } from "./scope";

let world: TestWorld;

function database(): Database {
  return world.db as unknown as Database;
}

/**
 * /missions/<id> (navigation plan E3, F5): a mission is a place of its own. It
 * ignores the board's project scope, so a mission that spans two projects
 * shows both; a member opens only the missions that are theirs.
 */
describe("the mission page", () => {
  let siteProjectId = "";
  let memberId = "";
  let member: Principal;

  beforeEach(async () => {
    world = await createTestWorld();
    const [site] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Site",
        idPrefix: "OVW",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    siteProjectId = site!.id;
    const [row] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    memberId = row!.id;
    member = { userId: memberId, role: "member", organizationId: world.organizationId };
    // The member works on OverClick only; Site is not linked to them.
    await linkProjects(world.db, memberId, [world.projectId]);
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  async function card(
    projectId: string,
    shortId: string,
    status: "aberto" | "em_execucao" | "feito" | "validado" | "descartado",
    createdByUserId = world.adminUserId,
    missionId: string | null = world.missionId,
  ) {
    const [row] = await world.db
      .insert(task)
      .values({
        projectId,
        missionId,
        shortId,
        title: `card ${shortId}`,
        oQue: "what",
        porQue: "why",
        comoConfirmo: "[]",
        status,
        createdByUserId,
      })
      .returning({ id: task.id });
    return row!.id;
  }

  it("shows the cards of both projects, whatever the board's scope", async () => {
    await card(world.projectId, "OC-1", "feito");
    await card(siteProjectId, "OVW-1", "aberto");
    // A card of the same project outside the mission stays out.
    await card(world.projectId, "OC-2", "aberto", world.adminUserId, null);

    const page = await loadMissionPage(
      database(),
      world.workspaceId,
      adminPrincipal(world),
      world.missionId,
    );
    expect(page).not.toBeNull();
    expect(page!.rows.map((row) => row.shortId).sort()).toEqual(["OC-1", "OVW-1"]);
    expect(page!.projects.map((item) => item.name).sort()).toEqual(["OverClick", "Site"]);
    expect(page!.counts).toMatchObject({ total: 2, aberto: 1, feito: 1 });
    expect(page!.mission.title).toBe("Norte do board");
  });

  it("lists what ran, one entry per distinct record", async () => {
    const a = await card(world.projectId, "OC-1", "feito");
    const b = await card(siteProjectId, "OVW-1", "em_execucao");
    const started = new Date();
    const attempt = (taskId: string, cli: string, model: string, effort: string) => ({
      taskId,
      executor: JSON.stringify({ cli, effort }),
      model,
      startedAt: started,
      lastActivityAt: started,
    });
    await world.db.insert(executionAttempt).values([
      attempt(a, "claude", "opus-5", "max"),
      attempt(a, "claude", "opus-5", "max"),
      attempt(b, "codex", "gpt-5-6-sol", "high"),
    ]);

    const page = await loadMissionPage(
      database(),
      world.workspaceId,
      adminPrincipal(world),
      world.missionId,
    );
    expect(page!.ran).toEqual([
      { cli: "claude", model: "opus-5", effort: "max" },
      { cli: "codex", model: "gpt-5-6-sol", effort: "high" },
    ]);
  });

  it("does not open someone else's mission to a member, the same as one that does not exist", async () => {
    const theirs = await loadMissionPage(database(), world.workspaceId, member, world.missionId);
    const none = await loadMissionPage(
      database(),
      world.workspaceId,
      member,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(theirs).toBeNull();
    expect(none).toBeNull();
    expect(await loadMissionPage(database(), world.workspaceId, member, "not-a-uuid")).toBeNull();
  });

  it("opens a member's own mission with only the cards of their linked projects in it", async () => {
    const [own] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        title: "Mine",
        status: "ativa",
        createdByUserId: memberId,
      })
      .returning({ id: mission.id });
    await card(world.projectId, "OC-5", "aberto", memberId, own!.id);
    await card(world.projectId, "OC-6", "aberto", world.adminUserId, own!.id);
    await card(siteProjectId, "OVW-6", "aberto", world.adminUserId, own!.id);

    const page = await loadMissionPage(database(), world.workspaceId, member, own!.id);
    expect(page!.rows.map((row) => row.shortId).sort()).toEqual(["OC-5", "OC-6"]);
    expect(page!.counts.total).toBe(2);
  });

  it("lists the missions the reader may see, with their counts and projects", async () => {
    await card(world.projectId, "OC-1", "validado");
    await card(siteProjectId, "OVW-1", "feito");

    const list = await loadMissionList(database(), world.workspaceId, adminPrincipal(world));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: world.missionId,
      title: "Norte do board",
      counts: { total: 2, feito: 1, validado: 1 },
    });
    expect(list[0]!.projectNames.sort()).toEqual(["OverClick", "Site"]);

    // The member reaches the mission through OC-1, and counts only it.
    const forMember = await loadMissionList(database(), world.workspaceId, member);
    expect(forMember.map((m) => m.id)).toEqual([world.missionId]);
    expect(forMember[0]).toMatchObject({ counts: { total: 1, validado: 1 } });
    expect(forMember[0]!.projectNames).toEqual(["OverClick"]);
  });
  it("follows the scope of the bar: the organization, then the projects (E4)", async () => {
    await card(world.projectId, "OC-1", "validado");
    await card(siteProjectId, "OVW-1", "feito");
    const [siteOnly] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        title: "Only the site",
        createdByUserId: world.adminUserId,
      })
      .returning({ id: mission.id });
    await card(siteProjectId, "OVW-2", "aberto", world.adminUserId, siteOnly!.id);
    const [empty] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        title: "Nothing yet",
        createdByUserId: world.adminUserId,
      })
      .returning({ id: mission.id });

    const narrowed = await loadMissionList(database(), world.workspaceId, adminPrincipal(world), {
      organizationIds: [world.organizationId],
      projectIds: [world.projectId],
    });
    // The site-only mission has nothing in the project on screen; the empty
    // one belongs to the organization and is where the next card goes.
    expect(narrowed.map((item) => item.id).sort()).toEqual([world.missionId, empty!.id].sort());
    const north = narrowed.find((item) => item.id === world.missionId)!;
    expect(north.counts).toMatchObject({ total: 1, validado: 1 });
    expect(north.projectNames).toEqual(["OverClick"]);

    const elsewhere = await loadMissionList(database(), world.workspaceId, adminPrincipal(world), {
      organizationIds: ["00000000-0000-4000-8000-000000000000"],
      projectIds: [],
    });
    expect(elsewhere).toEqual([]);

    const whole = await loadMissionList(database(), world.workspaceId, adminPrincipal(world), {
      organizationIds: [],
      projectIds: [],
    });
    expect(whole).toHaveLength(3);
  });
});
