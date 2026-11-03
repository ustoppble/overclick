import { organization, project, task, user, type Database } from "@agent-board/db";
import { describe, expect, it } from "vitest";
import { createRealPostgresWorld } from "../mcp/test-db-postgres";
import { loadOlderBoardTasks } from "./board-tasks";

/**
 * The "show older" cursor compares a timestamp against an expression, where
 * drizzle hands the value to the driver unmapped. PGlite takes a Date there;
 * postgres-js refuses it, and the button answered 500 in a production build
 * while the PGlite suite stayed green.
 *
 * Skipped without DATABASE_URL, like the other real-Postgres suites.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "board window paging against real postgres-js",
  () => {
    it("pages older cards past a cursor", async () => {
      const world = await createRealPostgresWorld();
      try {
        const [org] = await world.db
          .insert(organization)
          .values({ workspaceId: world.workspaceId, name: "General" })
          .returning({ id: organization.id });
        const [proj] = await world.db
          .insert(project)
          .values({
            workspaceId: world.workspaceId,
            organizationId: org!.id,
            name: "Board",
            idPrefix: "BRD",
          })
          .returning({ id: project.id });
        const [admin] = await world.db
          .insert(user)
          .values({ email: "admin@example.test", passwordHash: "x", role: "admin" })
          .returning({ id: user.id });
        for (let i = 0; i < 3; i += 1) {
          const at = new Date(Date.UTC(2026, 0, 10 - i));
          await world.db.insert(task).values({
            projectId: proj!.id,
            shortId: `BRD-${i + 1}`,
            title: `old ${i}`,
            status: "validado",
            createdByUserId: admin!.id,
            createdAt: at,
            updatedAt: at,
          });
        }
        const principal = { userId: admin!.id, role: "admin" as const, organizationId: null };
        const projects = [{ id: proj!.id, organizationId: org!.id }];
        const filter = { organizationIds: [], projectIds: [], missionId: null, types: [], priorities: [] };
        const database = world.db as unknown as Database;

        const first = await loadOlderBoardTasks(database, projects, principal, {
          status: "validado",
          filter,
          before: null,
          limit: 1,
        });
        expect(first.tasks.map((row) => row.title)).toEqual(["old 0"]);
        const cursor = first.tasks[0]!;
        const next = await loadOlderBoardTasks(database, projects, principal, {
          status: "validado",
          filter,
          before: { updatedAt: cursor.updatedAt.toISOString(), id: cursor.id },
          limit: 5,
        });
        expect(next.tasks.map((row) => row.title)).toEqual(["old 1", "old 2"]);
        expect(next.hasMore).toBe(false);
      } finally {
        await world.close();
      }
    });
  },
);
