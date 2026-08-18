import { pgEnum } from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", [
  "aberto",
  "em_execucao",
  "feito",
  "validado",
  "descartado",
]);

export const taskTypeEnum = pgEnum("task_type", ["feature", "bug", "rfc"]);

export const taskPriorityEnum = pgEnum("task_priority", [
  "urgente",
  "alta",
  "media",
  "baixa",
]);

export const reviewerKindEnum = pgEnum("reviewer_kind", [
  "human",
  "agent",
  "workspace_queue",
]);

export const executionModeEnum = pgEnum("execution_mode", ["solo", "team"]);

export const missionStatusEnum = pgEnum("mission_status", [
  "ativa",
  "pausada",
  "concluida",
]);
