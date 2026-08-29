"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { logoutAction } from "../../actions/auth";
import { Wordmark } from "../../components/wordmark";
import {
  boardTotalsAction,
  setBoardFilterAction,
} from "../../actions/board-filter";
import { assignCardsToMissionAction } from "../../actions/missions";
import {
  NO_MISSION,
  countLooseCards,
  filterBoardCards,
  missionFilterOptions,
  organizationFilterOptions,
  projectFilterOptions,
  releaseFilterOptions,
  searchBoardCards,
  toggleOrganization,
  selectOnly,
  toggleProject,
  type BoardFilter,
} from "../../lib/board-filter";
import { subscribeToBoardRefresh } from "../../lib/board-refresh";
import type { BoardTotals } from "../../lib/board-totals";
import { dict, type Dict } from "../../lib/i18n";
import { Icon } from "../../components/icon";
import { Board, type BoardCard, type BoardMissionOption } from "./board";
import { BoardTotal } from "./board-total";
import { FacetFilters } from "./facet-filters";
import { MissionHeader } from "./mission-header";
import { MissionFilter } from "./mission-filter";
import { OrganizationFilter } from "./organization-filter";
import { ProjectFilter } from "./project-filter";
import { ReleaseHeader } from "./release-header";
import { ThemePicker } from "./theme-picker";

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

/**
 * The account and navigation menu (OCL-20): one button on the hard right of
 * the bar holding what is not a filter and not work state — Insights,
 * Settings and the way out. Under 1100px it also carries the running
 * work-state line, which level 1 folds into it (ux-v2 §3). The
 * dropdown closes on the same gesture as every other panel here: click away,
 * Escape.
 */
function AccountMenu({
  running,
  t,
}: {
  running: number;
  t: Dict;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={root}>
      <button
        type="button"
        className="am-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.board.accountMenu}
        onClick={() => setOpen((current) => !current)}
      >
        {/* The button is named, so the three dots stay silent. */}
        <Icon name="more" label={null} size={16} />
      </button>
      {open ? (
        <div className="am-panel nebula-glass" role="menu" aria-label={t.board.accountMenu}>
          {/* The running state leaves level 1 only at the 1100px step. The
              telemetry stat never leaves level 1. */}
          <a className="am-opt am-state" role="menuitem" href="#board-col-em_execucao">
            <span className={`dot${running === 0 ? " idle" : ""}`} />
            <span className="sc-label">
              {running > 0 ? t.board.running(running) : t.board.noAgentRunning}
            </span>
          </a>
          {/* Where the businesses are read one by one, next to the two other
              places this menu navigates to. */}
          <a className="am-opt" role="menuitem" href="/organizations">
            <Icon name="roles" label={null} size={14} />
            {t.board.organizations}
          </a>
          <a className="am-opt" role="menuitem" href="/insights">
            <Icon name="insights" label={null} size={14} />
            Insights
          </a>
          <a className="am-opt" role="menuitem" href="/settings">
            <Icon name="settings" label={null} size={14} />
            {t.board.settings}
          </a>
          {/* The skin the board wears: under the two places this menu
              navigates to, above the way out (OCL-56). */}
          <ThemePicker t={t} />
          <form action={logoutAction}>
            <button className="am-opt" role="menuitem" type="submit">
              <Icon name="logout" label={null} size={14} />
              {t.board.logout}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function HomeShell({
  lang,
  organizations,
  projects,
  missions,
  releases,
  cards,
  initialFilter,
  initialTotals,
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
  const visible = useMemo(
    () => searchBoardCards(filterBoardCards(cards, filter), debouncedSearchQuery),
    [cards, filter, debouncedSearchQuery],
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
  const running = visible.filter((card) => card.status === "em_execucao").length;
  const selectedMission =
    filter.missionId && filter.missionId !== NO_MISSION
      ? missions.find((item) => item.id === filter.missionId) ?? null
      : null;
  const defaultProject = projects[0]?.id;
  const hasActiveFilters =
    filter.organizationIds.length > 0 ||
    filter.projectIds.length !== (defaultProject ? 1 : 0) ||
    (defaultProject ? filter.projectIds[0] !== defaultProject : false) ||
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
  useEffect(() => subscribeToBoardRefresh(() => router.refresh()), [router]);

  function apply(next: BoardFilter) {
    setFilter(next);
    void setBoardFilterAction(next);
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
      projectIds: defaultProject ? [defaultProject] : [],
      missionId: null,
      types: [],
      priorities: [],
    });
  }

  return (
    <>
      {/* OCL-35 (ux-v2 §3): the bar is two levels now. Level 1 holds
          identity, running state, telemetry and account, and it never wraps and
          never truncates. Level 2 owns filtering, so a selected mission with
          a long title no longer squeezes everything else off the line. */}
      <header className="topbar-wrap">
        <div className="topbar topbar-l1">
          <Wordmark label={t.board.homeLink} current />
          <div className="spacer" />
          {/* Running state stays visible: it is not navigation, it is what the
              board is doing. Under 1100px it folds into the account menu. */}
          <a className="state-chip agent-status" href="#board-col-em_execucao">
            <span className={`dot${running === 0 ? " idle" : ""}`} />
            <span className="sc-label">
              {running > 0 ? t.board.running(running) : t.board.noAgentRunning}
            </span>
          </a>
          {/* The figure that justifies the board stays readable at a glance;
              the reading of it moved into the popover it opens. */}
          <BoardTotal totals={totals} filter={filter} t={t} />
          <AccountMenu running={running} t={t} />
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
            <span className="filter-result">{t.board.cardsShown(visible.length)}</span>
            {hasActiveFilters ? (
              <button
                className="btn-ghost clear-board-filters"
                type="button"
                onClick={clearBoardFilters}
              >
                {t.board.clearFilters}
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
            <span className="badge">{visible.length}</span>
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
