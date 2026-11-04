"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { publishGlobalCounts } from "../../components/global-bar/counts-channel";
import {
  setBoardSearch,
  subscribeBoardSearch,
} from "../../components/global-bar/search-channel";
import {
  boardTotalsAction,
  setBoardPeriodAction,
} from "../../actions/board-filter";
import {
  boardSignatureAction,
  loadBoardColumnPageAction,
  loadBoardColumnsAction,
  searchBoardCardsAction,
} from "../../actions/board-cards";
import {
  BOARD_COLUMN_PAGE,
  COLUMN_STATUSES,
  type ColumnStatus,
} from "../../lib/board-columns";
import type { BoardColumnsData } from "../../lib/board-page";
import {
  NO_MISSION,
  TASK_PRIORITIES,
  TASK_TYPES,
  activeFilterCount,
  boardPeriodToRemember,
  clearBoardFilter,
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  filterBoardCards,
  missionOptionsFromCounts,
  releaseOptionsFromCounts,
  removeFilterChip,
  resetBoardPeriod,
  type BoardFilter,
} from "../../lib/board-filter";
import { boardAddressQuery } from "../../lib/board-url";
import { subscribeToBoardRefresh } from "../../lib/board-refresh";
import { createBoardSearchRunner } from "../../lib/board-search-runner";
import {
  addExtraCards,
  appendColumnPage,
  columnsAfterRefresh,
  mergeBoardCards,
  newestFirst,
  searchWithServerHits,
} from "../../lib/board-window";
import type { BoardTotals } from "../../lib/board-totals";
import { dict } from "../../lib/i18n";
import { Icon } from "../../components/icon";
import {
  SelectionBar,
  SelectionNoticeLine,
  SelectToggle,
  type SelectionNotice,
} from "../../components/board/selection-bar";
import { Board, type BoardCard, type BoardColumnsView, type BoardMissionOption } from "./board";
import { BoardTotal } from "./board-total";
import { FacetMenu, MoreFilters } from "./facet-filters";
import { FilterChips } from "./filter-chips";
import { PeriodFilter } from "./period-filter";
import { MissionFilter } from "./mission-filter";
import { ReleaseHeader } from "./release-header";

export type BoardProjectOption = {
  id: string;
  name: string;
  /** Which business it belongs to, so the project list follows that filter. */
  organizationId: string;
  hasContext: boolean;
  contextStatus: string | null;
};

export type BoardOrganizationOption = {
  id: string;
  name: string;
  hasContext: boolean;
};
export type { BoardMissionOption };

export function HomeShell({
  lang,
  missions,
  releases,
  initialColumns,
  linkedCard = null,
  initialFilter,
  initialTotals,
  openedByAddress = false,
  boardSignature,
  viewerRole,
  initialQuery = "",
}: {
  lang: string;
  missions: BoardMissionOption[];
  releases: { value: string }[];
  /** Each column's newest page and the exact counts, read on the server (OCL board lazy). */
  initialColumns: BoardColumnsData;
  /** The card a link asked to open, whether or not a page holds it. */
  linkedCard?: BoardCard | null;
  initialFilter: BoardFilter;
  /** What the initial filter consumed, already aggregated on the server. */
  initialTotals: BoardTotals;
  /** The page is the open card's own address (/cards/OCL-12, E3). */
  openedByAddress?: boolean;
  /** The board's fingerprint when the page was built; the poll compares against it. */
  boardSignature: string;
  /** Who is looking: Validate and the amber are the admin's (navigation plan E1). */
  viewerRole: "admin" | "member";
  /** The search words the address carried (`/board?q=`, E4). */
  initialQuery?: string;
}) {
  const router = useRouter();
  const t = dict(lang);
  const [filter, setFilter] = useState<BoardFilter>(initialFilter);
  const [totals, setTotals] = useState<BoardTotals>(initialTotals);
  // Selecionar (navigation plan E6): an explicit mode, on from the button on
  // the filter line, and what the bar left behind once it acted.
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<SelectionNotice | null>(null);
  // The words are typed in the global bar (E4); they reach the board through
  // the search channel, and the address's ?q= seeds both ends.
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialQuery);
  useEffect(() => {
    setBoardSearch(initialQuery);
    const stop = subscribeBoardSearch(setSearchQuery);
    return () => {
      stop();
      setBoardSearch("");
    };
    // The seed is read once: afterwards the bar owns the words.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Phone only: the filters leave the compact bar for the panel behind this
  // one button. On the desktop the panel never opens because the button is
  // hidden and the wrapper is transparent to the bar.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The columns as the reader holds them (OCL board lazy): the pages read so
  // far and where each column's next one starts. The server's are the first
  // pages; scrolling a column to its end adds the next, and a refresh re-reads
  // them as deep as they go, so the poll never takes away what was scrolled.
  const [columns, setColumns] = useState<BoardColumnsData>(initialColumns);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const [loadingMore, setLoadingMore] = useState<Partial<Record<ColumnStatus, boolean>>>({});
  const loadingMoreRef = useRef<Partial<Record<ColumnStatus, boolean>>>({});
  // The newest whole-columns read; an older one landing late is dropped.
  const columnsRequest = useRef(0);
  const loadedCards = useMemo(
    () => COLUMN_STATUSES.flatMap((status) => columns.columns[status].cards),
    [columns],
  );
  // What the search or a link pulled in from outside the pages. A refresh
  // re-reads the pages and leaves these alone (OCL board window).
  const [extraCards, setExtraCards] = useState<BoardCard[]>(() =>
    linkedCard ? [linkedCard] : [],
  );
  const cards = useMemo(
    () => mergeBoardCards(loadedCards, extraCards),
    [loadedCards, extraCards],
  );
  const period = filter.period ?? DEFAULT_BOARD_PERIOD;
  const periodBy = filter.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD;
  const [serverHits, setServerHits] = useState<{
    query: string;
    ids: Set<string>;
  }>({ query: "", ids: new Set() });
  const [searching, setSearching] = useState(false);
  // The server turned the search away for good; the board shows only what it has.
  const [searchLimited, setSearchLimited] = useState(false);
  const searchRunner = useRef<ReturnType<typeof createBoardSearchRunner<BoardCard>>>(null);
  if (!searchRunner.current) {
    searchRunner.current = createBoardSearchRunner<BoardCard>({
      // The page's query carries the person filter, which narrows the hits too.
      search: (query) => searchBoardCardsAction(query, window.location.search),
    });
  }
  const searchActive = debouncedSearchQuery.trim().length > 0;
  // The columns are the server's pages, already through the period, the scope
  // and the filters; the filter runs here too so a new choice narrows at once
  // while its pages are on their way. The search is the one way past the
  // pages: while words are typed every card held can answer them, and the
  // server search brings the ones no page holds.
  const inFilter = useMemo(
    () =>
      searchActive
        ? newestFirst(filterBoardCards(cards, filter), periodBy)
        : filterBoardCards(loadedCards, filter),
    [cards, loadedCards, filter, searchActive, periodBy],
  );
  const visible = useMemo(
    () =>
      searchWithServerHits(
        inFilter,
        debouncedSearchQuery,
        serverHits.query === debouncedSearchQuery ? serverHits.ids : new Set<string>(),
      ),
    [inFilter, debouncedSearchQuery, serverHits],
  );
  // Only the first render opens it: the link is an arrival, not a pin.
  const [openCard] = useState(() => linkedCard);
  // What the mission and release menus offer, counted in SQL with the columns
  // (each without its own filter), since the pages on hand are not the board.
  const missionOptions = useMemo(
    () => missionOptionsFromCounts(missions, columns.counts.missions, filter.missionId),
    [missions, columns.counts.missions, filter.missionId],
  );
  const looseCount = columns.counts.loose;
  const scopeCount = columns.counts.scope;
  const releaseOptions = useMemo(
    () => releaseOptionsFromCounts(releases, columns.counts.releases),
    [releases, columns.counts.releases],
  );
  // The prefix earns its place on the card only when more than one project is
  // on screen. Under a single project it would repeat itself 44 times.
  const mixedProjects = useMemo(
    () => new Set(visible.map((card) => card.projectId)).size > 1,
    [visible],
  );
  const selectedMission =
    filter.missionId && filter.missionId !== NO_MISSION
      ? missions.find((item) => item.id === filter.missionId) ?? null
      : null;
  const typeNames = {
    bug: t.board.typeBug,
    feature: t.board.typeFeature,
    rfc: t.board.typeRfc,
  };
  const priorityNames = {
    urgente: t.board.priorityUrgent,
    alta: t.board.priorityHigh,
    media: t.board.priorityMedium,
    baixa: t.board.priorityLow,
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // The address is the board's state (E4): what is on screen is what a link
  // copied from it shows. Replaced, not pushed: Back leaves the board, it does
  // not undo a filter. Only on /board itself: a card's own address
  // (/cards/OCL-12) is the card's, and the board's query comes back with Back.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  function writeAddress(next: BoardFilter, words: string) {
    if (window.location.pathname !== "/board") return;
    const query = boardAddressQuery(next, words, window.location.search);
    window.history.replaceState(null, "", query ? `/board?${query}` : "/board");
  }
  const wroteWords = useRef(initialQuery);
  useEffect(() => {
    if (debouncedSearchQuery === wroteWords.current) return;
    wroteWords.current = debouncedSearchQuery;
    writeAddress(filterRef.current, debouncedSearchQuery);
  }, [debouncedSearchQuery]);

  // MCP writes happen outside this React tree. Refreshing the dynamic route
  // pulls projects, cards and their latest attempts together, so every part
  // of the board observes one consistent snapshot without a manual reload.
  // The refresh runs inside a transition so the shell knows when it is still
  // on its way back, and the poll does not start another behind it.
  const [refreshing, startRefresh] = useTransition();
  const refreshingRef = useRef(false);
  refreshingRef.current = refreshing;
  // The poll asks a few small queries whether anything moved, and only
  // rebuilds the page when this fingerprint (the one the page arrived with)
  // is no longer the server's.
  const signatureRef = useRef(boardSignature);
  signatureRef.current = boardSignature;
  useEffect(
    () =>
      subscribeToBoardRefresh({
        refresh: () => startRefresh(() => router.refresh()),
        isBusy: () => refreshingRef.current,
        // The answer carries the global bar's two numbers too: hand them
        // over and give the poll the fingerprint it compares.
        signature: async () => {
          // The page's query rides along: the bar's numbers follow the
          // scope the address carries (E4 review, item 1).
          const answer = await boardSignatureAction(window.location.search);
          if (answer && "signature" in answer) {
            publishGlobalCounts(answer.counts);
            return answer.signature;
          }
          return answer;
        },
        held: () => signatureRef.current,
      }),
    [router],
  );

  // Every column again, for a filter: its newest page, or as deep as `depth`
  // says. Only the newest read lands; one a later choice overtook is dropped.
  const reloadColumns = useCallback(
    (next: BoardFilter, depth?: Partial<Record<ColumnStatus, number>>) => {
      const request = ++columnsRequest.current;
      return loadBoardColumnsAction(next, window.location.search, depth)
        .then((data) => {
          if (data && request === columnsRequest.current) setColumns(data);
        })
        .catch(() => null);
    },
    [],
  );

  // A column scrolled to its end asks for its next page, once per cursor:
  // the page lands only on the columns it was asked from, and a card already
  // held (it moved columns since) is not drawn twice.
  const loadMore = useCallback((status: ColumnStatus) => {
    const cursor = columnsRef.current.columns[status].next;
    if (!cursor || loadingMoreRef.current[status]) return;
    loadingMoreRef.current = { ...loadingMoreRef.current, [status]: true };
    setLoadingMore(loadingMoreRef.current);
    void loadBoardColumnPageAction(filterRef.current, window.location.search, status, cursor)
      .then((page) => {
        if (page) setColumns((data) => appendColumnPage(data, status, cursor, page));
      })
      .catch(() => null)
      .finally(() => {
        loadingMoreRef.current = { ...loadingMoreRef.current, [status]: false };
        setLoadingMore(loadingMoreRef.current);
      });
  }, []);

  // A refresh (the poll, a write from the panel or the selection bar) brings
  // the server's first pages. They replace the columns when they answer the
  // same filter and the reader has not scrolled past them; otherwise the
  // columns are re-read under the filter on screen, as deep as they were, so
  // neither the pages scrolled in nor the place on screen are lost.
  const adoptedColumns = useRef(initialColumns);
  useEffect(() => {
    if (initialColumns === adoptedColumns.current) return;
    adoptedColumns.current = initialColumns;
    const next = columnsAfterRefresh(columnsRef.current, initialColumns, BOARD_COLUMN_PAGE);
    if (next.adopt) {
      // Whatever whole-columns read was on its way is older than this.
      columnsRequest.current += 1;
      setColumns(initialColumns);
      return;
    }
    void reloadColumns(filterRef.current, next.depth);
  }, [initialColumns, reloadColumns]);

  // The search also asks the server, so a card the window left out still
  // answers its words. Whatever it finds is held for as long as the words are.
  useEffect(() => {
    const query = debouncedSearchQuery.trim();
    if (query.length < 2) {
      setSearching(false);
      setSearchLimited(false);
      return;
    }
    setSearching(true);
    setSearchLimited(false);
    // A refusal from the server is not an answer: the runner asks again for
    // the latest query and tells us only when it has hits or has given up.
    return searchRunner.current?.start(query, {
      onResult: (_query, found) => {
        setExtraCards((current) => addExtraCards(current, found));
        setServerHits({
          query: debouncedSearchQuery,
          ids: new Set(found.map((card) => card.id)),
        });
      },
      onState: (state) => {
        setSearching(state === "searching");
        setSearchLimited(state === "limited");
      },
    });
  }, [debouncedSearchQuery]);

  // What the columns draw past their cards: the exact counts, and where a
  // column still has a page to bring when it is scrolled to its end.
  const columnsView = useMemo<BoardColumnsView>(
    () => ({
      counts: columns.counts.columns,
      next: Object.fromEntries(
        COLUMN_STATUSES.map((status) => [status, columns.columns[status].next]),
      ) as Record<ColumnStatus, string | null>,
      loading: loadingMore,
      onNearEnd: loadMore,
    }),
    [columns, loadingMore, loadMore],
  );
  const boardShown = COLUMN_STATUSES.reduce(
    (sum, status) => sum + columns.counts.columns[status],
    0,
  );
  function apply(next: BoardFilter) {
    // Only the scope and the period are remembered (F2), and the scope is the
    // global bar's to write: this line remembers the period when it changes,
    // nothing else (E4 review, item 5). The rest lives in the address.
    const remember = boardPeriodToRemember(filter, next);
    if (remember) void setBoardPeriodAction(remember);
    setFilter(next);
    writeAddress(next, searchQuery);
    // A new period, or a new date for it, is a new window: what the search
    // pulled in past the old one goes with it.
    if (
      (next.period ?? DEFAULT_BOARD_PERIOD) !== period ||
      (next.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD) !== periodBy
    ) {
      setExtraCards([]);
    }
    // The columns are the server's (OCL board lazy): a new filter asks for
    // their first pages and exact counts, and narrows the pages held at once
    // while they come. The total is aggregated where Insights aggregates it.
    void reloadColumns(next);
    void boardTotalsAction(next).then(setTotals);
  }

  function toggleSelect(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  const stopPicking = useCallback(() => {
    setPicking(false);
    setSelected([]);
  }, []);

  // A card that left the board (moved out of the filter, discarded by an
  // agent) leaves the selection too: the bar counts only what is on screen.
  useEffect(() => {
    if (selected.length === 0) return;
    const onScreen = new Set(visible.map((card) => card.id));
    if (selected.some((id) => !onScreen.has(id))) {
      setSelected((current) => current.filter((id) => onScreen.has(id)));
    }
  }, [visible, selected]);
  const shortIds = useMemo(
    () => new Map(cards.map((card) => [card.id, card.shortId])),
    [cards],
  );

  function clearSearch() {
    setBoardSearch("");
    setSearchQuery("");
    setDebouncedSearchQuery("");
  }

  // Clear keeps the scope and the period (E4): they are where the reader is,
  // not a narrowing. Back to 7 days is its own button.
  function clearBoardFilters() {
    clearSearch();
    apply(clearBoardFilter(filter));
  }

  return (
    <>
      {/* Navigation plan E1 moved identity, places, work state and the
          account up to the global bar, and E4 the scope and the search. What
          stays here is the filter line, ONE line on the desktop with what does
          not fit stepping aside in order (board-filters.css): Missão · Tipo ·
          Prioridade · Mostrar: … · Mais, the cost at its far end, and the
          chips of what narrows the board under it. On the phone the filters
          live behind the Filtros button. */}
      <header className="topbar-wrap">
        <div className="topbar topbar-l1">
          <div className="spacer" />
          {/* The figure that justifies the board stays readable at a glance;
              the reading of it moved into the popover it opens. */}
          <BoardTotal totals={totals} filter={filter} t={t} />
        </div>
        <div className="topbar-l2">
          {/* On the desktop the wrapper is transparent to the level and the
              phone-only filters button stays hidden. On the phone the level
              collapses behind the Filtros button and the wrapper becomes the
              panel that holds it: same controls, same order (AGB-65). */}
          <div className={`topbar-more${filtersOpen ? " open" : ""}`}>
            <MissionFilter
              options={missionOptions}
              organizationId={
                filter.organizationIds.length === 1
                  ? filter.organizationIds[0]
                  : null
              }
              missions={missions}
              looseCount={looseCount}
              totalCount={scopeCount}
              value={filter.missionId}
              onChange={(missionId) => apply({ ...filter, missionId })}
              onCreated={(missionId) => apply({ ...filter, missionId })}
              t={t}
            />
            {/* The mission filter stays a quick filter; the mission itself
                is a place now (E3), one step away. */}
            {selectedMission ? (
              <a className="mission-open-link" href={`/missions/${selectedMission.id}`}>
                {t.missions.openPage}
                <Icon name="chevronRight" label={null} size={12} />
              </a>
            ) : null}
            <FacetMenu
              kind="type"
              label={t.board.typeFilter}
              choices={TASK_TYPES}
              names={typeNames}
              value={filter.types}
              onChange={(types) => apply({ ...filter, types })}
            />
            <FacetMenu
              kind="priority"
              label={t.board.priorityFilter}
              choices={TASK_PRIORITIES}
              names={priorityNames}
              value={filter.priorities}
              onChange={(priorities) => apply({ ...filter, priorities })}
            />
            <PeriodFilter
              value={period}
              by={periodBy}
              onChange={(next) => apply({ ...filter, period: next })}
              onByChange={(next) => apply({ ...filter, periodBy: next })}
              t={t}
            />
            <MoreFilters
              releases={releaseOptions}
              resolvedIn={filter.resolvedIn}
              onReleaseChange={(resolvedIn) => apply({ ...filter, resolvedIn })}
              t={t}
            />
          </div>
          {/* Always on the line, outside the phone's Filtros sheet: the mode
              is one tap away at every width (E6). */}
          <SelectToggle
            on={picking}
            onToggle={() => {
              setFiltersOpen(false);
              setNotice(null);
              if (picking) stopPicking();
              else setPicking(true);
            }}
            t={t}
          />
          <button
            className="filters-btn"
            type="button"
            aria-expanded={filtersOpen}
            aria-label={t.board.filters}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Icon name="filter" label={null} size={14} />
            <span>{t.board.filters}</span>
            {/* How many filters are on, a period out of the default
                included (F2), not how many cards are left. Nothing when none. */}
            {activeFilterCount(filter) > 0 ? (
              <span className="badge">{activeFilterCount(filter)}</span>
            ) : null}
          </button>
        </div>
      </header>
      <FilterChips
        filter={filter}
        missions={missions}
        query={searchQuery}
        shown={searchActive ? visible.length : boardShown}
        searching={searching}
        searchLimited={searchLimited}
        onRemove={(key) => apply(removeFilterChip(filter, key))}
        onClearSearch={clearSearch}
        onClear={clearBoardFilters}
        onResetPeriod={() => apply(resetBoardPeriod(filter))}
        t={t}
      />
      {/* Tap-away target for the phone filters panel; rendered only while it
          is open, which the desktop never does. */}
      {filtersOpen ? (
        <div className="menu-backdrop" onClick={() => setFiltersOpen(false)} />
      ) : null}

      {filter.resolvedIn !== undefined ? (
        <ReleaseHeader
          release={filter.resolvedIn}
          cards={visible}
          counts={searchActive ? undefined : columns.counts.columns}
          missions={missions}
          totals={totals}
          filter={filter}
          onMissionSelect={(missionId) => apply({ ...filter, missionId })}
          t={t}
        />
      ) : null}

      <Board
        cards={visible}
        lang={lang}
        missions={missions}
        showProject={mixedProjects}
        selectable={picking}
        selectedIds={selected}
        onToggleSelect={toggleSelect}
        initialOpen={openCard}
        cardAddresses
        openedByAddress={openedByAddress}
        detailVersion={boardSignature}
        viewerRole={viewerRole}
        columns={searchActive ? undefined : columnsView}
      />

      {picking ? (
        <SelectionBar
          selected={selected}
          shortIds={shortIds}
          missions={missions}
          organizationId={
            filter.organizationIds.length === 1 ? filter.organizationIds[0]! : null
          }
          viewerRole={viewerRole}
          onMoved={(next) => {
            stopPicking();
            setNotice(next);
          }}
          onDiscarded={(next) => {
            stopPicking();
            setNotice(next);
          }}
          onCancel={stopPicking}
          t={t}
        />
      ) : notice ? (
        <SelectionNoticeLine notice={notice} onChange={setNotice} t={t} />
      ) : null}
    </>
  );
}
