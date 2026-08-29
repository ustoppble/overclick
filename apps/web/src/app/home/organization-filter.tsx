"use client";

import { useEffect, useRef, useState } from "react";
import type { OrganizationCount } from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../../components/icon";

/**
 * The organization filter, first control of the bar: on an instance holding
 * the repos of several businesses, this is the choice every other filter
 * happens inside of, so it reads before the project.
 *
 * It is deliberately the project filter's anatomy and classes, not a second
 * one that drifts: same trigger, same panel, same option row (the style
 * guards in `styles/control-anatomy.test.ts` and
 * `styles/filter-option-row.test.ts` audit that anatomy by class name). The
 * extra class only says which of the two this is, for anyone reading the DOM.
 */
export function OrganizationFilter({
  options,
  /** Empty is the All organizations shortcut. */
  value,
  onToggle,
  onAll,
  t,
}: {
  options: Array<OrganizationCount & { hasContext?: boolean }>;
  value: string[];
  onToggle: (organizationId: string) => void;
  onAll: () => void;
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

  const all = value.length === 0;
  // Same rule as the project chip: the name while it is one business, the
  // count once naming them all would cost the topbar a second line.
  const label = all
    ? t.board.allOrganizations
    : value.length === 1
      ? (options.find((item) => item.id === value[0])?.name ??
        t.board.allOrganizations)
      : t.board.organizationsPicked(value.length);

  return (
    <div className="project-filter organization-filter" ref={root}>
      <button
        type="button"
        className="pf-trigger"
        aria-label={t.board.organizationFilter}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="pf-label" title={label}>
          {label}
        </span>
        <Icon name="chevronDown" label={null} size={14} />
      </button>

      {open ? (
        <div className="pf-panel nebula-glass">
          <div
            className="pf-list"
            role="listbox"
            aria-multiselectable="true"
            aria-label={t.board.organizationFilter}
          >
            <button
              type="button"
              role="option"
              aria-selected={all}
              className={`pf-opt${all ? " on" : ""}`}
              onClick={() => {
                onAll();
                setOpen(false);
              }}
            >
              <span className="pf-box">
                {all ? <Icon name="check" label={null} size={11} /> : null}
              </span>
              <span className="pf-opt-name">{t.board.allOrganizations}</span>
            </button>
            {options.map((option) => {
              // Under the shortcut every business is on screen, so every box
              // is ticked: the panel says what the board shows, not what was
              // clicked to get there.
              const picked = all || value.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  className={`pf-opt${picked ? " on" : ""}`}
                  onClick={() => onToggle(option.id)}
                >
                  <span className="pf-box">
                    {picked ? <Icon name="check" label={null} size={11} /> : null}
                  </span>
                  <span className="pf-opt-name" title={option.name}>
                    {option.name}
                  </span>
                  {option.hasContext ? (
                    <span
                      className="pf-opt-count"
                      aria-label={t.board.organizationContextAvailable}
                      title={t.board.organizationContextAvailable}
                    >
                      ctx
                    </span>
                  ) : null}
                  <span className="pf-opt-count">{option.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
