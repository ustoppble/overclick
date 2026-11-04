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
  searchBoardCardsAction,
} from "../../actions/board-cards";
import {
  NO_MISSION,
  TASK_PRIORITIES,
  TASK_TYPES,
  activeFilterCount,
  boardPeriodToRemember,
  clearBoardFilter,
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  countLooseCards,
  filterBoardCards,
  missionFilterOptions,
  releaseFilterOptions,
  removeFilterChip,
  resetBoardPeriod,
  type BoardFilter,
} from "../../lib/board-filter";
import { boardAddressQuery } from "../../lib/board-url";
import { subscribeToBoardRefresh } from "../../lib/board-refresh";
import { createBoardSearchRunner } from "../../lib/board-search-runner";
import {
  addExtraCards,
  cardsInPeriod,
  mergeBoardCards,
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
import { Board, type BoardCard, type BoardMissionOption } from "./board";
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
  cards: windowCards,
  initialFilter,
  initialTotals,
  openCardId,
  openedByAddress = false,
  windowSince,
  boardSignature,
  viewerRole,
  initialQuery = "",
}: {
  lang: string;
  missions: BoardMissionOption[];
  releases: { value: string }[];
  cards: BoardCard[];
  initialFilter: BoardFilter;
  /** What the initial filter consumed, already aggregated on the server. */
  initialTotals: BoardTotals;
  /** The card a link asked to open, already among the cards. */
  openCardId: string | null;
  /** The page is the open card's own address (/cards/OCL-12, E3). */
  openedByAddress?: boolean;
  /** Where the window starts, by the date the period reads; null for all time. */
  windowSince: string | null;
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
  // What the search pulled in past the window. The refresh replaces the
  // window and leaves these alone (OCL board window).
  const [extraCards, setExtraCards] = useState<BoardCard[]>([]);
  const cards = useMemo(
    () => mergeBoardCards(windowCards, extraCards),
    [windowCards, extraCards],
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
  // The period alone decides what every column holds; the search is the one
  // way past it, so while words are typed every card held can answer them.
  const inFilter = useMemo(
    () =>
      filterBoardCards(
        searchActive ? cards : cardsInPeriod(cards, windowSince, periodBy),
        filter,
      ),
    [cards, filter, searchActive, windowSince, periodBy],
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
  const [openCard] = useState(() =>
    openCardId ? (windowCards.find((card) => card.id === openCardId) ?? null) : null,
  );
  // What the mission filter may offer: the scope is the projects on screen, so
  // the options and their counts follow the selection, not the mission.
  const scope = useMemo(
    () => ({
      organizationIds: filter.organizationIds,
      projectIds: filter.projectIds,
      missionId: null,
      types: filter.types,
      priorities: filter.priorities,
      ...(filter.resolvedIn !== undefined
        ? { resolvedIn: filter.resolvedIn }
        : {}),
    }),
    [
      filter.organizationIds,
      filter.projectIds,
      filter.types,
      filter.priorities,
      filter.resolvedIn,
    ],
  );
  const missionOptions = useMemo(
    () => missionFilterOptions(cards, missions, filter),
    [cards, missions, filter],
  );
  const looseCount = useMemo(
    () => countLooseCards(cards, scope),
    [cards, scope],
  );
  const scopeCount = useMemo(
    () => filterBoardCards(cards, scope).length,
    [cards, scope],
  );
  const releaseOptions = useMemo(
    () => releaseFilterOptions(cards, releases, filter),
    [cards, releases, filter],
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

  function apply(next: BoardFilter) {
    // Only the scope and the period are remembered (F2), and the scope is the
    // global bar's to write: this line remembers the period when it changes,
    // nothing else (E4 review, item 5). The rest lives in the address.
    const remember = boardPeriodToRemember(filter, next);
    const saved = remember ? setBoardPeriodAction(remember) : Promise.resolve(null);
    setFilter(next);
    writeAddress(next, searchQuery);
    if (
      (next.period ?? DEFAULT_BOARD_PERIOD) !== period ||
      (next.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD) !== periodBy
    ) {
      // A new period, or a new date for it, is a new window, and the window is
      // the server's: save the choice, then ask for the page again right away
      // (this is the reader's own action, not the poll). What the search
      // pulled in past the old window goes with it.
      setExtraCards([]);
      void saved.then(() => startRefresh(() => router.refresh()));
      return;
    }
    // The total is aggregated where Insights aggregates it, so a new filter
    // asks the server for its numbers instead of adding cards up here.
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
        shown={visible.length}
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
