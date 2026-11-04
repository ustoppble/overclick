"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../icon";
import { getBoardSearch, setBoardSearch, subscribeBoardSearch } from "./search-channel";

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
      (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)),
  );
}

/**
 * The search, in the global bar (navigation plan E4). It says what it
 * reaches, "Search cards" (F18), and keeps `/` and ⌘K. On the board it
 * filters the board as the words are typed; anywhere else it is a plain form
 * that lands on `/board?q=`, which also works before the page hydrates. On a
 * bar too narrow for the field it is an icon that opens the field over the
 * bar: the first thing the bar lets go of, and never all of it.
 */
export function BarSearch({ onBoard, t }: { onBoard: boolean; t: Dict }) {
  const shared = useSyncExternalStore(subscribeBoardSearch, getBoardSearch, () => "");
  const [local, setLocal] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const value = onBoard ? shared : local;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const slash = event.key === "/" && !isEditableTarget(event.target);
      const commandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!slash && !commandK) return;
      event.preventDefault();
      setOpen(true);
      window.requestAnimationFrame(() => input.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className={`gb-search${open ? " open" : ""}`} ref={root}>
      <form
        className="gb-search-form"
        action="/board"
        method="get"
        role="search"
        onSubmit={(event) => {
          if (!onBoard) return;
          // On the board the words already filter it; Enter is not a navigation.
          event.preventDefault();
        }}
      >
        <Icon name="search" label={null} size={14} />
        <input
          ref={input}
          className="gb-search-input"
          type="search"
          name="q"
          value={value}
          placeholder={t.board.searchCards}
          aria-label={t.board.searchCards}
          autoComplete="off"
          onChange={(event) => {
            if (onBoard) setBoardSearch(event.target.value);
            else setLocal(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            input.current?.blur();
          }}
        />
        <kbd className="gb-kbd" aria-hidden="true">
          {t.filterLine.searchShortcut}
        </kbd>
      </form>
      <button
        type="button"
        className="gb-search-btn"
        aria-label={t.board.searchCards}
        aria-expanded={open}
        title={t.board.searchCards}
        onClick={() => {
          setOpen((current) => !current);
          window.requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <Icon name="search" label={null} size={14} />
        {value.trim() ? <span className="gb-search-dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
