"use client";

/**
 * Board loading placeholder.
 *
 * Mirrors the desktop five-column layout and the mobile list fallback
 * without reusing the real card markup, so the skeleton can stay a pure
 * greyscale block that never flashes status colours.
 */
export function BoardSkeleton() {
  return (
    <div className="board sk-board" aria-busy="true" aria-label="Loading board">
      {Array.from({ length: 5 }).map((_, colIndex) => (
        <div key={colIndex} className="sk-col">
          <div className="sk-col-head">
            <span className="sk sk-circle" />
            <span className="sk sk-line" />
            <span className="sk sk-line sk-count sk-shimmer" />
          </div>
          <div className="col">
            {Array.from({ length: colIndex === 0 ? 2 : colIndex === 1 ? 3 : 1 }).map(
              (__, cardIndex) => (
                <div key={cardIndex} className="sk-card sk-shimmer">
                  <div className="sk-card-body">
                    <div className="sk-id-row">
                      <span className="sk sk-line" />
                    </div>
                    <span className="sk sk-line sk-title" />
                    <span className="sk sk-line sk-title short" />
                    <div className="sk-foot">
                      <span className="sk sk-line" />
                      <span className="sk sk-line" />
                      <span className="sk sk-line" />
                    </div>
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
