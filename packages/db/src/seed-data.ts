import {
  DEFAULT_CARDAPIO,
  DEFAULT_ORGANIZATION_NAME,
  KNOWN_EXECUTORS,
} from "./defaults";
import type { Harness } from "./types";

export const EXAMPLE_WORKSPACE = {
  name: "Agent Board",
  executors: KNOWN_EXECUTORS,
  cardapio: DEFAULT_CARDAPIO,
};

export const EXAMPLE_ORGANIZATION = {
  name: DEFAULT_ORGANIZATION_NAME,
};

export const EXAMPLE_PROJECT = {
  name: "Agent Board",
  repoUrl: null as string | null,
  idPrefix: "AGB",
  nextNumber: 2,
};

export const EXAMPLE_CARD = {
  shortId: "AGB-1",
  title: "Ask your agent to pick up this task",
  oQue:
    'You will type, in your terminal, "pick up the next task from the board". The agent calls task_claim, this card slides to in progress, and when it finishes it comes back as done.',
  porQue:
    "So you see the whole loop before trusting it with real work.",
  comoConfirmo:
    '1) In your terminal, type "pick up the next task from the board". 2) This card changes column on its own. 3) When it finishes, it shows up in done with a summary and telemetry. 4) You click Validate.',
  tipo: "feature" as const,
  status: "aberto" as const,
  isExample: true,
  harness: {
    model: null,
    modelTier: "mid",
    effort: "medium",
  } satisfies Harness,
};
