"use client";

/**
 * Card detail modal loading placeholder.
 *
 * Follows the same two-column anatomy as the real detail panel: head, title,
 * contract sections (what / why / checklist) and the metadata rail.
 */
export function DetailSkeleton() {
  return (
    <div className="ov" aria-busy="true" aria-label="Loading card details">
      <div className="detail sk-detail">
        <div className="sk-detail-head">
          <span className="sk sk-line sk-id sk-shimmer" />
          <span className="sk sk-line sk-location sk-shimmer" />
          <span className="sk sk-line sk-tag sk-shimmer" />
          <span className="sk sk-line sk-status sk-shimmer" />
        </div>

        <h3 className="sk sk-shimmer" />

        <div className="sk-detail-grid">
          <div className="sk-detail-main">
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text medium sk-shimmer" />
            </div>
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
            </div>
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="sk-check">
                  <span className="sk sk-circle sk-shimmer" />
                  <div style={{ flex: 1 }}>
                    <span className="sk sk-line sk-shimmer" />
                    <span className="sk sk-line sk-shimmer" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="sk-detail-rail">
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
            </div>
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text medium sk-shimmer" />
            </div>
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
            </div>
            <div className="sk-detail-sec">
              <div className="sk sk-line sk-label sk-shimmer" />
              <span className="sk sk-text sk-shimmer" />
              <span className="sk sk-text medium sk-shimmer" />
            </div>
          </div>
        </div>

        <div className="sk-detail-actions">
          <span className="sk sk-btn sk-shimmer" />
          <span className="sk sk-btn sk-shimmer" />
        </div>
      </div>
    </div>
  );
}
