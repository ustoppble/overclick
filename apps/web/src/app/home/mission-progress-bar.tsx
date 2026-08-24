import {
  missionProgress,
  type MissionProgressStatus,
  type MissionStatusCounts,
} from "../../lib/mission-progress";
import type { Dict } from "../../lib/i18n";

const SEGMENT_CLASS: Record<MissionProgressStatus, string> = {
  aberto: "seg-aberto",
  em_execucao: "seg-em-execucao",
  feito: "seg-feito",
  validado: "seg-validado",
};

/**
 * The stacked 4-colour read of a mission (OCL-138): vermelho/aberto,
 * amarelo/em_execucao, verde/feito, azul/validado, plus the % done. Used at
 * two sizes — `sm` in the mission filter list, `lg` in the mission header —
 * so the same computation and the same legend text back both.
 *
 * Colour alone never carries the meaning: `aria-label`/`title` spell out the
 * count behind every segment, and the % is printed text next to the bar, not
 * just its length.
 */
export function MissionProgressBar({
  counts,
  t,
  size = "sm",
}: {
  counts: MissionStatusCounts;
  t: Dict;
  size?: "sm" | "lg";
}) {
  const progress = missionProgress(counts);
  const summary = t.board.missionProgressSummary(counts);
  const label = `${summary} — ${t.board.missionProgressPercent(progress.pct)}`;

  return (
    <div className={`mission-progress mission-progress-${size}`}>
      <div
        className="mission-progress-bar"
        role="img"
        aria-label={label}
        title={label}
      >
        {progress.total === 0 ? (
          <span className="mission-progress-seg seg-empty" style={{ width: "100%" }} />
        ) : (
          progress.segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <span
                key={segment.status}
                className={`mission-progress-seg ${SEGMENT_CLASS[segment.status]}`}
                style={{ width: `${segment.pct}%` }}
              />
            ))
        )}
      </div>
      <span className="mission-progress-pct">
        {t.board.missionProgressPercent(progress.pct)}
      </span>
    </div>
  );
}
