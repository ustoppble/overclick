import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emergencyLogin, mcpToken, user } from "@agent-board/db";
import {
  EMERGENCY_LOGIN_TTL_MS,
  createEmergencyLogin,
  runEmergencyLogin,
} from "@agent-board/db/emergency-login";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { redeemEmergencyLogin } from "./emergency-login";
import { issueLoginCode, redeemLoginCode } from "./login-code";
import { sweepLoginRows } from "./login-housekeeping";
import { MAX_CODE_USER_FAILURES } from "./login-rate-limit";

let world: TestWorld;
let dir: string;

const ADMIN = "admin@example.test";
const T0 = new Date("2026-11-03T12:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** The token as the file carries it, after the `#`. */
function tokenIn(file: string): string {
  const match = readFileSync(file, "utf8").match(/\/login\/emergency#([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no link in the file");
  return match[1]!;
}

/**
 * The server owner's way in when the board cannot send mail (or the admin is
 * locked out): a script run inside the container writes a single-use link,
 * good for ten minutes, to a file only its owner can read, and prints the
 * file's path and nothing else.
 */
describe("emergency sign-in", () => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = "s".repeat(32);
    world = await createTestWorld();
    dir = mkdtempSync(join(tmpdir(), "ocl-emergency-test-"));
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AUTH_SECRET;
  });

  describe("the script", () => {
    it("writes the link to a file only its owner can read and keeps only a hash of the token", async () => {
      const made = await createEmergencyLogin(world.db, ADMIN, { dir, now: at(0) });
      if (!made.ok) throw new Error(made.error);

      expect(statSync(made.file).mode & 0o777).toBe(0o600);
      const token = tokenIn(made.file);
      expect(token.length).toBeGreaterThanOrEqual(40);

      const rows = await world.db.select().from(emergencyLogin);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
      expect(rows[0]!.tokenHash).not.toContain(token);
      expect(rows[0]!.expiresAt.getTime()).toBe(at(EMERGENCY_LOGIN_TTL_MS).getTime());
      expect(EMERGENCY_LOGIN_TTL_MS).toBe(10 * 60 * 1000);
    });

    it("prints the file's path and nothing else: never the link, never the token", async () => {
      const lines: string[] = [];
      const code = await runEmergencyLogin([ADMIN], {
        db: world.db,
        dir,
        log: (line) => lines.push(line),
      });

      expect(code).toBe(0);
      const [file] = readdirSync(dir).map((name) => join(dir, name));
      const token = tokenIn(file!);
      expect(lines.join("\n")).toContain(file!);
      expect(lines.join("\n")).not.toContain(token);
      expect(lines.join("\n")).not.toContain("/login/emergency#");
    });

    it("refuses a member, a switched-off admin and an unknown address, and writes nothing", async () => {
      await world.db.insert(user).values([
        { email: "member@example.test", role: "member" },
        { email: "off-admin@example.test", role: "admin", active: false },
      ]);

      for (const email of ["member@example.test", "off-admin@example.test", "ghost@example.test"]) {
        const lines: string[] = [];
        expect(
          await runEmergencyLogin([email], { db: world.db, dir, log: (l) => lines.push(l) }),
        ).toBe(1);
      }
      expect(readdirSync(dir)).toHaveLength(0);
      expect(await world.db.select().from(emergencyLogin)).toHaveLength(0);
    });

    it("refuses to run without an address", async () => {
      expect(await runEmergencyLogin([], { db: world.db, dir, log: () => {} })).toBe(1);
      expect(readdirSync(dir)).toHaveLength(0);
    });

    it("creates the first admin, with no password, on an instance nobody has set up", async () => {
      await world.db.delete(mcpToken);
      await world.db.delete(user);

      const made = await createEmergencyLogin(world.db, "Owner@Example.test", { dir, now: at(0) });
      if (!made.ok) throw new Error(made.error);

      const [owner] = await world.db.select().from(user);
      expect(owner?.email).toBe("owner@example.test");
      expect(owner?.role).toBe("admin");
      expect(owner?.passwordHash).toBeNull();
      expect(await redeemEmergencyLogin(world.db, tokenIn(made.file), at(1000))).toEqual({
        userId: owner!.id,
        sessionVersion: owner!.sessionVersion,
      });
    });
  });

  describe("the link", () => {
    async function link(now = at(0)): Promise<string> {
      const made = await createEmergencyLogin(world.db, ADMIN, { dir, now });
      if (!made.ok) throw new Error(made.error);
      return tokenIn(made.file);
    }

    it("signs the admin in once, and never again", async () => {
      const token = await link();

      expect(await redeemEmergencyLogin(world.db, token, at(1000))).toEqual({
        userId: world.adminUserId,
        sessionVersion: 1,
      });
      expect(await redeemEmergencyLogin(world.db, token, at(2000))).toBeNull();
    });

    it("is dead after ten minutes", async () => {
      const token = await link();
      expect(await redeemEmergencyLogin(world.db, token, at(EMERGENCY_LOGIN_TTL_MS + 1))).toBeNull();
    });

    it("refuses a made-up token", async () => {
      await link();
      expect(await redeemEmergencyLogin(world.db, "not-the-token", at(1000))).toBeNull();
      expect(await redeemEmergencyLogin(world.db, "", at(1000))).toBeNull();
    });

    it("refuses an admin switched off after the link was made", async () => {
      const token = await link();
      await world.db.update(user).set({ active: false }).where(eq(user.id, world.adminUserId));

      expect(await redeemEmergencyLogin(world.db, token, at(1000))).toBeNull();
    });

    it("keeps only the newest link of an admin alive", async () => {
      const first = await link(at(0));
      const second = await link(at(1000));

      expect(await redeemEmergencyLogin(world.db, first, at(2000))).toBeNull();
      expect(await redeemEmergencyLogin(world.db, second, at(2000))).not.toBeNull();
    });

    it("is swept once used or expired", async () => {
      const token = await link(at(0));
      await redeemEmergencyLogin(world.db, token, at(1000));
      await sweepLoginRows(world.db, at(2000));
      expect(await world.db.select().from(emergencyLogin)).toHaveLength(0);
    });

    it("ignores the lock on code sign-in", async () => {
      for (let round = 0; round < MAX_CODE_USER_FAILURES / 5; round++) {
        const issued = await issueLoginCode(world.db, ADMIN, at(round * 2 * 60_000));
        const wrong = issued!.code === "000000" ? "111111" : "000000";
        for (let i = 0; i < 5; i++) {
          await redeemLoginCode(world.db, ADMIN, wrong, at(round * 2 * 60_000 + 1000));
        }
      }
      const locked = await issueLoginCode(world.db, ADMIN, at(5 * 60_000));
      expect(await redeemLoginCode(world.db, ADMIN, locked!.code, at(5 * 60_000 + 1000))).toBeNull();

      const token = await link(at(6 * 60_000));
      expect(await redeemEmergencyLogin(world.db, token, at(6 * 60_000 + 1000))).toEqual({
        userId: world.adminUserId,
        sessionVersion: 1,
      });
    });
  });
});
