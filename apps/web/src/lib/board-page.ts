import type { Database } from "@agent-board/db";
import type { BoardCard } from "../app/board/board";
import { toBoardCards, type BoardCardContext } from "./board-card";
import { COLUMN_STATUSES, type ColumnStatus } from "./board-columns";
import type { BoardFilter } from "./board-filter";
import { boardQueryFromFilter, boardQueryKey, boardScopeProjectIds } from "./board-query";
import {
  boardWindowStart,
  loadBoardColumnPage,
  loadBoardColumns,
  loadBoardCounts,
  type BoardCounts,
  type BoardCursor,
} from "./board-tasks";
import type { MaybePrincipal } from "./scope";

/** One column as the browser holds it: the cards so far and where the next page starts. */
export type BoardColumnData = { cards: BoardCard[]; next: string | null };

/**
 * What the board's columns are made of (OCL board lazy): each column's
 * newest page, the exact counts, and the key of the query they answer, so a
 * refresh can tell whether the columns it brings are the ones on screen.
 */
export type BoardColumnsData = {
  key: string;
  /** Where the period starts, by the date it reads; null for all time. */
  since: string | null;
  columns: Record<ColumnStatus, BoardColumnData>;
  counts: BoardCounts;
};

export type BoardPageReader = {
  /** The projects the reader sees, with their organization. */
  projects: readonly { id: string; organizationId: string }[];
  /** The missions the reader sees. */
  missionIds: ReadonlySet<string>;
  principal: MaybePrincipal;
  personUserId: string | null;
  cards: BoardCardContext;
};

function query(reader: BoardPageReader, filter: Partial<BoardFilter> | null, now: Date) {
  const projectIds = boardScopeProjectIds(reader.projects, {
    organizationIds: filter?.organizationIds ?? [],
    projectIds: filter?.projectIds ?? [],
  });
  const boardQuery = boardQueryFromFilter(filter, reader.missionIds, reader.personUserId, now);
  return { projectIds, boardQuery, key: boardQueryKey(projectIds, boardQuery) };
}

/**
 * Every column's newest page and the counts, for a filter. `depth` re-reads a
 * column as deep as the board already holds it (the poll, a write).
 */
export async function loadBoardColumnsData(
  database: Database,
  reader: BoardPageReader,
  filter: Partial<BoardFilter> | null,
  options: { now?: Date; depth?: Partial<Record<ColumnStatus, number>> } = {},
): Promise<BoardColumnsData> {
  const now = options.now ?? new Date();
  const { projectIds, boardQuery, key } = query(reader, filter, now);
  const [columns, counts] = await Promise.all([
    loadBoardColumns(database, projectIds, reader.principal, boardQuery, options.depth),
    loadBoardCounts(database, projectIds, reader.principal, boardQuery),
  ]);
  return {
    key,
    since: boardWindowStart(now, boardQuery.period)?.toISOString() ?? null,
    columns: Object.fromEntries(
      COLUMN_STATUSES.map((status) => [
        status,
        { cards: toBoardCards(columns[status].rows, reader.cards), next: columns[status].next },
      ]),
    ) as Record<ColumnStatus, BoardColumnData>,
    counts,
  };
}

/** The next page of one column, after the cursor the last one ended on. */
export async function loadBoardColumnPageData(
  database: Database,
  reader: BoardPageReader,
  filter: Partial<BoardFilter> | null,
  status: ColumnStatus,
  after: BoardCursor,
  now: Date = new Date(),
): Promise<BoardColumnData & { key: string }> {
  const { projectIds, boardQuery, key } = query(reader, filter, now);
  const page = await loadBoardColumnPage(
    database,
    projectIds,
    reader.principal,
    boardQuery,
    status,
    after,
  );
  return { key, cards: toBoardCards(page.rows, reader.cards), next: page.next };
}
