import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Database } from "./client";
import { createDb } from "./client";
import { isValidEmail } from "./domain/first-access";
import { requireDatabaseUrl } from "./env";
import { emergencyLogin, user } from "./schema";

/**
 * The server owner's way in when nobody can get in by email code: the board
 * has no RESEND_API_KEY/EMAIL_FROM, or the admin is locked out of code
 * sign-in. Run inside the container:
 *
 *   docker exec -it <app container> pnpm emergency-login owner@example.com
 *
 * It makes a link that signs that admin in once, within ten minutes, writes
 * it to a file only the container's user can read (mode 600), and prints the
 * file's path and nothing else: the link must never reach a terminal, a log
 * or a screen being shared. The database keeps only a hash of the token, the
 * link carries it after a `#`, so no proxy or access log ever sees it, and
 * the page posts it once. It ignores the lock on code sign-in.
 *
 * Only an active admin gets a link. On an instance nobody has set up yet,
 * which without mail has no other way to be set up, it creates the first
 * admin with that address (and no password) instead.
 */
export const EMERGENCY_LOGIN_TTL_MS = 10 * 60 * 1000;
export const EMERGENCY_LOGIN_PATH = "/login/emergency";

/** A random 256-bit token is no guess: a plain digest is enough, as with invitation links. */
export function hashEmergencyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

type Db = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export type CreateEmergencyLoginResult =
  | { ok: true; file: string }
  | { ok: false; error: string };

export async function createEmergencyLogin(
  db: Db,
  rawEmail: string,
  options: { dir?: string; now?: Date } = {},
): Promise<CreateEmergencyLoginResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!isValidEmail(email)) return { ok: false, error: "That is not an email address." };
  const now = options.now ?? new Date();
  const token = randomBytes(32).toString("base64url");

  const made = await db.transaction(async (tx) => {
    let [admin] = await tx
      .select({ id: user.id, role: user.role, active: user.active })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (!admin) {
      const [users] = await tx.select({ n: count() }).from(user);
      if (Number(users?.n ?? 0) > 0) return null;
      [admin] = await tx
        .insert(user)
        .values({ email, role: "admin" })
        .returning({ id: user.id, role: user.role, active: user.active });
    }
    if (!admin || admin.role !== "admin" || !admin.active) return null;

    // One live link per admin: making a new one kills the ones before it.
    await tx
      .delete(emergencyLogin)
      .where(and(eq(emergencyLogin.userId, admin.id), isNull(emergencyLogin.consumedAt)));
    await tx.insert(emergencyLogin).values({
      userId: admin.id,
      tokenHash: hashEmergencyToken(token),
      expiresAt: new Date(now.getTime() + EMERGENCY_LOGIN_TTL_MS),
      createdAt: now,
    });
    return admin;
  });
  if (!made) return { ok: false, error: "No active admin has that address." };

  const file = join(
    options.dir ?? process.env.OVERCLICK_EMERGENCY_DIR ?? tmpdir(),
    `overclick-emergency-login-${randomBytes(6).toString("hex")}.txt`,
  );
  // `wx`: never over a file that is already there; 600 set again in case a
  // umask or an existing ACL got in the way.
  writeFileSync(
    file,
    [
      "OverClick emergency sign-in. Open it in a browser, on this board's own",
      "address, within 10 minutes. It works once. Delete this file after.",
      "",
      `https://<this board's address>${EMERGENCY_LOGIN_PATH}#${token}`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  chmodSync(file, 0o600);
  return { ok: true, file };
}

/** The script's body: the address in, the file's path (only) out. Returns the exit code. */
export async function runEmergencyLogin(
  argv: string[],
  io: { db: Db; dir?: string; log?: (line: string) => void },
): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const email = argv.find((arg) => !arg.startsWith("-"));
  if (!email) {
    log("usage: pnpm emergency-login <admin email>");
    return 1;
  }
  const made = await createEmergencyLogin(io.db, email, { dir: io.dir });
  if (!made.ok) {
    log(`emergency-login: ${made.error}`);
    return 1;
  }
  log(`Emergency sign-in link written to ${made.file} (mode 600, valid 10 minutes, single use).`);
  return 0;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  const { db, sql } = createDb(requireDatabaseUrl());
  runEmergencyLogin(process.argv.slice(2), { db })
    .then(async (code) => {
      await sql.end();
      process.exit(code);
    })
    .catch(async (err) => {
      // The kind only: a driver message can quote the connection string.
      console.error(`emergency-login failed (${err instanceof Error ? err.name : "unknown"})`);
      await sql.end();
      process.exit(1);
    });
}
