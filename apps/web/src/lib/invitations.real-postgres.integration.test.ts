import { organization, user } from "@agent-board/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createRealPostgresWorld } from "../mcp/test-db-postgres";
import { acceptInvitation, createInvitation } from "./invitations";

/**
 * R5 of the OCL-224 review, fixed in OCL-227: two pending links for the same
 * email accepted at the same moment. Both pass the "email taken" check before
 * either commits, and the second insert hits the unique email. PGlite runs one
 * transaction at a time, so only a real server can race them.
 *
 * Skipped without DATABASE_URL, like the other real-Postgres suites.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "invitation accept race against real postgres-js (OCL-227)",
  () => {
    it("creates one account and answers email_taken to the other links, never a 500", async () => {
      const world = await createRealPostgresWorld();
      try {
        const [org] = await world.db
          .insert(organization)
          .values({ workspaceId: world.workspaceId, name: "General" })
          .returning({ id: organization.id });
        const [admin] = await world.db
          .insert(user)
          .values({ email: "admin@example.test", role: "admin" })
          .returning({ id: user.id });

        // Several links for one email, all created before any was accepted,
        // which is how they stay pending. More than two, so the accepts
        // overlap on the pool's connections instead of queueing behind one.
        const links = [];
        for (let i = 0; i < 6; i++) {
          const created = await createInvitation(world.db, {
            workspaceId: world.workspaceId,
            email: "func@example.test",
            organizationId: org!.id,
            createdByUserId: admin!.id,
          });
          if (!created.ok) throw new Error(created.error);
          links.push(created.secret);
        }

        // Open the connections first: a fresh one takes longer to come up
        // than a whole accept takes to commit, and the race never happens.
        const raw = world.db as unknown as { execute(query: SQL): Promise<unknown> };
        await Promise.all(links.map(() => raw.execute(sql`select pg_sleep(0.05)`)));
        const results = await Promise.all(
          links.map((secret) => acceptInvitation(world.db, secret)),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual(
          Array.from({ length: 5 }, () => ({ ok: false, reason: "email_taken" })),
        );
        expect(
          await world.db.select().from(user).where(eq(user.email, "func@example.test")),
        ).toHaveLength(1);
      } finally {
        await world.close();
      }
    }, 60_000);
  },
);
