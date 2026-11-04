"use client";

/**
 * Insights loading placeholder.
 *
 * Mirrors the page anatomy: two-level topbar, heading, four tiles, subtotals,
 * trend + share charts, four group panels, reopen panel and per-card table.
 */
export function InsightsSkeleton() {
  return (
    <div className="page ins-page sk-ins-page" aria-busy="true" aria-label="Loading insights">
      <header className="sk-ins-topbar">
        <div className="sk-ins-topbar-l1">
          <span className="sk sk-line sk-shimmer" />
          <span className="sk sk-line sk-shimmer" />
        </div>
        <div className="sk-ins-topbar-l2">
          <span className="sk sk-line sk-shimmer" />
        </div>
      </header>

      <header className="sk-ins-head">
        <span className="sk sk-line sk-shimmer" />
        <span className="sk sk-line sk-shimmer" />
      </header>

      <div className="sk-ins-tiles">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="sk-ins-tile sk-shimmer">
            <span className="sk sk-line" />
            <span className="sk sk-line" />
            <span className="sk sk-line" />
          </div>
        ))}
      </div>

      <div className="sk-ins-subtotals nebula-glass">
        <span className="sk sk-line sk-shimmer" />
        <span className="sk sk-line sk-shimmer" />
      </div>

      <div className="sk-ins-charts">
        <section className="sk-ins-panel sk-shimmer">
          <span className="sk sk-line" />
          <span className="sk sk-bar" />
        </section>
        <section className="sk-ins-panel sk-shimmer">
          <span className="sk sk-line" />
          <span className="sk sk-bar" />
        </section>
      </div>

      <div className="sk-ins-grid">
        {Array.from({ length: 5 }).map((_, i) => (
          <section key={i} className="sk-ins-panel sk-shimmer">
            <span className="sk sk-line" />
            {Array.from({ length: 5 }).map((__, j) => (
              <div key={j} className="sk-table-row">
                <span className="sk sk-line" />
                <span className="sk sk-line" />
                <span className="sk sk-line" />
                <span className="sk sk-line" />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
