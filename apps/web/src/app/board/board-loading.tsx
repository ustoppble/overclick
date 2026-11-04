import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { BoardSkeleton } from "./board-skeleton";

/**
 * The board's loading fallback, while the server page loads projects, cards
 * and totals: the atmospheric background and a board-shaped skeleton.
 *
 * Not a route-level loading.tsx since E3: that boundary starts the response
 * before the page runs, so a card's address could only answer 200. The page
 * decides /cards/<id> first (a real 307 or 404) and then streams the board
 * behind this fallback.
 */
export function BoardLoading() {
  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />
      <div className="page">
        <header className="topbar topbar-l1 nebula-glass">
          <span className="logo sk sk-shimmer" style={{ width: 120, height: 18 }} />
          <div className="spacer" />
          <span className="sk sk-line sk-shimmer" style={{ width: 110, height: 13 }} />
          <span className="sk sk-line sk-shimmer" style={{ width: 80, height: 13 }} />
          <span className="sk sk-circle sk-shimmer" style={{ width: 28, height: 28 }} />
        </header>
        <header className="topbar-l2">
          <span className="sk sk-line sk-shimmer" style={{ width: 160, height: 12 }} />
          <span className="sk sk-line sk-shimmer" style={{ width: 140, height: 12 }} />
          <span className="sk sk-line sk-shimmer" style={{ width: 240, height: 12 }} />
          <span className="sk sk-line sk-shimmer" style={{ width: 90, height: 12, marginLeft: "auto" }} />
        </header>
        <BoardSkeleton />
      </div>
      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
