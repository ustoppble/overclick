"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import {
  BOARD_PERIOD_FIELDS,
  BOARD_PERIODS,
  type BoardPeriod,
  type BoardPeriodField,
} from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";

/**
 * How far back the board reaches. Four fixed answers, one of them always
 * picked: a menu with a trigger that looks like its neighbours (same 32px
 * control, same chevron) and a listbox panel. It was a bare native select, a
 * small pill with no chevron that did not read as a menu and opened the
 * operating system's own list, out of the app's style.
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
  return (
    <ChoiceMenu
      className="period-filter"
      label={t.board.periodLabel}
      choices={BOARD_PERIODS}
      names={t.board.periodOptions}
      value={value}
      onChange={onChange}
    />
  );
}

/**
 * Which date the period reads: the last activity (the default) or when the
 * card was created. The period's own menu, beside it on the bar; on the phone
 * it lives in More filters instead, so the sheet does not grow a row for it.
 */
export function PeriodByFilter({
  value,
  onChange,
  t,
}: {
  value: BoardPeriodField;
  onChange: (periodBy: BoardPeriodField) => void;
  t: Dict;
}) {
  return (
    <ChoiceMenu
      className="period-filter period-by-filter"
      label={t.board.periodByLabel}
      choices={BOARD_PERIOD_FIELDS}
      names={t.board.periodByOptions}
      value={value}
      onChange={onChange}
    />
  );
}

function ChoiceMenu<T extends string>({
  className,
  label,
  choices,
  names,
  value,
  onChange,
}: {
  className: string;
  label: string;
  choices: readonly T[];
  names: Record<T, string>;
  value: T;
  onChange: (choice: T) => void;
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
      options.current[choices.indexOf(value)]?.focus(),
    );
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(frame);
    };
  }, [open, value, choices]);

  function move(from: number, step: number) {
    const next = (from + step + choices.length) % choices.length;
    options.current[next]?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowDown") move(index, 1);
    else if (event.key === "ArrowUp") move(index, -1);
    else if (event.key === "Home") options.current[0]?.focus();
    else if (event.key === "End") options.current[choices.length - 1]?.focus();
    else if (event.key === "Tab") setOpen(false);
    else return;
    if (event.key !== "Tab") event.preventDefault();
  }

  return (
    <div className={className} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="period-trigger oc-tappable"
        aria-label={label}
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
        <span className="period-label">{names[value]}</span>
        <Icon name="chevronDown" label={null} size={14} />
      </button>

      {open ? (
        <div className="period-panel nebula-glass">
          <div className="period-list" role="listbox" aria-label={label}>
            {choices.map((choice, index) => {
              const picked = choice === value;
              return (
                <button
                  key={choice}
                  ref={(element) => {
                    options.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  className={`period-opt${picked ? " on" : ""}`}
                  onKeyDown={(event) => onListKeyDown(event, index)}
                  onClick={() => {
                    if (!picked) onChange(choice);
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  <span className="period-opt-name">{names[choice]}</span>
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
