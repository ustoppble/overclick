"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { logoutAction } from "../../actions/auth";
import { globalBarCountsAction } from "../../actions/global-bar";
import { ThemePicker } from "../../app/board/theme-picker";
import { dict } from "../../lib/i18n";
import type { GlobalCounts } from "../../lib/global-counts";
import { Icon } from "../icon";
import { StatusMark } from "../status-mark";
import { Wordmark } from "../wordmark";
import { subscribeGlobalCounts } from "./counts-channel";

/** The place a page is, for `aria-current`. Settings and Organizations are not places. */
export type GlobalPlace = "board" | "missions" | "usage" | "settings" | "organizations";

/** Away from the board nothing else asks, so the bar asks itself this often. */
export const GLOBAL_COUNTS_INTERVAL_MS = 60_000;

const PLACES = [
  { key: "board", href: "/board", icon: "board" },
  // Navigation plan E3: Missions became a place with its own page.
  { key: "missions", href: "/missions", icon: "mission" },
  { key: "usage", href: "/usage", icon: "insights" },
] as const;

const REVIEW_HREF = "/board?status=feito";

/**
 * The avatar's menu (navigation plan E1): who is signed in and as what, then
 * the person's own agent, the workspace configuration (the admin's only),
 * the organizations, the theme and the way out. It replaces the ⋯ menu that
 * used to hold the navigation; navigation is the bar's places now.
 */
export function AvatarMenu({
  email,
  role,
  organizationName,
  lang,
  onClose,
}: {
  email: string;
  role: "admin" | "member";
  organizationName: string | null;
  lang: string;
  onClose: () => void;
}) {
  const t = dict(lang);
  return (
    <div className="gb-menu" role="menu" aria-label={email}>
      <div className="gb-menu-head">
        <span className="gb-avatar gb-avatar-static" aria-hidden="true">
          {initialOf(email)}
        </span>
        <div className="gb-who">
          <b>{email}</b>
          <span>
            {role === "admin" ? t.nav.roleAdmin : t.nav.roleMember} ·{" "}
            {organizationName ?? t.nav.allOrganizations}
          </span>
        </div>
      </div>
      <hr />
            <a className="gb-mi" role="menuitem" href="/account/agent" onClick={onClose}>
        <Icon name="plug" label={null} size={14} />
        <span>
          {t.nav.myAgent}
          <span className="gb-mi-sub">{t.nav.myAgentSub}</span>
        </span>
      </a>
      {role === "admin" ? (
        <a className="gb-mi" role="menuitem" href="/settings/organizations-projects" onClick={onClose}>
          <Icon name="settings" label={null} size={14} />
          <span>
            {t.nav.settings}
            <span className="gb-mi-sub">{t.nav.settingsSub}</span>
          </span>
        </a>
      ) : null}
      <hr />
      <ThemePicker t={t} />
      <hr />
      <form action={logoutAction}>
        <button className="gb-mi" role="menuitem" type="submit">
          <Icon name="logout" label={null} size={14} />
          <span>{t.nav.logout}</span>
        </button>
      </form>
    </div>
  );
}

function initialOf(email: string): string {
  return (email.trim()[0] ?? "?").toUpperCase();
}

/**
 * The global bar (navigation plan E1, Alternative A): the wordmark, the
 * places, the two work-state chips and the avatar, the same on every signed-in
 * page. On the phone the places and the review count go down to a bottom bar,
 * where "to review" is a tab of its own: it never leaves the screen.
 *
 * The numbers are counted by scope and role only (the F1 contract). On the
 * board they ride on its 20 s poll; anywhere else the bar asks every 60 s.
 */
export function GlobalBarClient({
  current,
  lang,
  email,
  role,
  organizationName,
  counts: initialCounts,
  reviewing: reviewingProp = false,
}: {
  current: GlobalPlace | null;
  lang: string;
  email: string;
  role: "admin" | "member";
  organizationName: string | null;
  counts: GlobalCounts;
  /** The To review list is on screen: its chip and its tab read as current. */
  reviewing?: boolean;
}) {
  const t = dict(lang);
  // The layout cannot read the query; the bar can. /board?status=feito is the
  // review list, under the Board place.
  const params = useSearchParams();
  const reviewing = reviewingProp || (current === "board" && params?.get("status") === "feito");
  const [counts, setCounts] = useState(initialCounts);
  const [open, setOpen] = useState(false);
  const account = useRef<HTMLDivElement | null>(null);
  const admin = role === "admin";
  // The board polls every 20 s and publishes the counts with its answer.
  const ownPoll = current !== "board" || reviewing;

  // A server render (navigation, router.refresh) brings fresher numbers.
  useEffect(() => setCounts(initialCounts), [initialCounts.running, initialCounts.review]);

  useEffect(() => subscribeGlobalCounts(setCounts), []);

  useEffect(() => {
    if (!ownPoll) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void globalBarCountsAction().then(
        (next) => {
          if (next) setCounts(next);
        },
        () => {},
      );
    };
    const id = window.setInterval(tick, GLOBAL_COUNTS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [ownPoll]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!account.current?.contains(event.target as Node)) setOpen(false);
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

  const placeLabel = { board: t.nav.board, missions: t.nav.missions, usage: t.nav.usage };
  const here = (key: GlobalPlace) =>
    current === key && !(key === "board" && reviewing) ? ("page" as const) : undefined;
  const reviewLabel = admin ? t.nav.reviewCount(counts.review) : t.nav.reviewCountMember(counts.review);

  return (
    <>
      <header className="global-bar">
        <div className="gb-row">
          <Wordmark label={t.board.homeLink} />
          <nav className="gb-places" aria-label={t.nav.places}>
            {PLACES.map((place) => (
              <a key={place.key} className="gb-place" href={place.href} aria-current={here(place.key)}>
                <Icon name={place.icon} label={null} size={14} />
                <span>{placeLabel[place.key]}</span>
              </a>
            ))}
          </nav>
          <div className="gb-right">
            <a
              className="gb-chip gb-chip-run"
              href="/board#board-col-em_execucao"
              aria-label={t.nav.running(counts.running)}
              title={t.nav.running(counts.running)}
            >
              <StatusMark status="em_execucao" />
              <span className="gb-n">{counts.running}</span>
              <span className="gb-lbl">{t.nav.runningLabel}</span>
            </a>
            <a
              className={`gb-chip gb-chip-review${admin ? " attention" : ""}${reviewing ? " on" : ""}`}
              href={REVIEW_HREF}
              aria-label={reviewLabel}
              aria-current={reviewing ? "page" : undefined}
            >
              <StatusMark status="feito" />
              <span className="gb-n">{counts.review}</span>
              <span className="gb-lbl-rev">{admin ? t.nav.review : t.nav.reviewAwaiting}</span>
            </a>
            <div className="gb-account" ref={account}>
              <button
                type="button"
                className="gb-avatar"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t.nav.account(email)}
                onClick={() => setOpen((value) => !value)}
              >
                {initialOf(email)}
              </button>
              {open ? (
                <AvatarMenu
                  email={email}
                  role={role}
                  organizationName={organizationName}
                  lang={lang}
                  onClose={() => setOpen(false)}
                />
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <nav className="gb-tabbar" aria-label={t.nav.places}>
        <a className="gb-tab" href="/board" aria-current={here("board")}>
          <Icon name="board" label={null} size={20} />
          <span>{t.nav.board}</span>
        </a>
        <a className="gb-tab" href="/missions" aria-current={here("missions")}>
          <Icon name="mission" label={null} size={20} />
          <span>{t.nav.missions}</span>
        </a>
        <a
          className="gb-tab gb-tab-review"
          href={REVIEW_HREF}
          aria-current={reviewing ? "page" : undefined}
          aria-label={reviewLabel}
        >
          <Icon name="toReview" label={null} size={20} />
          <span>{admin ? t.nav.reviewTab : t.nav.reviewTabMember}</span>
          {counts.review > 0 ? (
            <span className={`gb-tab-badge${admin ? " attention" : ""}`}>{counts.review}</span>
          ) : null}
        </a>
        <a className="gb-tab" href="/usage" aria-current={here("usage")}>
          <Icon name="insights" label={null} size={20} />
          <span>{t.nav.usage}</span>
        </a>
      </nav>
    </>
  );
}
