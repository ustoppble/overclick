import { describe, expect, it } from "vitest";
import {
  BASE_THEME,
  DEFAULT_THEME,
  THEMES,
  THEME_BOOT_SCRIPT,
  THEME_COOKIE,
  isTheme,
  resolveTheme,
  themeCookieValue,
  themeFromCookieHeader,
} from "./theme";

describe("themes", () => {
  it("ships exactly the three the doctrine names, in the order the picker shows them", () => {
    expect([...THEMES]).toEqual(["xai", "overclock", "nebula"]);
  });

  it("opens on xai for anyone who never chose, members included (navigation plan E7)", () => {
    expect(DEFAULT_THEME).toBe("xai");
  });

  it("keeps nebula as the base: the contract every theme overrides, on :root", () => {
    // What a newcomer sees and what the CSS falls back to are two answers
    // now. The base declares every token; the default is just a choice.
    expect(BASE_THEME).toBe("nebula");
    expect(DEFAULT_THEME).not.toBe(BASE_THEME);
  });

  it("recognises the three and nothing else", () => {
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
    expect(isTheme("Nebula")).toBe(false);
    expect(isTheme("")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(42)).toBe(false);
  });

  it("falls back to the default for an unknown, missing or tampered value", () => {
    expect(resolveTheme("xai")).toBe("xai");
    expect(resolveTheme("overclock")).toBe("overclock");
    expect(resolveTheme("whatever")).toBe(DEFAULT_THEME);
    expect(resolveTheme("")).toBe(DEFAULT_THEME);
    expect(resolveTheme(null)).toBe(DEFAULT_THEME);
    expect(resolveTheme(undefined)).toBe(DEFAULT_THEME);
  });
});

describe("the cookie the choice lives in", () => {
  it("reads its own value out of a cookie string that carries others", () => {
    expect(themeFromCookieHeader(`ab_session=x; ${THEME_COOKIE}=xai; other=1`)).toBe("xai");
    expect(themeFromCookieHeader(`${THEME_COOKIE}=overclock`)).toBe("overclock");
  });

  it("answers the default when there is no cookie at all", () => {
    expect(themeFromCookieHeader("")).toBe("xai");
    expect(themeFromCookieHeader("")).toBe(DEFAULT_THEME);
    expect(themeFromCookieHeader(null)).toBe(DEFAULT_THEME);
    expect(themeFromCookieHeader("ab_session=x")).toBe(DEFAULT_THEME);
  });

  it("answers the default when the value is not a theme, however it got there", () => {
    expect(themeFromCookieHeader(`${THEME_COOKIE}=dracula`)).toBe("xai");
    expect(themeFromCookieHeader(`${THEME_COOKIE}=dracula`)).toBe(DEFAULT_THEME);
    expect(themeFromCookieHeader(`${THEME_COOKIE}=%E0%A4%A`)).toBe(DEFAULT_THEME);
  });

  it("writes a year-long, path-wide, same-site cookie", () => {
    const value = themeCookieValue("xai");
    expect(value).toContain(`${THEME_COOKIE}=xai`);
    expect(value).toContain("Path=/");
    expect(value).toContain("Max-Age=31536000");
    expect(value).toContain("SameSite=Lax");
  });
});

describe("the no-flash boot script", () => {
  it("names every theme it must accept, so the list cannot drift", () => {
    for (const theme of THEMES) expect(THEME_BOOT_SCRIPT).toContain(`"${theme}"`);
    expect(THEME_BOOT_SCRIPT).toContain(THEME_COOKIE);
  });

  /**
   * Running it is the only way to know it does what it claims before a
   * browser paints. A minimal document stand-in is enough: it reads one
   * cookie string and writes one attribute.
   */
  function runBoot(cookie: string): string | null {
    let written: string | null = null;
    const document = {
      cookie,
      documentElement: {
        setAttribute(name: string, value: string) {
          if (name === "data-theme") written = value;
        },
      },
    };
    new Function("document", THEME_BOOT_SCRIPT)(document);
    return written;
  }

  it("puts the stored theme on the root element", () => {
    expect(runBoot(`${THEME_COOKIE}=xai`)).toBe("xai");
    expect(runBoot(`ab_session=x; ${THEME_COOKIE}=overclock; k=v`)).toBe("overclock");
  });

  it("puts the default there when nothing is stored or the value is unknown", () => {
    expect(runBoot("")).toBe("xai");
    expect(runBoot(`${THEME_COOKIE}=nebula`)).toBe("nebula");
    expect(runBoot("ab_session=x")).toBe(DEFAULT_THEME);
    expect(runBoot(`${THEME_COOKIE}=dracula`)).toBe(DEFAULT_THEME);
  });

  it("never throws, so a browser without cookies still renders", () => {
    expect(() =>
      new Function("document", THEME_BOOT_SCRIPT)({
        get cookie(): string {
          throw new Error("cookies are disabled");
        },
        documentElement: { setAttribute() {} },
      }),
    ).not.toThrow();
  });
});
