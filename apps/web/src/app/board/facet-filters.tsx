"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/icon";
import type { ReleaseCount } from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";

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

/** A trigger and the panel it opens, closed by a click away or Escape. */
function useMenu(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
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
  return { open, setOpen, root };
}

/**
 * One facet of the card, its own trigger on the filter line (navigation plan
 * E4): "Type ②", "Priority ③". They used to share the Filters menu with the
 * search and the release; the search went up to the global bar, the release
 * to More, and each facet is one click away. A picked facet reads as the
 * count badge on the trigger, never as a colour of its own.
 */
export function FacetMenu<T extends string>({
  kind,
  label,
  choices,
  names,
  value,
  onChange,
  defaultOpen = false,
}: {
  kind: "type" | "priority";
  label: string;
  choices: readonly T[];
  names: Record<T, string>;
  value: T[];
  onChange: (next: T[]) => void;
  /** Lets server-rendered UI tests inspect the panel without a browser. */
  defaultOpen?: boolean;
}) {
  const { open, setOpen, root } = useMenu(defaultOpen);
  return (
    <div className={`facet-menu ${kind}-filter`} ref={root}>
      <button
        type="button"
        className={`${kind}-trigger${value.length > 0 ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        {value.length > 0 ? <span className="badge">{value.length}</span> : null}
        <Icon name="chevronDown" label={null} size={14} />
      </button>
      {open ? (
        <div className="ff-panel fm-panel nebula-glass" role="dialog" aria-label={label}>
          <div className="ff-list">
            {choices.map((choice) => {
              const selected = value.includes(choice);
              return (
                <label key={choice} className={`ff-opt${selected ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onChange(toggleFacet(value, choice, choices))}
                  />
                  <span className="ff-box" aria-hidden="true">
                    {selected ? <Icon name="check" label={null} size={12} /> : null}
                  </span>
                  <span className="ff-opt-name">{names[choice]}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * More (E4): what is left behind the line once type, priority and the period
 * have their own controls. Today that is the release; the trigger keeps the
 * Filters menu's anatomy and class, so the style guards still see it.
 */
export function MoreFilters({
  releases,
  resolvedIn,
  onReleaseChange,
  defaultOpen = false,
  t,
}: {
  releases: ReleaseCount[];
  resolvedIn: string | null | undefined;
  onReleaseChange: (release: string | null | undefined) => void;
  defaultOpen?: boolean;
  t: Dict;
}) {
  const { open, setOpen, root } = useMenu(defaultOpen);
  const active = resolvedIn !== undefined;

  function releaseOption(key: string, value: string | null | undefined, text: string, count?: number): ReactNode {
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
        className={`filter-chip ff-trigger${active ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{t.filterLine.more}</span>
        {active ? <span className="badge">1</span> : null}
        <Icon name="chevronDown" label={null} size={14} />
      </button>
      {open ? (
        <div className="ff-panel fm-panel nebula-glass" role="dialog" aria-label={t.filterLine.more}>
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
        </div>
      ) : null}
    </div>
  );
}
