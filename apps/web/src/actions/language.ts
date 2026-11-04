"use server";

import { workspace } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { ADMIN_ONLY, sessionCanManageWorkspace } from "../lib/web-scope";
import { db } from "../lib/db";
import { isLang } from "../lib/i18n";

/** Persists the workspace UI language. English default, pt-BR available. */
export async function saveLanguageAction(lang: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!(await sessionCanManageWorkspace(session))) return { ok: false, error: ADMIN_ONLY };
  if (!isLang(lang)) return { ok: false, error: "Unknown language." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  await db().update(workspace).set({ language: lang }).where(eq(workspace.id, ws.id));
  revalidatePath("/board");
  revalidatePath("/settings");
  revalidatePath("/onboarding");
  return { ok: true };
}
