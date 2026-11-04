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
 * How far back the board reaches, said in words (navigation plan E4): "Show:
 * updated in the last 7 days". The period and the date it reads are one menu
 * now, two groups in one panel: the date used to be a control of its own that
 * the bar dropped first and the phone hid in More filters. The period is
 * remembered (F2), so it is always written out on the trigger, never a bare
 * "7d"; narrower bars drop the "Show:" word, then keep the short form.
 */
export function PeriodFilter({
  value,
  by,
  onChange,
  onByChange,
  defaultOpen = false,
  t,
}: {
  value: BoardPeriod;
  by: BoardPeriodField;
  onChange: (period: BoardPeriod) => void;
  onByChange: (periodBy: BoardPeriodField) => void;
  /** Lets server-rendered UI tests inspect the panel without a browser. */
  defaultOpen?: boolean;
  t: Dict;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

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
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const phrase = t.filterLine.periodPhrase(by, value);
  const group = <T extends string>(
    id: string,
    label: string,
    choices: readonly T[],
    names: Record<T, string>,
    picked: T,
    pick: (choice: T) => void,
  ) => (
    <section className="period-group" aria-labelledby={id}>
      <h3 id={id}>{label}</h3>
      <div className="period-list" role="listbox" aria-labelledby={id}>
        {choices.map((choice) => {
          const on = choice === picked;
          return (
            <button
              key={choice}
              type="button"
              role="option"
              aria-selected={on}
              className={`period-opt${on ? " on" : ""}`}
              onClick={() => {
                if (!on) pick(choice);
              }}
            >
              <span className="period-opt-name">{names[choice]}</span>
              {on ? <Icon name="check" label={null} size={13} /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );

  return (
    <div className="period-filter" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="period-trigger oc-tappable"
        aria-label={`${t.filterLine.show} ${phrase}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={phrase}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="show-prefix">{t.filterLine.show}</span>
        <span className="period-label period-long">{phrase}</span>
        <span className="period-label period-short">{t.filterLine.periodShort[value]}</span>
        <Icon name="chevronDown" label={null} size={14} />
      </button>

      {open ? (
        <div className="period-panel nebula-glass" role="dialog" aria-label={t.filterLine.show}>
          {group("period-group-reach", t.filterLine.periodSection, BOARD_PERIODS, t.board.periodOptions, value, (next) => {
            onChange(next);
            setOpen(false);
          })}
          {group("period-group-by", t.board.periodByLabel, BOARD_PERIOD_FIELDS, t.board.periodByOptions, by, (next) => {
            onByChange(next);
            setOpen(false);
          })}
        </div>
      ) : null}
    </div>
  );
}
