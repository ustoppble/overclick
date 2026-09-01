/**
 * The one place numbers become text (ux-v2.md §4). Topbar stat, board card,
 * detail panel and Insights all read from here, so a figure can never be
 * spelled two ways on the same screen.
 *
 * Rules from the doctrine: money carries its currency per locale (`US$` in
 * pt-BR, `$` in en) and always two decimals; tokens spell `175M`/`94.8M`/`12k`;
 * duration spells `4h14`/`33m`/`58s`; a null price is "no price", never `$0`.
 */
import type { Lang } from "./i18n";

const LOCALES: Record<Lang, string> = { en: "en-US", "pt-BR": "pt-BR" };

/**
 * Money with the currency explicit in the workspace's locale. Intl does the
 * symbol and the separators: `US$ 27,10` in pt-BR, `$27.10` in en.
 */
export function formatMoney(value: number, lang: Lang): string {
  return new Intl.NumberFormat(LOCALES[lang], {
    style: "currency",
    currency: "USD",
  }).format(value);
}

/**
 * A cost that may not exist. Null is not zero: it means no attempt here could
 * be priced, and printing $0.00 would sell unpriced work as free.
 */
export function formatMoneyOrNone(
  value: number | null,
  none: string,
  lang: Lang,
): string {
  return value == null ? none : formatMoney(value, lang);
}

/** `12.5B` / `175M` / `94.8M` / `12k` / `950`. The unit word, when there is
 *  room for one, is the call site's to spend. The billion step exists because
 *  a board that runs for a few months reaches it, and `12519.1M` makes the
 *  reader count digits to find the order of magnitude. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1).replace(".0", "")}B`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(".0", "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

/** `4h14` / `33m` / `58s`: the unit the number can honestly claim. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

/**
 * Elapsed time, rounded to the unit it can honestly claim. A claim that sat
 * open for two days is not precise to the minute.
 */
export function formatElapsed(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 72) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * The tilde says the number is not exact: an estimate the agent volunteered,
 * or a price the board worked out from a table. One symbol replaces the word
 * "estimated"; the stat popover says how many rides behind it.
 */
export function approx(text: string, isApprox: boolean): string {
  return isApprox ? `~${text}` : text;
}
