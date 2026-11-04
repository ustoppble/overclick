"use client";

import { useEffect, useState } from "react";
import type { Dict } from "../../lib/i18n";
import {
  DEFAULT_THEME,
  THEMES,
  type Theme,
  themeCookieValue,
  themeFromCookieHeader,
} from "../../lib/theme";

/**
 * The theme selector, inside the account menu (OCL-56).
 *
 * Three radio options, not a dropdown: with three answers a menu inside a
 * menu is a second click for nothing, and the current theme should be
 * readable without opening anything else.
 *
 * The switch is one attribute write on <html>, so it lands on the same frame
 * as the click: no reload, no server round trip, no re-render of the board.
 * The cookie is written beside it, which is what survives F5 and what the
 * boot script in the root layout reads before the next paint.
 *
 * It starts on the default and corrects itself in an effect on purpose: the
 * server renders this markup without seeing document.cookie, so reading the
 * cookie during render would hydrate one answer over another one.
 */
export function ThemePicker({ t }: { t: Dict }) {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setTheme(themeFromCookieHeader(document.cookie));
  }, []);

  function choose(next: Theme) {
    document.documentElement.setAttribute("data-theme", next);
    document.cookie = themeCookieValue(next);
    setTheme(next);
  }

  return (
    <div className="am-theme" role="group" aria-label={t.board.theme}>
      <span className="am-theme-lbl">{t.board.theme}</span>
      <div className="am-theme-opts">
        {THEMES.map((value) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={theme === value}
            className={theme === value ? "am-theme-opt on oc-tappable" : "am-theme-opt oc-tappable"}
            onClick={() => choose(value)}
          >
            {t.board.themeName[value]}
          </button>
        ))}
      </div>
    </div>
  );
}
