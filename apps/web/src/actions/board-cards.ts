"use server";

import { and, eq } from "drizzle-orm";
import { project, workspace } from "@agent-board/db";
import type { BoardCard, BoardCardDetail } from "../app/home/board";
import { toBoardCardDetail, toBoardCards } from "../lib/board-card";
import { loadBoardSignature } from "../lib/board-signature";
import { loadGlobalCounts, type GlobalCounts } from "../lib/global-counts";
import { boardSignatureLimiter } from "../lib/board-signature-guard";
import {
  boardSearchLimiter,
  normalizeBoardSearch,
  type BoardSearchRefusal,
} from "../lib/board-search-guard";
import {
  loadBoardTaskDetail,
  loadBoardTasksByIds,
  searchBoardTaskIds,
} from "../lib/board-tasks";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { dict } from "../lib/i18n";
import { loadUsageRecipes } from "../lib/recipes";
import { projectScope, type Principal } from "../lib/scope";
import { sessionPrincipal } from "../lib/web-scope";

/**
 * The cards the board's window leaves out, fetched on demand: the hits of a
 * search, whatever the period. It reads through the same scope as the page
 * itself, so a member gets their own cards here and nothing else.
 */

type BoardReader = {
  principal: Principal;
  session: { userId: string };
  ws: typeof workspace.$inferSelect;
  projects: { id: string }[];
};

async function boardReader(
  known?: NonNullable<Awaited<ReturnType<typeof getSession>>>,
): Promise<BoardReader | null> {
  const session = known ?? (await getSession());
  if (!session) return null;
  const principal = await sessionPrincipal(session);
  if (!principal) return null;
  const ws = await db().query.workspace.findFirst();
  if (!ws) return null;
  const projects = await db()
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, ws.id), projectScope(principal)));
  return { principal, session, ws, projects };
}

function asCards(
  reader: BoardReader,
  rows: Parameters<typeof toBoardCards>[0],
): BoardCard[] {
  if (rows.length === 0) return [];
  return toBoardCards(rows, {
    tr: dict(reader.ws.language),
    pricingEnabled: reader.ws.pricingEnabled,
    viewerId: reader.session.userId,
    claimTimeoutMinutes: reader.ws.claimTimeoutMinutes,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the detail panel adds to a card, read when the card is opened: the
 * board's list carries only each card's line. Same scope as the board: a
 * member gets their own cards, and any other id, theirs or nobody's, reads
 * as "Card not found.", the same answer as no session at all.
 */
export async function loadBoardCardDetailAction(
  id: string,
): Promise<{ ok: true; detail: BoardCardDetail } | { ok: false; error: string }> {
  const notFound = { ok: false as const, error: "Card not found." };
  if (typeof id !== "string" || !UUID.test(id)) return notFound;
  const reader = await boardReader();
  if (!reader) return notFound;
  const row = await loadBoardTaskDetail(
    db(),
    reader.projects.map((item) => item.id),
    reader.principal,
    id,
  );
  if (!row) return notFound;
  return {
    ok: true,
    detail: toBoardCardDetail(
      row,
      dict(reader.ws.language),
      reader.ws.pricingEnabled,
      await loadUsageRecipes(db(), reader.ws.id),
    ),
  };
}

/**
 * The board search on the server: what task_search finds for the reader,
 * as board cards, so a card the window left out still answers its words.
 */
export async function searchBoardCardsAction(
  query: string,
): Promise<{
  query: string;
  cards: BoardCard[];
  /** The server turned the search away: "busy" is worth asking again, "rate" is not. */
  limited?: BoardSearchRefusal;
}> {
  const wanted = normalizeBoardSearch(query);
  const reader = await boardReader();
  if (!reader || !wanted) return { query, cards: [] };
  // Two searches at a time and a few a minute per person. A refusal says so
  // instead of answering "found nothing", which the UI would take for a result.
  const slot = boardSearchLimiter.acquire(reader.session.userId);
  if (!slot.ok) return { query, cards: [], limited: slot.reason };
  try {
    const ids = await searchBoardTaskIds(db(), reader.ws.id, reader.principal, wanted);
    const rows = await loadBoardTasksByIds(
      db(),
      reader.projects.map((item) => item.id),
      reader.principal,
      ids,
    );
    return { query, cards: asCards(reader, rows) };
  } finally {
    slot.release();
  }
}

/**
 * The board's fingerprint for the signed-in reader, which the page compares
 * with the one it was built with before it asks for a whole new render. Null
 * when there is no session, so the poll falls back to a refresh and lands on
 * the login. One poll at a time and a dozen a minute per person (the page
 * asks three): past that the answer is `{ limited: true }`, which the page
 * takes as "ask again later", never as a reason to rebuild itself.
 *
 * The answer also carries the global bar's two numbers (navigation plan E1),
 * counted by scope and role, so the bar's chips move with the board's poll
 * instead of polling a second time.
 */
export async function boardSignatureAction(): Promise<
  { signature: string; counts: GlobalCounts } | { limited: true } | null
> {
  const session = await getSession();
  if (!session) return null;
  // Before the scope reads: a refused poll should cost the session lookup
  // and nothing else.
  const slot = boardSignatureLimiter.acquire(session.userId);
  if (!slot.ok) return { limited: true };
  try {
    const reader = await boardReader(session);
    if (!reader) return null;
    const [signature, counts] = await Promise.all([
      loadBoardSignature(
        db(),
        reader.ws.id,
        reader.projects.map((item) => item.id),
        reader.principal,
      ),
      loadGlobalCounts(db(), reader.ws.id, reader.principal),
    ]);
    return { signature, counts };
  } finally {
    slot.release();
  }
}
