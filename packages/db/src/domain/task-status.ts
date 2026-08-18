export const TASK_STATUSES = [
  "aberto",
  "em_execucao",
  "feito",
  "validado",
  "descartado",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Actor = "human" | "agent";

export type TransitionOptions = {
  hasComment?: boolean;
  force?: boolean;
};

export function canTransition(
  from: TaskStatus,
  to: TaskStatus,
  actor: Actor,
  options: TransitionOptions = {},
): boolean {
  if (from === "aberto" && to === "em_execucao") return true;
  if (from === "em_execucao" && to === "feito") return true;

  if (from === "em_execucao" && to === "aberto") {
    return actor === "human" || options.force === true;
  }

  if (from === "feito" && to === "aberto") {
    return options.hasComment === true;
  }

  if (from === "feito" && to === "validado") {
    return actor === "human";
  }

  return false;
}

export function canMarkRevisado(status: TaskStatus): boolean {
  return status === "feito";
}
