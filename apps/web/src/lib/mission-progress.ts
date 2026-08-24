/**
 * The 4-colour read of a mission's cards (OCL-138): how much of it is done,
 * and the stacked breakdown that earns that number. `descartado` is not an
 * input here on purpose — a discarded card was never going to ship, so it
 * counts toward neither the total nor the percentage.
 */
export type MissionStatusCounts = {
  aberto: number;
  em_execucao: number;
  feito: number;
  validado: number;
};

export type MissionProgressStatus = keyof MissionStatusCounts;

export const MISSION_PROGRESS_ORDER: readonly MissionProgressStatus[] = [
  "aberto",
  "em_execucao",
  "feito",
  "validado",
];

export type MissionProgressSegment = {
  status: MissionProgressStatus;
  count: number;
  /** Share of the segment within the counted total, 0-100, rounded. */
  pct: number;
};

export type MissionProgress = {
  /** Cards counted: every status above, discarded excluded. */
  total: number;
  /** feito + validado. */
  done: number;
  /** done / total, 0-100, rounded. Zero on an empty mission. */
  pct: number;
  segments: readonly MissionProgressSegment[];
};

function pctOf(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

export function missionProgress(counts: MissionStatusCounts): MissionProgress {
  const total =
    counts.aberto + counts.em_execucao + counts.feito + counts.validado;
  const done = counts.feito + counts.validado;
  const segments = MISSION_PROGRESS_ORDER.map((status) => ({
    status,
    count: counts[status],
    pct: pctOf(counts[status], total),
  }));
  return { total, done, pct: pctOf(done, total), segments };
}
