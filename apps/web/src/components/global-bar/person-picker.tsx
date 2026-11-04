"use client";

import { useEffect, useRef, useState } from "react";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../icon";

export type PersonOption = { id: string; email: string };

const ALL = "all";
const ME = "me";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A person as the bar writes them: the part of the email before the @. */
export function shortName(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * The person on screen: the address's `?person=` when it says one, the
 * remembered pick when it does not — read with the server's rule
 * (person-filter.ts), so the bar names exactly what the board filtered by. An
 * id that is not one of the people offered reads as everyone, as it does there.
 */
export function personOnScreen(
  people: readonly PersonOption[],
  viewerId: string,
  remembered: string,
  params: { get(name: string): string | null } | null,
): string {
  const asked = params?.get("person") ?? null;
  if (asked === null) return remembered;
  if (asked === ALL || asked === ME) return asked;
  if (asked === viewerId) return ME;
  return UUID.test(asked) && people.some((person) => person.id === asked) ? asked : ALL;
}

/** The control's words for a choice: everyone, me, or the person's short name. */
export function personWords(
  people: readonly PersonOption[],
  value: string,
  t: Dict,
): { label: string; title: string } {
  if (value === ME) return { label: t.filterLine.personMe, title: t.filterLine.personMe };
  const person = value === ALL ? null : people.find((item) => item.id === value);
  if (!person) return { label: t.filterLine.personAll, title: t.filterLine.personAll };
  return { label: shortName(person.email), title: person.email };
}

/**
 * The person filter, in the global bar beside the scope: whose cards the board
 * shows — everyone, me, or one of the people on a card this reader can see.
 * One pick at a time. It narrows on the server, inside the reader's scope; the
 * list it offers never names anyone the reader could not already see.
 */
export function PersonPicker({
  people,
  viewerId,
  value,
  onChange,
  t,
}: {
  people: readonly PersonOption[];
  viewerId: string;
  value: string;
  onChange: (next: string) => void;
  t: Dict;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const words = personWords(people, value, t);
  const others = people.filter((person) => person.id !== viewerId);
  const pick = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };
  const row = (key: string, name: string, title: string) => {
    const picked = value === key;
    return (
      <button
        type="button"
        role="option"
        key={key}
        aria-selected={picked}
        className={`gb-scope-opt${picked ? " on" : ""}`}
        title={title}
        onClick={() => pick(key)}
      >
        <span className="gb-scope-box gb-person-radio" aria-hidden="true">
          {picked ? <Icon name="check" label={null} size={12} /> : null}
        </span>
        <span className="gb-scope-name">{name}</span>
      </button>
    );
  };

  return (
    <div className="gb-scope-wrap gb-person-wrap" ref={root}>
      <button
        type="button"
        className={`gb-scope gb-person${value !== ALL ? " on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t.filterLine.person}: ${words.title}`}
        title={`${t.filterLine.person}: ${words.title}`}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="roles" label={null} size={14} />
        <span className="gb-person-name">{words.label}</span>
        <Icon name="chevronDown" label={null} size={14} />
      </button>
      {open ? (
        <div className="gb-scope-panel gb-person-panel" role="dialog" aria-label={t.filterLine.person}>
          <p className="gb-person-hint">{t.filterLine.personHint}</p>
          <div role="listbox" aria-label={t.filterLine.person}>
            {row(ALL, t.filterLine.personAll, t.filterLine.personAll)}
            {row(ME, t.filterLine.personMe, t.filterLine.personMe)}
          </div>
          {others.length > 0 ? (
            <section aria-labelledby="gb-person-people">
              <h3 id="gb-person-people">{t.filterLine.personPeople}</h3>
              <div role="listbox" aria-labelledby="gb-person-people">
                {others.map((person) => row(person.id, shortName(person.email), person.email))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
