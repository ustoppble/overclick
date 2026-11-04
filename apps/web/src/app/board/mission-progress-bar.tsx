import { StatusMark } from "../../components/status-mark";
import {
  missionProgress,
  type MissionProgressStatus,
  type MissionStatusCounts,
} from "../../lib/mission-progress";
import type { Dict } from "../../lib/i18n";

/** The statuses that fill the bar; the queue is the track, never a segment. */
type FilledStatus = Exclude<MissionProgressStatus, "aberto">;

const SEGMENT_CLASS: Record<FilledStatus, string> = {
  em_execucao: "seg-em-execucao",
  feito: "seg-feito",
  validado: "seg-validado",
};

/**
 * What fills the bar, from the most finished: validated, waiting for review,
 * running. The queue is what is left of the track.
 */
const FILLED: readonly FilledStatus[] = ["validado", "feito", "em_execucao"];

/** The legend reads the whole mission, the queue included. */
const LEGEND: readonly MissionProgressStatus[] = [...FILLED, "aberto"];

/**
 * The read of a mission (OCL-138), in variant A since E3: grey only. The
 * validated share in the first ink, then to review in the second and running
 * in the third, on a 10% track that is the queue. Used at two sizes: `sm` in
 * the mission filter and the missions list, `lg` on the mission's page, which
 * adds a legend with the same status marks the board's columns carry.
 *
 * Shade alone never carries the meaning: `aria-label`/`title` spell out the
 * count behind every segment, and the % is printed text next to the bar.
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
  const byStatus = new Map(progress.segments.map((segment) => [segment.status, segment]));

  return (
    <div className={`mission-progress mission-progress-${size}`}>
      <div className="mission-progress-line">
        <div className="mission-progress-bar" role="img" aria-label={label} title={label}>
          {FILLED.map((status) => {
            const segment = byStatus.get(status);
            return segment && segment.count > 0 ? (
              <span
                key={status}
                className={`mission-progress-seg ${SEGMENT_CLASS[status]}`}
                style={{ width: `${segment.pct}%` }}
              />
            ) : null;
          })}
        </div>
        {size === "sm" ? (
          <span className="mission-progress-pct">
            {t.board.missionProgressPercent(progress.pct)}
          </span>
        ) : null}
      </div>
      {size === "lg" ? (
        <div className="mission-progress-legend">
          {LEGEND.map((status) => (
            <span key={status} className="mission-progress-key">
              <StatusMark status={status} />
              <b>{counts[status]}</b>
              {t.board.missionProgressLegend[status]}
            </span>
          ))}
          <span className="mission-progress-pct">
            {t.board.missionProgressPercent(progress.pct)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
