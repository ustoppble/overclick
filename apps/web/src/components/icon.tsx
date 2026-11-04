import type { ReactElement } from "react";

/**
 * The icon set of the app (AGB-73).
 *
 * One source, bundled. Every glyph in this file is inline SVG shipped with
 * the page: no sprite to fetch, no font to load, no CDN, nothing that can be
 * missing on an instance behind a firewall or slow on the first paint. The
 * board is self-hosted software and its own icons are not something it should
 * have to ask the internet for.
 *
 * One weight and one optical size. Every glyph is drawn in the same 24 box,
 * with the same 1.75 stroke, the same round cap and join, and no fill: a set
 * where one icon is heavier than the next reads as a collection of borrowed
 * pieces, which is what the app had. The stroke is a constant here and not a
 * prop on purpose, because a weight that callers may pick is not one weight.
 *
 * The Nebula palette comes for free: the stroke is currentColor, so an icon
 * takes the colour of the text it sits beside and stays inside the system
 * without ever naming a hex value.
 *
 * An icon never replaces a label that carries information. It sits beside the
 * word, or it stands alone only where the meaning is unmistakable, and it is
 * always reachable by name: `label` is required, so an icon can only be
 * silent when the caller says so, by passing null, and null is for the case
 * where a visible word or an aria-label right beside it already says the same
 * thing. Repeating it would make a screen reader say it twice.
 */

/** The one stroke of the set. Not a prop: a weight callers pick is not one. */
const STROKE = 1.75;

/** The one box every glyph is drawn in, so the optical size is shared. */
const VIEW_BOX = "0 0 24 24";

/**
 * The art, keyed by what the icon means in this product rather than by what
 * it looks like: `columnRunning` survives a redraw, `playCircle` does not.
 */
const ART = {
  // ---------- the affordances that were words or punctuation ----------
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  back: (
    <>
      <path d="M19.5 12h-15" />
      <path d="M10.5 6l-6 6 6 6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2.5" />
      <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4h8a1.5 1.5 0 0 1 1.5 1.5V6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="M15.8 15.8l4.4 4.4" />
    </>
  ),
  /** Clearing a filter: the choice is dropped, the filter itself stays. */
  clear: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.3 9.3l5.4 5.4M14.7 9.3l-5.4 5.4" />
    </>
  ),
  filter: <path d="M3.5 5h17l-6.6 7.9V19l-3.8-2.3v-3.8z" />,
  /** A menu with more in it than the bar has room for: the three dots. */
  more: (
    <>
      <circle cx="5" cy="12" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="19" cy="12" r="1.1" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronUp: <path d="M6 14.5l6-6 6 6" />,
  chevronLeft: <path d="M14.5 6l-6 6 6 6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  check: <path d="M4.5 12.5l5 5 10-10" />,
  // the board's Selecionar mode (navigation plan E6): a box already ticked
  select: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M17.5 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h4.5" />
    </>
  ),
  /** Nothing here yet: the shape of a container with no contents. */
  empty: (
    <>
      <path d="M3.5 8.2L12 3.8l8.5 4.4v7.6L12 20.2l-8.5-4.4z" />
      <path d="M3.5 8.2L12 12.6l8.5-4.4M12 12.6v7.6" />
    </>
  ),

  // ---------- the four columns of the board, and the same four statuses ----------
  /** Open: a tray with work waiting in it. */
  columnOpen: (
    <>
      <path d="M3.5 13.5h4.8l1.4 2.4h4.6l1.4-2.4h4.8" />
      <path d="M6 4.5h12l2.5 9v4.4a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6v-4.4z" />
    </>
  ),
  /** In progress: something is running right now. */
  columnRunning: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.3 8.6l5.4 3.4-5.4 3.4z" />
    </>
  ),
  /** Done: delivered, and waiting for the human who has to check it. */
  columnDone: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.2l2.6 2.6 5.2-5.2" />
    </>
  ),
  /** Validated: checked, and checked again. The second tick is the stamp. */
  columnValidated: (
    <>
      <path d="M2.5 12.6l4.2 4.2 7.8-7.8" />
      <path d="M10.4 15.6l1.4 1.4 8.2-8.2" />
    </>
  ),

  // ---------- one mark per settings tab ----------
  tabExecutors: (
    <>
      <rect x="2.8" y="4.2" width="18.4" height="15.6" rx="2.5" />
      <path d="M7 9.6l3 2.4-3 2.4M12.6 15h4.4" />
    </>
  ),
  tabPolicy: <path d="M12 3.2l7.6 3v5.6c0 4.3-3 7.7-7.6 9.6-4.6-1.9-7.6-5.3-7.6-9.6V6.2z" />,
  tabPrices: (
    <>
      <path d="M3.5 11.2V5a1.5 1.5 0 0 1 1.5-1.5h6.2l9 9a1.6 1.6 0 0 1 0 2.3l-6.4 6.4a1.6 1.6 0 0 1-2.3 0z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  tabRecipes: <path d="M4 6.5h3M4 12h3M4 17.5h3M10.5 6.5h9.5M10.5 12h9.5M10.5 17.5h9.5" />,
  tabTokens: (
    <>
      <circle cx="8" cy="15.4" r="4.6" />
      <path d="M11.4 12.2L20 3.6M16.6 7l2.2 2.2M14.3 9.3l2.2 2.2" />
    </>
  ),
  tabLanguage: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.5c2.3 2.4 3.4 5.4 3.4 8.5S14.3 18.1 12 20.5c-2.3-2.4-3.4-5.4-3.4-8.5S9.7 5.9 12 3.5z" />
    </>
  ),
  tabUpdates: (
    <>
      <path d="M12 3.5v11" />
      <path d="M7.6 10.2l4.4 4.3 4.4-4.3" />
      <path d="M4.5 19.5h15" />
    </>
  ),

  // ---------- what the detail panel is made of ----------
  /** What the card asks for: the written contract, on its clipboard. */
  spec: (
    <>
      <path d="M9 4.6H7a2 2 0 0 0-2 2v12.4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.6a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="2.8" width="6" height="3.6" rx="1.3" />
      <path d="M8.6 11.2h6.8M8.6 14.8h4.6" />
    </>
  ),
  /** Why the card exists. */
  reason: (
    <>
      <path d="M9.2 16.1a6.4 6.4 0 1 1 5.6 0v2a1.4 1.4 0 0 1-1.4 1.4h-2.8a1.4 1.4 0 0 1-1.4-1.4z" />
      <path d="M10.3 21.4h3.4" />
    </>
  ),
  /** How the card gets confirmed: the steps, each with its tick. */
  checklist: (
    <>
      <path d="M3.2 6.4l1.9 1.9 3-3.4" />
      <path d="M3.2 12.9l1.9 1.9 3-3.4" />
      <path d="M3.2 19.4l1.9 1.9 3-3.4" />
      <path d="M11.4 6.4h9.4M11.4 12.9h9.4M11.4 19.4h9.4" />
    </>
  ),
  mission: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.8" />
    </>
  ),
  harness: (
    <>
      <rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2" />
      <path d="M10 3.4v3.2M14 3.4v3.2M10 17.4v3.2M14 17.4v3.2M3.4 10h3.2M3.4 14h3.2M17.4 10h3.2M17.4 14h3.2" />
    </>
  ),
  roles: (
    <>
      <circle cx="9" cy="8.4" r="3.6" />
      <path d="M2.8 19.8c0-3.4 2.8-5.6 6.2-5.6s6.2 2.2 6.2 5.6" />
      <path d="M16.4 5.4a3.6 3.6 0 0 1 0 6" />
      <path d="M18 14.6c1.9.8 3.2 2.6 3.2 5.2" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5.4" r="2.6" />
      <circle cx="7" cy="18.6" r="2.6" />
      <circle cx="17" cy="8.8" r="2.6" />
      <path d="M7 8v8" />
      <path d="M17 11.4c0 3.1-2.7 4.6-6.2 4.6" />
    </>
  ),
  telemetry: <path d="M3 12.6h4l3-8.2 4 15.2 3-7h4" />,
  transcript: (
    <>
      <path d="M13.6 3.2H7a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.6z" />
      <path d="M13.6 3.2v5.4H19" />
      <path d="M8.4 13h7.2M8.4 16.4h4.8" />
    </>
  ),
  handoff: <path d="M20.5 14.4a2 2 0 0 1-2 2H8.4l-4.9 4V5.6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />,
  timeline: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 6.8v5.5l3.4 2" />
    </>
  ),

  // ---------- the rest of the shell ----------
  insights: (
    <>
      <path d="M4 3.8V20h16" />
      <path d="M8 16.4v-4.2M12.4 16.4V7.6M16.8 16.4v-6.4" />
    </>
  ),
  settings: (
    <>
      <path d="M3.8 7.2h8.4M17 7.2h3.2M3.8 16.8h3.2M12 16.8h8.2" />
      <circle cx="14.6" cy="7.2" r="2.4" />
      <circle cx="9.4" cy="16.8" r="2.4" />
    </>
  ),
  logout: (
    <>
      <path d="M9.6 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.6" />
      <path d="M15 8.4l3.6 3.6L15 15.6" />
      <path d="M18.6 12H9.2" />
    </>
  ),
  /** The board, as a place in the global bar (navigation plan E1). */
  board: (
    <>
      <rect x="3.6" y="4" width="4.8" height="16" rx="1.4" />
      <rect x="10.4" y="4" width="4.8" height="11" rx="1.4" />
      <rect x="17.2" y="4" width="3.6" height="7" rx="1.4" />
    </>
  ),
  /** The To review list, as the phone's bottom-bar tab. */
  toReview: (
    <>
      <path d="M4 12.5l5 5 11-11" />
      <path d="M4 6.5h7M4 9.5h4" />
    </>
  ),
  /** My agent: installing, connecting and the person's own tokens. */
  plug: (
    <>
      <path d="M7.6 3.6v4.4M16.4 3.6v4.4" />
      <path d="M5.2 8h13.6v3a6.8 6.8 0 0 1-13.6 0z" />
      <path d="M12 17.8v2.6" />
    </>
  ),
  /** A card that is waiting on the person looking at it. */
  review: (
    <>
      <path d="M5.4 21V3.6" />
      <path d="M5.4 4.6h11.4l-2.1 3.6 2.1 3.6H5.4z" />
    </>
  ),
} as const;

export type IconName = keyof typeof ART;

export type IconProps = {
  name: IconName;
  /**
   * The accessible name. Pass null only when a visible word, or an aria-label
   * on the control the icon sits in, already says the same thing: then the
   * icon is hidden from the reader instead of making it say it twice.
   */
  label: string | null;
  /** Rendered size in px. The art is the same at every one of them. */
  size?: number;
  className?: string;
};

/**
 * One icon. Server-safe, so it renders in a server component as readily as in
 * a client one, and it needs no stylesheet to be the right size: everything
 * that decides how it looks travels with the element.
 */
export function Icon({ name, label, size = 16, className }: IconProps): ReactElement {
  const named = label !== null;
  return (
    <svg
      className={className ? `nb-icon ${className}` : "nb-icon"}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={named ? "img" : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
      focusable="false"
    >
      {ART[name]}
    </svg>
  );
}

/** Every name the set answers to, for a test that wants to walk all of them. */
export const ICON_NAMES = Object.keys(ART) as IconName[];
