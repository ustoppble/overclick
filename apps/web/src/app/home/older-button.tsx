import type { Dict } from "../../lib/i18n";

/**
 * "Show older" at the top of a column: how many cards lie past what the
 * column shows is the button's own label, short enough to hold one line in the
 * narrowest column, and the page it brings in is its tooltip. One 32px control
 * whatever the number, so it sits at the same place in all five columns.
 */
export function OlderButton({
  left,
  pageSize,
  loading,
  disabled,
  onClick,
  t,
}: {
  left: number;
  pageSize: number;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  t: Dict;
}) {
  const page = t.board.showOlder(Math.min(left, pageSize));
  const count = t.board.olderCount(left);
  return (
    <button
      type="button"
      className="btn-ghost col-more"
      disabled={disabled}
      title={page}
      aria-label={`${page} — ${count}`}
      onClick={onClick}
    >
      <span>{loading ? t.board.loadingOlder : count}</span>
    </button>
  );
}
