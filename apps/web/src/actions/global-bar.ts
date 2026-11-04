"use server";

import { scopeOverrideFromSearch } from "../lib/board-filter";
import { db } from "../lib/db";
import { globalBarCountsLimiter } from "../lib/board-signature-guard";
import { getSession } from "../lib/cookies";
import { loadGlobalCounts, type GlobalCounts } from "../lib/global-counts";
import { sessionPrincipal } from "../lib/web-scope";

/**
 * The global bar's two numbers, for the pages that have no board poll of
 * their own (Usage, Settings, Organizations): they ask every 60 s. Null when
 * nobody is signed in, and the bar keeps what it had.
 *
 * `search` is the page's query: a scope in it wins over the remembered one
 * (E4 review h-ipv, item 1). Only the scope is read from it, through the
 * reader's own projects, so it can narrow the numbers and never widen them.
 */
export async function globalBarCountsAction(search?: string): Promise<GlobalCounts | null> {
  const session = await getSession();
  if (!session) return null;
  // Before the scope reads, as the board's signature does: a refused poll
  // costs the session lookup and nothing else, and the bar keeps its numbers.
  const slot = globalBarCountsLimiter.acquire(session.userId);
  if (!slot.ok) return null;
  try {
    const principal = await sessionPrincipal(session);
    if (!principal) return null;
    const ws = await db().query.workspace.findFirst({ columns: { id: true } });
    if (!ws) return null;
    const override = typeof search === "string" ? scopeOverrideFromSearch(search) : undefined;
    return await loadGlobalCounts(db(), ws.id, principal, undefined, override);
  } finally {
    slot.release();
  }
}
