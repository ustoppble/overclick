import { StatusMark } from "../../components/status-mark";
import type { ColumnStatus } from "../../lib/board-columns";
import type { Dict } from "../../lib/i18n";

/**
 * A mission's state with the board's own marks (variant A): running for an
 * active one, the queue's ring for a paused one (it waits, nothing waits on
 * the reader), validated for a completed one.
 */
const MARK: Record<"ativa" | "pausada" | "concluida", ColumnStatus> = {
  ativa: "em_execucao",
  pausada: "aberto",
  concluida: "validado",
};

export function MissionStatus({
  status,
  t,
}: {
  status: "ativa" | "pausada" | "concluida";
  t: Dict;
}) {
  const label =
    status === "pausada"
      ? t.board.missionStatusPaused
      : status === "concluida"
        ? t.board.missionStatusCompleted
        : t.board.missionStatusActive;
  return (
    <span className="ms-status">
      <StatusMark status={MARK[status]} />
      {label}
    </span>
  );
}
