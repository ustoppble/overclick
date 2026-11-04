/**
 * The board's themes (OCL-56).
 *
 * A theme is a file of `--oc-*` values in styles/themes/ and an attribute on
 * the root element. Nothing else: no component knows which theme is on, no
 * layout changes, and switching is one attribute write.
 *
 * Where the choice is kept: a cookie. The board filter and the language are
 * rows in the database because they belong to a user and to a workspace; a
 * theme belongs to the screen a person is looking at, and it has to be
 * readable before React exists, on the login screen where there is no user
 * yet. A cookie answers both — it survives the reload, and the boot script
 * below reads it before the first paint, so no one ever sees the wrong
 * theme flash into the right one.
 *
 * `prefers-color-scheme` is deliberately ignored: every theme here is dark.
 */

/** In the order the account menu offers them: x.ai · Overclock · Nebula. */
export const THEMES = ["xai", "overclock", "nebula"] as const;

export type Theme = (typeof THEMES)[number];

/**
 * The contract (navigation plan E7). nebula's file is the one on `:root`: it
 * declares every token, every other theme overrides part of it, and an
 * unknown `data-theme` still draws with it. It stays the base even though it
 * is no longer what anyone sees first, so the guards in `tokens.test.ts`
 * read the contract from here and not from the default.
 */
export const BASE_THEME: Theme = "nebula";

/**
 * What a person who never chose sees, members included, and what an
 * unknown, missing or tampered value falls back to (E7, owner's decision 8).
 */
export const DEFAULT_THEME: Theme = "xai";

export const THEME_COOKIE = "oc-theme";

/** A year: a preference nobody re-states should not quietly expire. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * The only way a theme name enters the app. Anything that is not one of the
 * three is the default. The CSS has a fallback of its own underneath this
 * (an unknown `data-theme` matches no theme rule and `:root`, the base,
 * answers), but nothing here ever writes an unknown name to the page.
 */
export function resolveTheme(raw: string | null | undefined): Theme {
  return isTheme(raw) ? raw : DEFAULT_THEME;
}

/** Reads the theme out of a raw `Cookie:`/`document.cookie` string. */
export function themeFromCookieHeader(header: string | null | undefined): Theme {
  if (!header) return DEFAULT_THEME;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== THEME_COOKIE) continue;
    try {
      return resolveTheme(decodeURIComponent(rest.join("=")));
    } catch {
      return DEFAULT_THEME;
    }
  }
  return DEFAULT_THEME;
}

/** The `document.cookie` assignment that persists a choice. */
export function themeCookieValue(theme: Theme): string {
  return `${THEME_COOKIE}=${resolveTheme(theme)}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * The no-flash boot: runs in <head>, before the browser paints anything, and
 * puts the stored theme on <html>. It is generated from the constants above
 * so the list it validates against can never drift from the list the app
 * ships. It touches one attribute and swallows its own errors: a browser
 * with cookies disabled gets the default, not a blank page.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);var t=m?decodeURIComponent(m[1]):"";var ok=${JSON.stringify(
  THEMES,
)};document.documentElement.setAttribute("data-theme",ok.indexOf(t)<0?${JSON.stringify(
  DEFAULT_THEME,
)}:t)}catch(e){}})()`;
