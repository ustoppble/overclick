"use client";

import type { TaskPriority, TaskType } from "@agent-board/db";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import {
  TASK_PRIORITIES,
  TASK_TYPES,
  type ReleaseCount,
} from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
      (element.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)),
  );
}

export function toggleFacet<T extends string>(
  current: T[],
  value: T,
  order: readonly T[],
): T[] {
  const selected = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  return order.filter((item) => selected.includes(item));
}

/** Card facets and the release cut share one compact, responsive control. */
export function FacetFilters({
  types,
  priorities,
  releases,
  resolvedIn,
  onTypesChange,
  onPrioritiesChange,
  onReleaseChange,
  onClear,
  query,
  onQueryChange,
  onOpen,
  defaultOpen = false,
  t,
}: {
  types: TaskType[];
  priorities: TaskPriority[];
  releases: ReleaseCount[];
  resolvedIn: string | null | undefined;
  onTypesChange: (types: TaskType[]) => void;
  onPrioritiesChange: (priorities: TaskPriority[]) => void;
  onReleaseChange: (release: string | null | undefined) => void;
  onClear: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Opens the level-2 sheet as well when a keyboard shortcut is used. */
  onOpen?: () => void;
  /** Lets server-rendered UI tests inspect the panel without a browser. */
  defaultOpen?: boolean;
  t: Dict;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const activeCount =
    types.length + priorities.length + (resolvedIn !== undefined ? 1 : 0);
  const hasSearch = query.trim().length > 0;
  const hasActiveFilters = activeCount > 0 || hasSearch;

  function openPanel() {
    setOpen(true);
    onOpen?.();
  }

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
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const slash = event.key === "/" && !isEditableTarget(event.target);
      const commandK = (event.metaKey || event.ctrlKey) && key === "k";
      if (!slash && !commandK) return;
      event.preventDefault();
      openPanel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => search.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const typeLabels: Record<TaskType, string> = {
    bug: t.board.typeBug,
    feature: t.board.typeFeature,
    rfc: t.board.typeRfc,
  };
  const priorityLabels: Record<TaskPriority, string> = {
    urgente: t.board.priorityUrgent,
    alta: t.board.priorityHigh,
    media: t.board.priorityMedium,
    baixa: t.board.priorityLow,
  };

  function option<T extends string>(
    value: T,
    text: string,
    selected: boolean,
    onChange: () => void,
  ) {
    return (
      <label key={value} className={`ff-opt${selected ? " on" : ""}`}>
        <input type="checkbox" checked={selected} onChange={onChange} />
        <span className="ff-box" aria-hidden="true">
          {selected ? <Icon name="check" label={null} size={11} /> : null}
        </span>
        <span className="ff-opt-name">{text}</span>
      </label>
    );
  }

  function releaseOption(
    key: string,
    value: string | null | undefined,
    text: string,
    count?: number,
  ) {
    const selected = resolvedIn === value;
    return (
      <label key={key} className={`ff-opt${selected ? " on" : ""}`}>
        <input
          type="radio"
          name="board-release"
          checked={selected}
          onChange={() => onReleaseChange(value)}
        />
        <span className="ff-box ff-radio" aria-hidden="true">
          {selected ? <span className="ff-radio-dot" /> : null}
        </span>
        <span className="ff-opt-name">{text}</span>
        {count !== undefined ? <span className="ff-opt-count">{count}</span> : null}
      </label>
    );
  }

  return (
    <div className="facet-filters" ref={root}>
      <button
        type="button"
        className={`filter-chip ff-trigger${hasActiveFilters ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) setOpen(false);
          else openPanel();
        }}
      >
        {/* ux-v2 §3: the funnel is the Lucide filter mark at 14px, and an
            active filter set reads as a count badge, not as "· N" text. */}
        <Icon name="filter" label={null} size={14} />
        {/* On the phone this menu lives inside the sheet the bar's Filters
            button opens: two buttons named alike, so the sheet's says More. */}
        <span className="ff-label-bar">{t.board.filters}</span>
        <span className="ff-label-sheet">{t.board.moreFilters}</span>
        {activeCount > 0 ? <span className="badge">{activeCount}</span> : null}
        {hasSearch ? (
          <span className="badge ff-query-badge" title={query.trim()}>
            {query.trim()}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="ff-panel nebula-glass"
          role="dialog"
          aria-label={t.board.filters}
        >
          <div className="ff-search-row">
            <Icon name="search" label={null} size={14} />
            <input
              ref={search}
              className="ff-search"
              type="search"
              value={query}
              placeholder={t.board.searchCards}
              aria-label={t.board.searchCards}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {hasSearch ? (
              <button
                className="ff-search-clear"
                type="button"
                aria-label={t.board.clearSearch}
                title={t.board.clearSearch}
                onClick={() => onQueryChange("")}
              >
                <Icon name="clear" label={null} size={13} />
              </button>
            ) : null}
          </div>
          <section className="ff-section" aria-labelledby="ff-types-label">
            <h3 id="ff-types-label">{t.board.typeFilter}</h3>
            <div className="ff-list">
              {TASK_TYPES.map((type) =>
                option(type, typeLabels[type], types.includes(type), () =>
                  onTypesChange(toggleFacet(types, type, TASK_TYPES)),
                ),
              )}
            </div>
          </section>
          <section className="ff-section" aria-labelledby="ff-priorities-label">
            <h3 id="ff-priorities-label">{t.board.priorityFilter}</h3>
            <div className="ff-list">
              {TASK_PRIORITIES.map((priority) =>
                option(
                  priority,
                  priorityLabels[priority],
                  priorities.includes(priority),
                  () =>
                    onPrioritiesChange(
                      toggleFacet(priorities, priority, TASK_PRIORITIES),
                    ),
                ),
              )}
            </div>
          </section>
          <section className="ff-section" aria-labelledby="ff-release-label">
            <h3 id="ff-release-label">{t.board.releaseFilter}</h3>
            <div className="ff-list">
              {releaseOption("all", undefined, t.board.allReleases)}
              {releases.map((release) =>
                releaseOption(
                  release.value ?? "no-release",
                  release.value,
                  release.value ?? t.board.noRelease,
                  release.count,
                ),
              )}
            </div>
          </section>
          <button
            className="ff-clear"
            type="button"
            disabled={!hasActiveFilters}
            onClick={onClear}
          >
            {t.board.clearFilters}
          </button>
        </div>
      ) : null}
    </div>
  );
}
