"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import { BOARD_PERIODS, type BoardPeriod } from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";

/**
 * How far back the board reaches, by a card's last activity. Four fixed
 * answers, one of them always picked: a menu with a trigger that looks like
 * its neighbours (same 32px control, same chevron) and a listbox panel. It
 * was a bare native select, a small pill with no chevron that did not read as
 * a menu and opened the operating system's own list, out of the app's style.
 */
export function PeriodFilter({
  value,
  onChange,
  t,
}: {
  value: BoardPeriod;
  onChange: (period: BoardPeriod) => void;
  t: Dict;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // The picked answer takes the focus, so the arrows start from where the
    // user already is.
    const frame = window.requestAnimationFrame(() =>
      options.current[BOARD_PERIODS.indexOf(value)]?.focus(),
    );
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(frame);
    };
  }, [open, value]);

  function move(from: number, step: number) {
    const next = (from + step + BOARD_PERIODS.length) % BOARD_PERIODS.length;
    options.current[next]?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowDown") move(index, 1);
    else if (event.key === "ArrowUp") move(index, -1);
    else if (event.key === "Home") options.current[0]?.focus();
    else if (event.key === "End")
      options.current[BOARD_PERIODS.length - 1]?.focus();
    else if (event.key === "Tab") setOpen(false);
    else return;
    if (event.key !== "Tab") event.preventDefault();
  }

  return (
    <div className="period-filter" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="period-trigger oc-tappable"
        aria-label={t.board.periodLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="period-label">{t.board.periodOptions[value]}</span>
        <Icon name="chevronDown" label={null} size={14} />
      </button>

      {open ? (
        <div className="period-panel nebula-glass">
          <div
            className="period-list"
            role="listbox"
            aria-label={t.board.periodLabel}
          >
            {BOARD_PERIODS.map((period, index) => {
              const picked = period === value;
              return (
                <button
                  key={period}
                  ref={(element) => {
                    options.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  className={`period-opt${picked ? " on" : ""}`}
                  onKeyDown={(event) => onListKeyDown(event, index)}
                  onClick={() => {
                    if (!picked) onChange(period);
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  <span className="period-opt-name">
                    {t.board.periodOptions[period]}
                  </span>
                  {picked ? <Icon name="check" label={null} size={13} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
