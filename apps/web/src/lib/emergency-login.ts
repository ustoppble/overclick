import { emergencyLogin, user } from "@agent-board/db";
import { hashEmergencyToken } from "@agent-board/db/emergency-login";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";

/**
 * Spends the emergency link carrying `token` and returns the admin it signs
 * in, or null for anything else: no such link, used, expired, or an account
 * that is no longer an active admin. Consuming is conditional on the link
 * still being unused, so two tabs opening it at once get one session. The
 * lock on code sign-in is not consulted: getting past it is what the link is
 * for. Links are made by `pnpm emergency-login` (packages/db).
 */
export async function redeemEmergencyLogin(
  db: McpDatabase,
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string; sessionVersion: number } | null> {
  if (!token) return null;
  const [spent] = await db
    .update(emergencyLogin)
    .set({ consumedAt: now })
    .where(
      and(
        eq(emergencyLogin.tokenHash, hashEmergencyToken(token)),
        isNull(emergencyLogin.consumedAt),
        gt(emergencyLogin.expiresAt, now),
      ),
    )
    .returning({ userId: emergencyLogin.userId });
  if (!spent) return null;

  const [admin] = await db
    .select({ id: user.id, role: user.role, active: user.active, sessionVersion: user.sessionVersion })
    .from(user)
    .where(eq(user.id, spent.userId))
    .limit(1);
  if (!admin || admin.role !== "admin" || !admin.active) return null;
  return { userId: admin.id, sessionVersion: admin.sessionVersion };
}
