"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { publishGlobalCounts } from "../../components/global-bar/counts-channel";
import {
  boardTotalsAction,
  setBoardFilterAction,
} from "../../actions/board-filter";
import {
  boardSignatureAction,
  searchBoardCardsAction,
} from "../../actions/board-cards";
import { assignCardsToMissionAction } from "../../actions/missions";
import {
  NO_MISSION,
  boardFilterToQuery,
  activeFilterCount,
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  countLooseCards,
  filterBoardCards,
  missionFilterOptions,
  organizationFilterOptions,
  projectFilterOptions,
  releaseFilterOptions,
  toggleOrganization,
  selectOnly,
  toggleProject,
  type BoardFilter,
} from "../../lib/board-filter";
import { subscribeToBoardRefresh } from "../../lib/board-refresh";
import { createBoardSearchRunner } from "../../lib/board-search-runner";
import {
  addExtraCards,
  cardsInPeriod,
  mergeBoardCards,
  searchWithServerHits,
} from "../../lib/board-window";
import type { BoardTotals } from "../../lib/board-totals";
import { dict, type Dict } from "../../lib/i18n";
import { Icon } from "../../components/icon";
import { Board, type BoardCard, type BoardMissionOption } from "./board";
import { BoardTotal } from "./board-total";
import { FacetFilters } from "./facet-filters";
import { PeriodByFilter, PeriodFilter } from "./period-filter";
import { MissionHeader } from "./mission-header";
import { MissionFilter } from "./mission-filter";
import { OrganizationFilter } from "./organization-filter";
import { ProjectFilter } from "./project-filter";
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

/**
 * The bulk move: pick cards on the board, send the whole selection into a
 * mission, or out of one. An instance that ran before missions existed has
 * every card loose, and fixing that one detail panel at a time is not a fix.
 */
function BulkMissionBar({
  selected,
  missions,
  onDone,
  onClear,
  t,
}: {
  selected: string[];
  missions: BoardMissionOption[];
  onDone: () => void;
  onClear: () => void;
  t: Dict;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [missionId, setMissionId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const assign = () =>
    start(async () => {
      setErr(null);
      const r = await assignCardsToMissionAction(selected, missionId || null);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      onDone();
      router.refresh();
    });

  return (
    <div className="bulk-bar nebula-glass">
      <span className="bulk-count">
        {selected.length === 0
          ? t.board.pickCardsHint
          : t.board.selectedCount(selected.length)}
      </span>
      <label className="filter-chip">
        <select
          aria-label={t.board.assignTo}
          value={missionId}
          disabled={pending}
          onChange={(event) => setMissionId(event.target.value)}
        >
          <option value="">{t.board.noMission}</option>
          {missions.map((miss) => (
            <option key={miss.id} value={miss.id}>
              {miss.title}
            </option>
          ))}
        </select>
      </label>
      {err ? <span className="bulk-err">{err}</span> : null}
      <button
        className="btn-ghost"
        type="button"
        disabled={pending}
        onClick={onClear}
      >
        {t.board.cancelSelection}
      </button>
      <button
        className="d-btn-pri"
        type="button"
        disabled={pending || selected.length === 0}
        onClick={assign}
      >
        {pending ? t.board.assigning : t.board.assign}
      </button>
    </div>
  );
}

export function HomeShell({
  lang,
  organizations,
  projects,
  missions,
  releases,
  cards: windowCards,
  initialFilter,
  initialTotals,
  openCardId,
  windowSince,
  boardSignature,
  viewerRole,
}: {
  lang: string;
  organizations: BoardOrganizationOption[];
  projects: BoardProjectOption[];
  missions: BoardMissionOption[];
  releases: { value: string }[];
  cards: BoardCard[];
  initialFilter: BoardFilter;
  /** What the initial filter consumed, already aggregated on the server. */
  initialTotals: BoardTotals;
  /** The card a link asked to open, already among the cards. */
  openCardId: string | null;
  /** Where the window starts, by the date the period reads; null for all time. */
  windowSince: string | null;
  /** The board's fingerprint when the page was built; the poll compares against it. */
  boardSignature: string;
  /** Who is looking: Validate and the amber are the admin's (navigation plan E1). */
  viewerRole: "admin" | "member";
}) {
  const router = useRouter();
  const t = dict(lang);
  const [filter, setFilter] = useState<BoardFilter>(initialFilter);
  const [totals, setTotals] = useState<BoardTotals>(initialTotals);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
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
      search: searchBoardCardsAction,
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
  const projectOptions = useMemo(
    () =>
      projectFilterOptions(cards, projects, filter).map((option) => ({
        ...option,
        hasContext:
          projects.find((project) => project.id === option.id)?.hasContext ?? false,
        contextStatus:
          projects.find((project) => project.id === option.id)?.contextStatus ?? null,
      })),
    [cards, projects, filter],
  );
  const organizationOptions = useMemo(
    () =>
      organizationFilterOptions(cards, organizations, filter).map((option) => ({
        ...option,
        hasContext:
          organizations.find((org) => org.id === option.id)?.hasContext ?? false,
      })),
    [cards, organizations, filter],
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
  const hasActiveFilters =
    filter.organizationIds.length > 0 ||
    filter.projectIds.length > 0 ||
    filter.missionId !== null ||
    filter.types.length > 0 ||
    filter.priorities.length > 0 ||
    filter.resolvedIn !== undefined ||
    searchQuery.trim().length > 0;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

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
          const answer = await boardSignatureAction();
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
    const saved = setBoardFilterAction(next);
    setFilter(next);
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

  function stopPicking() {
    setPicking(false);
    setSelected([]);
  }

  function clearBoardFilters() {
    setSearchQuery("");
    setDebouncedSearchQuery("");
    apply({
      organizationIds: [],
      projectIds: [],
      missionId: null,
      types: [],
      priorities: [],
      // The period is a reach, not a narrowing: clearing filters keeps it,
      // and the date it reads.
      period,
      periodBy,
    });
  }

  return (
    <>
      {/* Navigation plan E1: identity, places, work state and the account
          moved up to the global bar (the route's layout). What stays here is
          the board's filter line, still ONE line on the desktop with what
          does not fit stepping aside in order (nebula.css, "one line"), and
          the cost at its far end, as in A-board-1440. On the phone the
          filters live behind the Filtros button. */}
      <header className="topbar-wrap">
        <div className="topbar topbar-l1">
          <div className="spacer" />
          {/* The figure that justifies the board stays readable at a glance;
              the reading of it moved into the popover it opens. */}
          <BoardTotal totals={totals} filter={filter} t={t} />
        </div>
        <div className="topbar-l2">
          {/* On the desktop the wrapper is transparent to the level, the
              controls inside it lay out exactly as before, and the phone-only
              filters button stays hidden. On the phone the level collapses
              behind the Filtros button and the wrapper becomes the panel that
              holds it: same controls, same order, nothing dropped (AGB-65). */}
          <div className={`topbar-more${filtersOpen ? " open" : ""}`}>
            <div className="crumb">
              {/* Only where there is a choice to make: one business is the
                  whole board, and a control that can only be set to All is one
                  more thing to read for nothing. */}
              {organizations.length > 1 ? (
                <OrganizationFilter
                  options={organizationOptions}
                  value={filter.organizationIds}
                  onToggle={(organizationId) =>
                    apply({
                      ...filter,
                      organizationIds: toggleOrganization(
                        filter.organizationIds,
                        organizationId,
                        organizations,
                      ),
                      // The projects on screen belong to the business that just
                      // left. Keeping them would leave an empty board under a
                      // filter that reads as if it should show something.
                      projectIds: [],
                    })
                  }
                  onOnly={(organizationId) =>
                    apply({
                      ...filter,
                      organizationIds: selectOnly(organizationId, organizations),
                      projectIds: [],
                    })
                  }
                  onAll={() =>
                    apply({ ...filter, organizationIds: [], projectIds: [] })
                  }
                  t={t}
                />
              ) : null}
              <ProjectFilter
                options={projectOptions}
                value={filter.projectIds}
                onToggle={(projectId) =>
                  apply({
                    ...filter,
                    projectIds: toggleProject(filter.projectIds, projectId, projects),
                  })
                }
                onOnly={(projectId) =>
                  apply({ ...filter, projectIds: selectOnly(projectId, projects) })
                }
                onAll={() => apply({ ...filter, projectIds: [] })}
                t={t}
              />
            </div>
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
            <PeriodFilter
              value={period}
              onChange={(next) => apply({ ...filter, period: next })}
              t={t}
            />
            {/* On the phone this one moves into More filters (the sheet
                hides it), so the sheet keeps one row for the period. */}
            <PeriodByFilter
              value={periodBy}
              onChange={(next) => apply({ ...filter, periodBy: next })}
              t={t}
            />
            <FacetFilters
              types={filter.types}
              priorities={filter.priorities}
              releases={releaseOptions}
              resolvedIn={filter.resolvedIn}
              onTypesChange={(types) => apply({ ...filter, types })}
              onPrioritiesChange={(priorities) =>
                apply({ ...filter, priorities })
              }
              onReleaseChange={(resolvedIn) =>
                apply({ ...filter, resolvedIn })
              }
              periodBy={periodBy}
              onPeriodByChange={(next) => apply({ ...filter, periodBy: next })}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onOpen={() => setFiltersOpen(true)}
              onClear={() => {
                const { resolvedIn: _release, ...rest } = filter;
                setSearchQuery("");
                setDebouncedSearchQuery("");
                apply({ ...rest, types: [], priorities: [] });
              }}
              t={t}
            />
            {/* The count says something on a narrowed board; on the whole one
                it is the first thing the one-line bar lets go of. */}
            <span
              className={`filter-result${hasActiveFilters || searchQuery.trim() ? " narrowed" : ""}`}
            >
              {searching ? t.board.searchingOlder : t.board.cardsShown(visible.length)}
              {searchLimited && !searching ? (
                <> · {t.board.searchLimited}</>
              ) : null}
            </span>
            {hasActiveFilters ? (
              <button
                className="btn-ghost clear-board-filters"
                type="button"
                onClick={clearBoardFilters}
                aria-label={t.board.clearFilters}
                title={t.board.clearFilters}
              >
                {/* Where the bar runs short the words step aside and the
                    mark stays, with the words as its name. */}
                <Icon name="close" label={null} size={12} className="cbf-icon" />
                <span className="cbf-label">{t.board.clearFilters}</span>
              </button>
            ) : null}
            {/* ux-v2 §3: "Mover para missão" appears only with cards
                selected, right-aligned — an impossible action with nothing
                picked has no reason to sit on the bar (OCL-86). The trigger
                for entering picking mode is a separate concern outside this
                card's scope; `selected` is the real precondition. */}
            {selected.length > 0 ? (
              <button
                className={`btn-ghost move-btn${picking ? " on" : ""}`}
                type="button"
                onClick={() => {
                  setFiltersOpen(false);
                  if (picking) stopPicking();
                  else setPicking(true);
                }}
              >
                {picking ? t.board.cancelSelection : t.board.moveToMission}
              </button>
            ) : null}
          </div>
          <button
            className="filters-btn"
            type="button"
            aria-expanded={filtersOpen}
            aria-label={t.board.filters}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Icon name="filter" label={null} size={14} />
            <span>{t.board.filters}</span>
            {/* How many filters are on, not how many cards are left: that
                count is a line of its own in the sheet. Nothing when none. */}
            {activeFilterCount(filter) > 0 ? (
              <span className="badge">{activeFilterCount(filter)}</span>
            ) : null}
            {searchQuery.trim() ? (
              <span
                className="badge ff-query-badge"
                title={searchQuery.trim()}
              >
                {searchQuery.trim()}
              </span>
            ) : null}
          </button>
        </div>
      </header>
      {/* Tap-away target for the phone filters panel; rendered only while it
          is open, which the desktop never does. */}
      {filtersOpen ? (
        <div className="menu-backdrop" onClick={() => setFiltersOpen(false)} />
      ) : null}

      {selectedMission ? (
        <MissionHeader
          mission={selectedMission}
          t={t}
          onDeleted={() => apply({ ...filter, missionId: null })}
        />
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
        onMissionSelect={(missionId) => apply({ ...filter, missionId })}
        initialOpen={openCard}
        detailVersion={boardSignature}
        viewerRole={viewerRole}
      />

      {picking ? (
        <BulkMissionBar
          selected={selected}
          missions={missions}
          onDone={stopPicking}
          onClear={stopPicking}
          t={t}
        />
      ) : null}
    </>
  );
}
