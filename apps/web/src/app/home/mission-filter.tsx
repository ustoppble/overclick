"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createMissionAction } from "../../actions/missions";
import { Markdown } from "../../components/markdown";
import {
  NO_MISSION,
  searchMissions,
  shouldSearchMissions,
  type MissionCount,
} from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../../components/icon";
import type { BoardMissionOption } from "./board";
import { MissionProgressBar } from "./mission-progress-bar";

/**
 * The mission filter of the board. A native select could not do the three
 * things this filter needs: a count beside each mission, a clear that costs
 * one click instead of a trip through the list, and a search box once the
 * list grows past a handful. So the chip opens a panel it owns.
 *
 * What it offers is decided upstream by missionFilterOptions: only missions
 * holding cards in the current scope. Choosing a mission for a card is a
 * different question and still lists every mission of the workspace.
 */
export function MissionFilter({
  options,
  missions,
  looseCount,
  totalCount,
  value,
  organizationId,
  onChange,
  onCreated,
  t,
}: {
  options: MissionCount[];
  /**
   * Every mission of the workspace, with its own card-status breakdown
   * (OCL-138). The bar reads the mission's real progress, not the count
   * scoped by the board's current filters that `options` carries.
   */
  missions: BoardMissionOption[];
  /** Cards here that are in no mission, the bucket at the end of the list. */
  looseCount: number;
  /** Every card in scope, the count of "All missions". */
  totalCount: number;
  value: string | null;
  /**
   * The business the board is filtered to, when it is exactly one. A mission
   * created from here is filed there; with the filter on several businesses
   * or on all of them, the server picks and the mission can be moved.
   */
  organizationId: string | null;
  onChange: (missionId: string | null) => void;
  onCreated: (missionId: string) => void;
  t: Dict;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createPending, startCreate] = useTransition();
  const root = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  const searchable = shouldSearchMissions(options.length);
  const shown = useMemo(
    () => (searchable ? searchMissions(options, query) : options),
    [options, query, searchable],
  );

  // Closing is the same gesture people already use on a select: click away,
  // or press Escape. Without it the panel would outlive the choice it exists
  // for and sit on top of the board.
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

  useEffect(() => {
    if (open && searchable) search.current?.focus();
    if (!open) {
      setQuery("");
      setCreating(false);
      setCreateError(null);
    }
  }, [open, searchable]);

  const selected = value ? options.find((item) => item.id === value) : undefined;
  const label =
    value === NO_MISSION
      ? t.board.noMission
      : (selected?.title ?? t.board.allMissions);

  function pick(next: string | null) {
    onChange(next);
    setOpen(false);
  }

  function createMission() {
    startCreate(async () => {
      setCreateError(null);
      const result = await createMissionAction({
        title,
        objective,
        context,
        organizationId,
      });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setTitle("");
      setObjective("");
      setContext("");
      onCreated(result.mission.id);
      setOpen(false);
    });
  }

  function row(
    id: string | null,
    text: string,
    count: number,
    counts?: BoardMissionOption["counts"],
  ) {
    const active = (id ?? null) === value;
    return (
      <button
        key={id ?? "all"}
        type="button"
        role="option"
        aria-selected={active}
        className={`mf-opt${active ? " on" : ""}${counts ? " mf-opt-stacked" : ""}`}
        onClick={() => pick(id)}
      >
        <span className="mf-opt-main">
          <span className="mf-opt-title" title={text}>
            {text}
          </span>
          <span className="mf-opt-count">{count}</span>
        </span>
        {counts ? <MissionProgressBar counts={counts} t={t} size="sm" /> : null}
      </button>
    );
  }

  return (
    <div className="mission-filter" ref={root}>
      <div className={`filter-chip mf-chip${value ? " on" : ""}`}>
        <button
          type="button"
          className="mf-trigger oc-tappable"
          aria-label={t.board.missionFilter}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="mf-label" title={label}>
            {label}
          </span>
          <Icon name="chevronDown" label={null} size={14} />
        </button>
        {value ? (
          <button
            type="button"
            className="mf-clear"
            aria-label={t.board.clearMission}
            title={t.board.clearMission}
            onClick={() => pick(null)}
          >
            {/* AGB-73: clearing the filter is the set's own mark, not the
                multiplication sign the font happened to draw. The button
                already carries the name, so the glyph stays silent. */}
            <Icon name="clear" label={null} size={13} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className={`mf-panel nebula-glass${creating ? " creating" : ""}`}>
          {creating ? (
            <div className="mf-create">
              <div className="mf-create-head">
                <b>{t.board.missionCreate}</b>
                <button
                  type="button"
                  aria-label={t.board.missionCancel}
                  disabled={createPending}
                  onClick={() => setCreating(false)}
                >
                  <Icon name="clear" label={null} size={13} />
                </button>
              </div>
              <label>
                <span>{t.board.missionTitle}</span>
                <input
                  value={title}
                  maxLength={200}
                  disabled={createPending}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                <span>{t.board.missionObjective}</span>
                <textarea
                  value={objective}
                  rows={3}
                  disabled={createPending}
                  onChange={(event) => setObjective(event.target.value)}
                />
              </label>
              <label>
                <span>{t.board.missionContext}</span>
                <textarea
                  value={context}
                  rows={6}
                  disabled={createPending}
                  onChange={(event) => setContext(event.target.value)}
                />
              </label>
              {objective || context ? (
                <div className="mf-create-preview">
                  <span>{t.board.missionPreview}</span>
                  {objective ? <Markdown text={objective} /> : null}
                  {context ? <Markdown text={context} /> : null}
                </div>
              ) : null}
              {createError ? (
                <p className="mf-create-error">{createError}</p>
              ) : null}
              <button
                className="d-btn-pri"
                type="button"
                disabled={createPending || title.trim().length === 0}
                onClick={createMission}
              >
                {createPending
                  ? t.board.missionCreating
                  : t.board.missionCreate}
              </button>
            </div>
          ) : (
            <>
              {searchable ? (
                /* The mark sits in the field, so the box reads as a search before
                   the placeholder is read at all (AGB-73). */
                <div className="mf-search-row">
                  <Icon name="search" label={null} size={13} />
                  <input
                    ref={search}
                    className="mf-search"
                    type="search"
                    value={query}
                    placeholder={t.board.searchMissions}
                    aria-label={t.board.searchMissions}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              ) : null}
              <div
                className="mf-list"
                role="listbox"
                aria-label={t.board.missionFilter}
              >
                {row(null, t.board.allMissions, totalCount)}
                {shown.map((option) =>
                  row(
                    option.id,
                    option.title,
                    option.count,
                    missions.find((miss) => miss.id === option.id)?.counts,
                  ),
                )}
                {looseCount > 0 || value === NO_MISSION
                  ? row(NO_MISSION, t.board.noMission, looseCount)
                  : null}
                {searchable && shown.length === 0 ? (
                  <p className="mf-empty">{t.board.noMissionMatch}</p>
                ) : null}
              </div>
              <button
                className="mf-create-trigger"
                type="button"
                onClick={() => setCreating(true)}
              >
                {t.board.missionNew}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
