import { err, ok, type Result } from "../errors.js";

export const CARD_STATUSES = [
  "aberto",
  "em_execucao",
  "feito",
  "validado",
  "descartado",
] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_EVENTS = [
  "claim",
  "force_claim",
  "handoff",
  "validate",
  "reopen",
  "mark_revisado",
  "force_reopen",
] as const;

export type CardEventType = (typeof CARD_EVENTS)[number];

export type CardEvent =
  | { type: "claim" }
  | { type: "force_claim" }
  | { type: "handoff" }
  | { type: "validate"; actor: "human" | "agent" }
  | { type: "reopen"; comment: string }
  | { type: "mark_revisado" }
  | { type: "force_reopen" };

export type CardSnapshot = {
  status: CardStatus;
  revisado: boolean;
  reopen_comment: string | null;
};

const VALID_EVENTS: Record<CardStatus, readonly CardEventType[]> = {
  aberto: ["claim"],
  em_execucao: ["handoff", "force_claim", "force_reopen"],
  feito: ["validate", "reopen", "mark_revisado"],
  validado: [],
  descartado: [],
};

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

// Error messages speak the caller's language (tool names and next steps),
// never internal event names like "handoff" or "force_claim".
const STATUS_LABEL: Record<CardStatus, string> = {
  aberto: "open",
  em_execucao: "in execution",
  feito: "delivered and waiting for review",
  validado: "validated and closed",
  descartado: "discarded and continued by another card",
};

const NEXT_STEP: Record<CardEventType, string> = {
  claim: "task_claim",
  force_claim: "task_claim with force: true",
  handoff: "task_deliver",
  validate: "validation by a human in the board UI",
  reopen: "reopen with a comment in the board UI",
  mark_revisado: "task_update with revisado: true",
  force_reopen: "force reopen in the board UI",
};

function invalidTransitionMessage(
  card: CardSnapshot,
  event: CardEvent,
): string {
  if (event.type === "handoff" && card.status === "aberto") {
    return "Card is open, call task_claim before task_deliver.";
  }
  if (event.type === "handoff" && card.status === "feito") {
    return "Card is already delivered and waiting for review. To deliver again, reopen it in the board UI and call task_claim first.";
  }
  if (event.type === "claim" && card.status === "feito") {
    return "Card is already delivered and waiting for review, so task_claim is not available. Reopen it in the board UI to work on it again.";
  }
  const steps = VALID_EVENTS[card.status].map((type) => NEXT_STEP[type]);
  return steps.length > 0
    ? `Card is ${STATUS_LABEL[card.status]}. Available next steps: ${steps.join(", ")}.`
    : `Card is ${STATUS_LABEL[card.status]}. No further transitions are possible.`;
}

export function listValidEvents(card: CardSnapshot): CardEventType[] {
  return [...VALID_EVENTS[card.status]];
}

export function isValidTransition(
  card: CardSnapshot,
  event: CardEvent,
): boolean {
  if (event.type === "reopen" && isBlank(event.comment)) {
    return false;
  }
  if (event.type === "validate" && event.actor !== "human") {
    return false;
  }
  return VALID_EVENTS[card.status].includes(event.type);
}

export function applyTransition(
  card: CardSnapshot,
  event: CardEvent,
): Result<CardSnapshot> {
  if (event.type === "reopen" && isBlank(event.comment)) {
    return err(
      "REOPEN_COMMENT_REQUIRED",
      "Reopening requires a comment. The agent receives it on the next task_claim.",
    );
  }

  if (!VALID_EVENTS[card.status].includes(event.type)) {
    if (event.type === "claim" && card.status === "em_execucao") {
      return err(
        "ALREADY_CLAIMED",
        "Card is already in execution. Call task_claim with force: true to take over the attempt.",
        { from: card.status, event: event.type },
      );
    }
    return err(
      "INVALID_TRANSITION",
      invalidTransitionMessage(card, event),
      { from: card.status, event: event.type },
    );
  }

  if (event.type === "validate" && event.actor !== "human") {
    return err(
      "VALIDATION_HUMAN_ONLY",
      "Only a human in the board UI can mark the card as validated.",
      { from: card.status, event: event.type, actor: event.actor },
    );
  }

  switch (event.type) {
    case "claim":
      return ok({ ...card, status: "em_execucao" });
    case "force_claim":
      return ok({ ...card, status: "em_execucao" });
    case "handoff":
      return ok({
        ...card,
        status: "feito",
        revisado: false,
        reopen_comment: null,
      });
    case "validate":
      return ok({ ...card, status: "validado" });
    case "reopen":
      return ok({
        ...card,
        status: "aberto",
        revisado: false,
        reopen_comment: event.comment.trim(),
      });
    case "mark_revisado":
      return ok({ ...card, revisado: true });
    case "force_reopen":
      return ok({ ...card, status: "aberto", revisado: false });
  }
}
