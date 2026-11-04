"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { assignCardsToMissionAction } from "../../actions/missions";
import { releaseClaimAction } from "../../actions/claims";
import { loadBoardCardDetailAction } from "../../actions/board-cards";
import { discardTaskAction } from "../../actions/discard";
import {
  answerOpenTaskAction,
  reopenTaskAction,
  tickValidationStepAction,
  validateTaskAction,
} from "../../actions/review";
import {
  COLUMN_STATUSES,
  type ColumnCounts,
  type ColumnStatus,
} from "../../lib/board-columns";
import { cardIdFromPath, cardPath } from "../../lib/card-path";
import { pickRowNumber, typeInitial } from "../../lib/board-row";
import { formatShortDateTime } from "../../lib/format";
import { dict, type Dict } from "../../lib/i18n";
import { CliMark } from "../../components/cli-mark";
import { StatusMark } from "../../components/status-mark";
import { Markdown } from "../../components/markdown";
import { Icon, type IconName } from "../../components/icon";
import { BoardMobileList } from "./board-mobile-list";
import { DetailSkeleton } from "./detail-skeleton";

export type BoardMissionOption = {
  id: string;
  title: string;
  status: "ativa" | "pausada" | "concluida";
  objective: string;
  context: string;
  counts: {
    total: number;
    aberto: number;
    em_execucao: number;
    feito: number;
    validado: number;
  };
};

export type ConfirmStep = { step: string; expected: string };
export type ValidationTickView = { index: number; byEmail: string; at: string };
/**
 * Where the run's transcript lives, plus the two commands that act on it.
 * The board holds the pointer only: the file itself never left the machine
 * that ran the card, which is also the only place these commands work.
 */
export type TranscriptView = {
  cli: string | null;
  sessionId: string | null;
  path: string | null;
  /** Reopens the session in that CLI. Null when the CLI has no known flag. */
  resume: string | null;
  /** Recipe command pinned to this transcript. Null without a path. */
  usageCommand: string | null;
};

/**
 * The two clocks of a run, already formatted. Execution is what the agent
 * reported working; elapsed is claim to deliver as the board measured it. The
 * card line shows one of them, the panel shows both with their sources.
 */
export type DurationView = {
  execution: string | null;
  elapsed: string | null;
};

/**
 * One value of the dense card line, already spelled short. `kind` is what the
 * layout sorts by when the column runs out of room: tokens are the first to be
 * elided, because a card that hides its cost or its clock has lost more.
 */
export type TelemetrySegment = {
  kind: "duration" | "tokens" | "cost" | "note";
  text: string;
};

export type TimelineEntry = {
  kind:
    | "executor_swap"
    | "spawn_failure"
    | "report"
    | "comment"
    | "validation"
    | "claim_release"
    | "claim_stale";
  body: string;
  author: string | null;
  at: string;
};

/**
 * A card as the board's list carries it: what its line, the filters and the
 * topbar read. Everything only the detail panel shows comes apart, in
 * BoardCardDetail, when the card is opened, so "all time" stays a list of
 * summaries instead of every handoff, comment and transcript on the board.
 */
export type BoardCard = {
  id: string;
  shortId: string;
  /** ISO timestamps: the column order, and the dates the period reads. */
  createdAt: string;
  updatedAt: string;
  title: string;
  tipo: "feature" | "bug" | "rfc";
  priority: "urgente" | "alta" | "media" | "baixa";
  status: "aberto" | "em_execucao" | "feito" | "validado" | "descartado";
  supersedes: { id: string; shortId: string } | null;
  supersededBy: { id: string; shortId: string } | null;
  isExample: boolean;
  /** The business the card's project belongs to, which the board filters by. */
  organizationId: string;
  projectId: string;
  projectName: string;
  missionId: string | null;
  mission: string | null;
  /** The CLI that actually claimed the card, for its brand mark. */
  ranCli: string | null;
  /** Every distinct CLI that attempted this card, including earlier reopens. */
  executors: string[];
  /**
   * What ran in one value: "sonnet-5", or "sonnet-5 → fable-5" when the usage
   * switched model. The claimed model reads as the claim spelled it.
   */
  harnessChain: string | null;
  /** The effort the latest claim declared, beside the model on the line (E2). */
  effort: string | null;
  /** Where the attempt's current model identity came from. */
  modelSource: "declared" | "harness" | "measured" | null;
  /** True when this card waits on the review of whoever is looking at it. */
  awaitingMyReview: boolean;
  devolve: string;
  /** Set only on a running card, the one place the line names it. */
  executor: string | null;
  elapsed: string | null;
  /** Lease age, independent from total time since claim. */
  claimInactive: string | null;
  /** True once another executor may reclaim without force. */
  claimStale: boolean;
  resolvedIn: string | null;
  /** The run's numbers spelled for the single line the card has. */
  telemetryLine: TelemetrySegment[];
};

/**
 * One attempt as the panel lists it (E2): what the run recorded, never a
 * choice the board made.
 */
export type AttemptView = {
  /** 1 for the first attempt, in the order they started. */
  n: number;
  cli: string | null;
  /** The model as the claim registered it. */
  model: string | null;
  effort: string | null;
  modelSource: "declared" | "harness" | "measured" | null;
  duration: string | null;
  /** Null while money is off, or when nothing was priced. */
  cost: string | null;
  /** Null while the attempt is still open. */
  result: "success" | "failure" | "abandoned" | null;
  at: string;
  /** The short hash its delivery carried. */
  commit: string | null;
};

/** What the detail panel adds to a card, loaded when the card is opened. */
export type BoardCardDetail = {
  id: string;
  oQue: string;
  porQue: string;
  comoConfirmo: ConfirmStep[];
  validationTicks: ValidationTickView[];
  howToVerify: string | null;
  /**
   * What the latest claim ran on, model and effort, for the detail panel.
   * The board records the harness that executed; it never plans one (OCL-202).
   */
  harness: string | null;
  /** Every attempt on the card, oldest first (E2). */
  attempts: AttemptView[];
  /** Whatever claimed the card, for every status; the line's copy is the running card's only. */
  executor: string | null;
  /** The models the usage recorded, set only when they are not what the claim declared. */
  harnessRan: string | null;
  origem: string;
  branch: string | null;
  commit?: string | null;
  commitUrl?: string | null;
  deliveryUnverified?: boolean;
  deliveryVerification?: "verified" | "unverified" | null;
  deliveryWarning?: string | null;
  reportsCount: number;
  timeline: TimelineEntry[];
  /** The whole breakdown in words, for the detail panel. */
  telemetry: string | null;
  /** Null when neither clock ran on this card. */
  duration: DurationView | null;
  /** Server guard: this attempt's counters stay outside trusted Insights totals. */
  usageSuspect: boolean;
  transcript: TranscriptView | null;
  handoff: string | null;
};

/** An opened card: its line and its detail together. */
export type OpenBoardCard = BoardCard & BoardCardDetail;

function columnLabels(t: Dict): Record<ColumnStatus, string> {
  return {
    aberto: t.board.colOpen,
    em_execucao: t.board.colInProgress,
    feito: t.board.colDone,
    validado: t.board.colValidated,
    descartado: t.board.colDiscarded,
  };
}

function statusLabels(t: Dict): Record<ColumnStatus, string> {
  return {
    aberto: t.board.statusOpen,
    em_execucao: t.board.statusInProgress,
    feito: t.board.statusDone,
    validado: t.board.statusValidated,
    descartado: t.board.statusDiscarded,
  };
}

const STATUS_CHIP: Record<ColumnStatus, string> = {
  aberto: "",
  em_execucao: "exec",
  feito: "feito",
  validado: "ok",
  descartado: "off",
};

/**
 * AGB-73: one mark per column, and the same mark wherever that column's
 * status is named. The four columns used to differ only by the word on top,
 * so a person scanning the board had to read four labels to find the one
 * they came for. The mark is what the eye finds first; the word stays and
 * keeps saying which column it is, because a glyph alone cannot.
 */
const COLUMN_ICON: Record<ColumnStatus, IconName> = {
  aberto: "columnOpen",
  em_execucao: "columnRunning",
  feito: "columnDone",
  validado: "columnValidated",
  descartado: "columnDone",
};

/** Empty-state microcopy (briefing §4.2). */
function EmptyState({ status, t }: { status: ColumnStatus; t: Dict }) {
  // On the phone layout the sentence holds one line and truncates; the title
  // keeps the full text reachable. The column's own mark sits above it: an
  // empty column is still that column, and the four of them stopped looking
  // like the same grey paragraph the moment each got its mark (AGB-73).
  const mark = (
    <Icon name={COLUMN_ICON[status]} label={null} size={20} className="empty-mark" />
  );
  if (status === "aberto") {
    return (
      <div
        className="empty-col"
        title={`${t.board.emptyOpenBefore}${t.board.emptyOpenCmd}${t.board.emptyOpenAfter}`}
      >
        {mark}
        <span>
          {t.board.emptyOpenBefore}
          <i>{t.board.emptyOpenCmd}</i>
          {t.board.emptyOpenAfter}
        </span>
      </div>
    );
  }
  if (status === "em_execucao") {
    return (
      <div className="empty-col" title={t.board.emptyInProgress}>
        {mark}
        <span>{t.board.emptyInProgress}</span>
      </div>
    );
  }
  if (status === "feito") {
    return (
      <div className="empty-col" title={t.board.emptyDone}>
        {mark}
        <span>{t.board.emptyDone}</span>
      </div>
    );
  }
  if (status === "descartado") {
    return (
      <div className="empty-col" title={t.board.emptyDiscarded}>
        {mark}
        <span>{t.board.emptyDiscarded}</span>
      </div>
    );
  }
  return (
    <div className="empty-col" title={t.board.emptyValidated}>
      {mark}
      <span>{t.board.emptyValidated}</span>
    </div>
  );
}

function Telemetry({ text }: { text: string }) {
  // highlighted numbers, as in the mockup (bold on duration and cost)
  const parts = text.split(" · ");
  return (
    <span className="telemetry">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? " · " : ""}
          {p.includes("tok") ? p : <b>{p}</b>}
        </span>
      ))}
    </span>
  );
}

/**
 * The dense line, one value per span so the layout can pick what to elide when
 * the column is narrow. Each segment carries its own separator, which keeps
 * the "·" out of whatever gets truncated.
 */
function TelemetryLine({
  segments,
  lead,
}: {
  segments: TelemetrySegment[];
  /** True when the harness already occupies the line and owes a separator. */
  lead: boolean;
}) {
  return (
    <>
      {segments.map((segment, i) => (
        <span className={`tel-seg tel-${segment.kind}`} key={i}>
          {i > 0 || lead ? <span className="tel-sep">·</span> : null}
          {segment.kind === "tokens" || segment.kind === "note" ? (
            segment.text
          ) : (
            <b>{segment.text}</b>
          )}
        </span>
      ))}
    </>
  );
}

/**
 * Everything after the harness on the card's one meta line. Open cards owe
 * the reader who gets the card back, running ones how long they have been at
 * it, delivered ones the numbers the run cost.
 */
function CardMetaTail({
  card,
  t,
  lead,
  telemetryLine,
}: {
  card: BoardCard;
  t: Dict;
  /** True when something already sits to the left on this line. */
  lead: boolean;
  /** The footer's share of the telemetry line — cost already pulled out of it. */
  telemetryLine: TelemetrySegment[];
}) {
  const sep = lead ? <span className="tel-sep">·</span> : null;
  if (card.status === "aberto") {
    return (
      <span className="telemetry">
        {sep}
        {t.board.returnsTo} <b>{card.devolve}</b>
      </span>
    );
  }
  if (card.status === "em_execucao") {
    const activity = card.claimInactive ?? card.elapsed;
    // A run past the claim timeout has gone quiet: that is the one line of a
    // running card that waits for a person (the attention amber, E1).
    return activity ? (
      <span className={`telemetry${card.claimStale ? " no-signal" : ""}`}>
        {sep}
        <b>{activity}</b>
      </span>
    ) : null;
  }
  if (telemetryLine.length > 0) {
    return <TelemetryLine segments={telemetryLine} lead={lead} />;
  }
  // Never a bare "no telemetry" on a delivered card: without any numbers the
  // honest label is that usage went unreported.
  return (
    <span className="telemetry">
      {sep}
      {t.board.usageNotReported}
    </span>
  );
}

/**
 * The CLI that claimed the card, as the brand mark the app already ships
 * (AGB-66): the width a glyph costs instead of the width a word costs.
 */
function CardCli({ card }: { card: BoardCard }) {
  if (!card.ranCli) return null;
  return (
    <span className="meta-cli">
      <CliMark cli={card.ranCli} />
    </span>
  );
}

/**
 * The project the card came from, read off its short id. With several
 * projects on the board the prefix is what says where a card belongs, so it
 * stops being part of the number and becomes the origin.
 */
function CardId({ shortId, showProject }: { shortId: string; showProject: boolean }) {
  const cut = shortId.indexOf("-");
  if (!showProject || cut <= 0) return <span className="cid">{shortId}</span>;
  return (
    <span className="cid">
      <span className="cid-prefix">{shortId.slice(0, cut)}</span>
      {shortId.slice(cut)}
    </span>
  );
}

/**
 * A card is the board's own control, so it answers the keyboard the way a
 * button does: Enter and Space open it, or tick it while the board is picking
 * cards. Anything typed inside a real control within the card is that
 * control's business and never reaches here.
 */
function activateOnKey(run: () => void) {
  return (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    run();
  };
}

function Card({
  card,
  onOpen,
  showProject,
  selectable,
  selected,
  onToggleSelect,
  t,
}: {
  card: BoardCard;
  onOpen: (c: BoardCard) => void;
  /** True while more than one project shares the board. */
  showProject: boolean;
  /** True while the board is picking cards to move between missions. */
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  t: Dict;
}) {
  const exec = card.status === "em_execucao";
  const dim = card.status === "validado";
  // The record reads "model · effort" (E2), the model as it was registered.
  const harness = card.harnessChain
    ? [card.harnessChain, card.effort].filter(Boolean).join(" · ")
    : exec
      ? (card.executor ?? t.board.agent)
      : null;
  const activate = () => (selectable ? onToggleSelect(card.id) : onOpen(card));
  // The cost lives at the top of the card (ux-v2 §3), on the id's own line,
  // so the footer never has to compete with it for room. What is left of the
  // telemetry line still degrades there, by priority, never past the border.
  const costSegment = card.telemetryLine.find((s) => s.kind === "cost") ?? null;
  const footTelemetry = costSegment
    ? card.telemetryLine.filter((s) => s !== costSegment)
    : card.telemetryLine;
  // Three lines and no more: what the card is, what it says, what it cost.
  // Mission, branch, executor and the effort of the harness all stay one
  // click away in the detail panel.
  return (
    <div
      id={`board-card-${card.id}`}
      className={`card nebula-glass${exec ? " exec nebula-corners" : ""}${dim ? " dim" : ""}${
        selectable ? " selectable" : ""
      }${selected ? " picked" : ""}${card.tipo === "bug" ? " type-bug" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selectable ? selected : undefined}
      onClick={activate}
      onKeyDown={activateOnKey(activate)}
    >
      <div className="id-row">
        <div className="id-row-main">
          {selectable ? (
            <input
              type="checkbox"
              className="card-pick"
              checked={selected}
              aria-label={card.shortId}
              onChange={() => onToggleSelect(card.id)}
              onClick={(event) => event.stopPropagation()}
            />
          ) : null}
          <CardId shortId={card.shortId} showProject={showProject} />
          {/* Type reads as a plain word in the meta line, never a coloured
              chip (ux-v2 §3): the only scanning aid a bug keeps is the card's
              own left border, set from the `type-bug` class above. */}
          <span className="id-sep" aria-hidden="true">
            ·
          </span>
          <span className="card-type">{card.tipo}</span>
          {card.isExample ? <span className="selo">{t.board.example}</span> : null}
          {card.awaitingMyReview ? (
            <span className="review-chip">{t.board.yourReview}</span>
          ) : null}
          {card.supersedes ? (
            <span className="selo">
              {t.board.continues} {card.supersedes.shortId}
            </span>
          ) : null}
          {card.status === "descartado" ? (
            <span className="selo">
              {t.board.discardedTo} {card.supersededBy?.shortId ?? "—"}
            </span>
          ) : null}
        </div>
        {costSegment ? <span className="card-cost">{costSegment.text}</span> : null}
      </div>
      {/* One line on the phone: the ellipsis points here and to the panel. */}
      <h4 title={card.title}>{card.title}</h4>
      <div className={`card-foot${exec ? " exec-pulse" : ""}`}>
        {exec ? <span className="dot-exec" /> : null}
        {/* The line leads with who ran it and follows with what it ran. */}
        <CardCli card={card} />
        {harness ? <span className="meta-harness">{harness}</span> : null}
        {card.modelSource === "harness" ? (
          <span className="selo" title={t.detail.modelSourceHarness}>
            {t.detail.modelSourceHarness}
          </span>
        ) : null}
        {card.modelSource === "declared" ? (
          <span className="selo" title={t.detail.modelSourceDeclared}>
            {t.detail.modelSourceDeclared}
          </span>
        ) : null}
        {/* The separator belongs to what comes after the harness, not to the
            harness itself: an ellipsis on the model chain would eat it. */}
        <CardMetaTail
          card={card}
          t={t}
          lead={harness != null}
          telemetryLine={footTelemetry}
        />
      </div>
    </div>
  );
}

/**
 * The card as one row, which is all a phone can afford (AGB-64).
 *
 * The three-line card made titles readable and then spent the screen on the
 * rest: five cards where a scan list holds three times as many. So the row
 * keeps what tells cards apart, one letter for the type, the short id, the
 * title with every pixel that is left, and the single number that says what
 * the run was worth. Harness, reviewer, the whole telemetry and the model
 * chain are one tap away, in the panel that has room for them.
 *
 * Nothing here wraps: the row is one line by construction, and the title
 * truncates at the end with the full value on the title attribute and in the
 * detail panel.
 */
function CardRow({
  card,
  onOpen,
  showProject,
  selectable,
  selected,
  onToggleSelect,
  t,
}: {
  card: BoardCard;
  onOpen: (c: BoardCard) => void;
  showProject: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  t: Dict;
}) {
  const exec = card.status === "em_execucao";
  const dim = card.status === "validado";
  const num = pickRowNumber(card.telemetryLine, card.elapsed);
  return (
    <div
      className={`ml-row${exec ? " exec" : ""}${dim ? " dim" : ""}${
        selectable ? " selectable" : ""
      }${selected ? " picked" : ""}`}
      title={card.title}
      role="button"
      tabIndex={0}
      aria-pressed={selectable ? selected : undefined}
      onClick={() => (selectable ? onToggleSelect(card.id) : onOpen(card))}
      onKeyDown={activateOnKey(() =>
        selectable ? onToggleSelect(card.id) : onOpen(card),
      )}
    >
      {selectable ? (
        <input
          type="checkbox"
          className="card-pick"
          checked={selected}
          aria-label={card.shortId}
          onChange={() => onToggleSelect(card.id)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {/* A letter, not a chip: the same word in a box costs a fifth of the
          row and the title is what that width is for. */}
      <span className={`ml-type ${card.tipo}`} aria-label={card.tipo}>
        {typeInitial(card.tipo)}
      </span>
      <CardId shortId={card.shortId} showProject={showProject} />
      <span className="ml-title">{card.title}</span>
      {/* The one signal that makes a person tap, kept as a dot instead of the
          chip it is on the desktop card. */}
      {card.awaitingMyReview ? (
        <span className="ml-flag" aria-label={t.board.yourReview} />
      ) : null}
      {/* Who ran it, in the width a glyph costs: the spelled name never fit
          this row, and the mark is read faster than the word anyway. */}
      <CliMark cli={card.ranCli} />
      {num ? <span className={`ml-num tel-${num.kind}`}>{num.text}</span> : null}
    </div>
  );
}

/**
 * Every attempt on the card, newest on top (E2): the CLI, then "model ·
 * effort" as the run registered them, then how long, what it cost, how it
 * ended, when and the commit. It replaces the one-attempt "Ran on" line; the
 * models the usage measured beyond the claim stay under it.
 */
function Attempts({ card, t }: { card: OpenBoardCard; t: Dict }) {
  if (card.attempts.length === 0) return null;
  return (
    <div className="d-sec d-attempts" data-count={card.attempts.length}>
      <SectionLabel
        icon="harness"
        text={t.record.attempts}
        right={<span className="d-progress">{card.attempts.length}</span>}
      />
      <ol className="d-attempt-list">
        {[...card.attempts].reverse().map((attempt) => (
          <li key={attempt.n} className="d-attempt">
            <span className="d-attempt-n">#{attempt.n}</span>
            <CliMark cli={attempt.cli} />
            <span className="d-attempt-run">
              {[attempt.model, attempt.effort].filter(Boolean).join(" · ") ||
                attempt.cli ||
                "—"}
            </span>
            {attempt.modelSource === "harness" ? (
              <span className="selo">{t.detail.modelSourceHarness}</span>
            ) : null}
            {attempt.modelSource === "declared" ? (
              <span className="selo">{t.detail.modelSourceDeclared}</span>
            ) : null}
            <span className="d-attempt-meta">
              {[
                attempt.duration,
                attempt.cost,
                t.record.result[attempt.result ?? "running"],
                attempt.at,
              ]
                .filter(Boolean)
                .join(" · ")}
              {attempt.commit ? (
                <>
                  {" · "}
                  <span className="d-attempt-commit">{attempt.commit}</span>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {card.harnessRan ? (
        <p className="d-mono d-harness-ran">
          {t.detail.harnessRan} {card.harnessRan}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The How-to-confirm contract. Read-only list before delivery; on a done card
 * each step is a checkbox the reviewer ticks while following the script.
 */
function ConfirmChecklist({
  card,
  ticks,
  onToggle,
  disabled,
  t,
}: {
  card: OpenBoardCard;
  ticks: ValidationTickView[];
  onToggle?: (index: number, checked: boolean) => void;
  disabled?: boolean;
  t: Dict;
}) {
  const interactive = Boolean(onToggle);
  const showTicks = card.status === "feito" || card.status === "validado";
  return (
    <div className="d-checklist">
      {card.comoConfirmo.map((step, index) => {
        const tick = showTicks ? ticks.find((t) => t.index === index) : undefined;
        return (
          <label
            key={index}
            className={`d-check-row${tick ? " ticked" : ""}${interactive ? " interactive" : ""}`}
          >
            {showTicks ? (
              <input
                type="checkbox"
                checked={Boolean(tick)}
                disabled={!interactive || disabled}
                onChange={(e) => onToggle?.(index, e.target.checked)}
              />
            ) : (
              <span className="d-check-num">{index + 1}</span>
            )}
            <span className="d-check-body">
              <span className="d-check-step">
                <Markdown inline text={step.step} />
              </span>
              <span className="d-check-expected">
                {t.detail.expected} <Markdown inline text={step.expected} />
              </span>
              {tick ? (
                <span className="d-check-meta">
                  {t.detail.checkedBy} {tick.byEmail} · {formatShortDateTime(tick.at, t.lang)}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function CopyButton({ label, value, t }: { label: string; value: string; t: Dict }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      // Clipboard denied (http origin, or the browser said no): the path and
      // the commands are on screen, so there is still something to select.
      setDone(false);
    }
  };

  return (
    <button className={`d-copy${done ? " done" : ""}`} onClick={copy} title={value}>
      {/* AGB-73: the mark says what the button does, the word says what it
          copies, and the tick replaces the mark the instant it worked. The
          label is never dropped: "path" and "resume" are not the same act. */}
      <Icon name={done ? "check" : "copy"} label={null} size={13} />
      <span>{done ? t.detail.copied : label}</span>
    </button>
  );
}

/**
 * A section title of the detail panel.
 *
 * Ten sections stacked in one panel all announced themselves in the same
 * ten-pixel uppercase mono. The spec (ux-v2 §3) now makes them 11px/600
 * uppercase text-3: the hierarchy comes from weight and colour, not from
 * decorative marks.
 *
 * `right` is what the title line carries on its far side, which today is the
 * validation progress and nothing else.
 */
function SectionLabel({
  icon,
  text,
  right,
}: {
  icon: IconName;
  text: string;
  right?: ReactNode;
}) {
  return (
    <div className="lbl">
      <span className="lbl-name">{text}</span>
      {right}
    </div>
  );
}

/**
 * The pointer back to the session that did the work: the path, the command
 * that reopens it in that CLI, and the command that recomputes usage from it.
 * A button only appears for something the board actually knows.
 */
function Transcript({ view, t }: { view: TranscriptView; t: Dict }) {
  const head = [view.cli, view.sessionId ? `${t.detail.transcriptSession} ${view.sessionId}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="d-sec">
      <SectionLabel icon="transcript" text={t.detail.transcript} />
      {head ? <p className="d-mono">{head}</p> : null}
      <p className="d-transcript-path d-mono">
        {view.path ?? t.detail.transcriptNoPath}
      </p>
      <div className="d-copy-row">
        {view.path ? <CopyButton label={t.detail.copyPath} value={view.path} t={t} /> : null}
        {view.resume ? (
          <CopyButton label={t.detail.copyResume} value={view.resume} t={t} />
        ) : null}
        {view.usageCommand ? (
          <CopyButton label={t.detail.copyRecompute} value={view.usageCommand} t={t} />
        ) : null}
      </div>
      <p className="d-transcript-note">{t.detail.transcriptNote}</p>
    </div>
  );
}

/**
 * The mission of the card, as something a human can change. Cards created
 * before missions existed are all loose, and until this select existed the
 * product had no way to put them anywhere: the mission was chosen at creation
 * or never. Picking the blank option detaches the card again.
 */
function MissionField({
  card,
  missions,
  t,
}: {
  card: BoardCard;
  missions: BoardMissionOption[];
  t: Dict;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const currentMissionId = missions.some((miss) => miss.id === card.missionId)
    ? card.missionId ?? ""
    : "";
  const [value, setValue] = useState(currentMissionId);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentMissionId);
    setErr(null);
  }, [card.id, currentMissionId]);

  const change = (next: string) => {
    const previous = value;
    setValue(next);
    setErr(null);
    start(async () => {
      const r = await assignCardsToMissionAction([card.id], next || null);
      if (!r.ok) {
        setValue(previous);
        setErr(r.error);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <div>
      <SectionLabel icon="mission" text={t.detail.mission} />
      {missions.length === 0 ? (
        <p>{t.detail.missionNoneAvailable}</p>
      ) : (
        <select
          className="d-mission"
          aria-label={t.detail.mission}
          value={value}
          disabled={pending}
          onChange={(event) => change(event.target.value)}
        >
          <option value="">{t.detail.missionNone}</option>
          {missions.map((miss) => (
            <option key={miss.id} value={miss.id}>
              {miss.title}
            </option>
          ))}
        </select>
      )}
      {err ? <p className="d-err">{err}</p> : null}
    </div>
  );
}

function CardLocation({ card, t }: { card: BoardCard; t: Dict }) {
  const hasMission = Boolean(card.missionId && card.mission?.trim());

  // Navigation plan E3 (F5): project, mission and release are three fields,
  // not a path. The mission is a place of its own now: its name leads to its
  // page instead of filtering the board under the open card.
  return (
    <nav className="d-location" aria-label={t.detail.cardLocation}>
      <span className="d-location-project" title={card.projectName}>
        {card.projectName}
      </span>
      <span className="d-location-separator" aria-hidden="true">
        ·
      </span>
      {hasMission ? (
        <a
          className="d-location-mission"
          href={`/missions/${card.missionId}`}
          aria-label={t.detail.openMission(card.mission!)}
          title={card.mission!}
        >
          {card.mission}
        </a>
      ) : (
        <span className="d-location-empty">{t.detail.missionNone}</span>
      )}
      {card.resolvedIn ? (
        <>
          <span className="d-location-separator" aria-hidden="true">
            ·
          </span>
          <span className="d-location-release">{card.resolvedIn}</span>
        </>
      ) : null}
    </nav>
  );
}

/** "For checking, open...": the agent's entry point for lay validation. */
function HowToVerify({ value, t }: { value: string; t: Dict }) {
  const isUrl = /^https?:\/\//.test(value.trim());
  return (
    <div className="d-verify">
      <span className="d-verify-lbl">{t.detail.forCheckingOpen}</span>
      {isUrl ? (
        <a href={value} target="_blank" rel="noreferrer" className="d-verify-value">
          {value}
          {/* A link that leaves the board says so before it is clicked. */}
          <Icon name="external" label={null} size={12} />
        </a>
      ) : (
        <span className="d-verify-value d-mono">{value}</span>
      )}
    </div>
  );
}

function DetailActions({
  card,
  allTicked,
  onClose,
  onValidated,
  viewerRole,
  t,
}: {
  card: BoardCard;
  allTicked: boolean;
  onClose: () => void;
  /** The review list moves on to the next card instead of closing. */
  onValidated?: () => void;
  /** Validating is the admin's: a member is not offered the button (F10). */
  viewerRole: ViewerRole;
  t: Dict;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reopening, setReopening] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // OCL-203: the same task_update the MCP uses, so the board refuses exactly
  // what an agent would be refused, with the same explanation.
  const discard = () =>
    start(async () => {
      setErr(null);
      const r = await discardTaskAction(card.id, reason);
      if (!r.ok) setErr(r.error);
      else {
        onClose();
        router.refresh();
      }
    });

  if (discarding) {
    return (
      <div className="d-actions d-actions-reopen">
        <textarea
          className="d-textarea"
          autoFocus
          rows={3}
          placeholder={t.detail.discardPlaceholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {err ? <p className="d-err">{err}</p> : null}
        <div className="d-actions-row">
          <button
            className="d-btn-sec oc-tappable"
            disabled={pending}
            onClick={() => {
              setDiscarding(false);
              setErr(null);
            }}
          >
            {t.detail.cancel}
          </button>
          <button
            className="d-btn-pri oc-tappable"
            disabled={pending || !reason.trim()}
            onClick={discard}
          >
            {pending ? t.detail.discarding : t.detail.discardConfirm}
          </button>
        </div>
      </div>
    );
  }

  const discardButton = (
    <button
      className="d-btn-ghost oc-tappable"
      disabled={pending}
      onClick={() => {
        setErr(null);
        setDiscarding(true);
      }}
      title={t.detail.discardTitle}
    >
      {t.detail.discard}
    </button>
  );

  const release = () =>
    start(async () => {
      setErr(null);
      const r = await releaseClaimAction(card.id);
      if (!r.ok) setErr(r.error);
      else {
        onClose();
        router.refresh();
      }
    });

  if (card.status === "em_execucao") {
    return (
      <div className="d-actions">
        {err ? <p className="d-err">{err}</p> : null}
        <div className="d-actions-row">
          <span className={card.claimStale ? "d-usage-warning" : "d-empty"}>
            {card.claimInactive}
            {card.claimStale ? ` · ${t.detail.claimExpired}` : ""}
          </span>
          {discardButton}
          <button
            className="d-btn-sec oc-tappable"
            disabled={pending}
            onClick={release}
            title={t.detail.releaseClaimTitle}
          >
            {pending ? t.detail.releasingClaim : t.detail.releaseClaim}
          </button>
        </div>
      </div>
    );
  }

  // A decision card (rfc) is asked before any work starts, so it never
  // reaches "feito" on its own — this is the only write path an open rfc
  // card has. feature/bug cards are untouched: they keep going through
  // claim → deliver → validate exactly as before.
  if (card.status === "aberto" && card.tipo === "rfc") {
    const answer = () =>
      start(async () => {
        setErr(null);
        const r = await answerOpenTaskAction(card.id, comment);
        if (!r.ok) setErr(r.error);
        else {
          setComment("");
          router.refresh();
        }
      });

    return (
      <div className="d-actions d-actions-answer">
        <textarea
          className="d-textarea"
          rows={3}
          placeholder={t.detail.answerPlaceholder}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {err ? <p className="d-err">{err}</p> : null}
        <div className="d-actions-row">
          {discardButton}
          <button
            className="d-btn-pri oc-tappable"
            disabled={pending || !comment.trim()}
            onClick={answer}
          >
            {pending ? t.detail.answerSending : t.detail.answerSend}
          </button>
        </div>
      </div>
    );
  }

  // An open card has nothing to validate or release: discarding is the one
  // write it offers, for a card whose reason to exist went away.
  if (card.status === "aberto") {
    return (
      <div className="d-actions">
        {err ? <p className="d-err">{err}</p> : null}
        <div className="d-actions-row">{discardButton}</div>
      </div>
    );
  }

  if (card.status !== "feito") return null;

  const validate = (override: boolean) =>
    start(async () => {
      setErr(null);
      const r = await validateTaskAction(card.id, { override });
      if (!r.ok) setErr(r.error);
      else {
        if (onValidated) onValidated();
        else onClose();
        router.refresh();
      }
    });

  const reopen = () =>
    start(async () => {
      setErr(null);
      const r = await reopenTaskAction(card.id, comment);
      if (!r.ok) setErr(r.error);
      else {
        onClose();
        router.refresh();
      }
    });

  if (reopening) {
    return (
      <div className="d-actions d-actions-reopen">
        <textarea
          className="d-textarea"
          autoFocus
          rows={3}
          placeholder={t.detail.reopenPlaceholder}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {err ? <p className="d-err">{err}</p> : null}
        <div className="d-actions-row">
          <button className="d-btn-sec oc-tappable" disabled={pending} onClick={() => { setReopening(false); setErr(null); }}>
            {t.detail.cancel}
          </button>
          <button className="d-btn-pri oc-tappable" disabled={pending || !comment.trim()} onClick={reopen}>
            {pending ? t.detail.reopening : t.detail.reopen}
          </button>
        </div>
      </div>
    );
  }

  // F10: the member's card waits on the admin. They can still send it back
  // with a comment; validating is not theirs to offer.
  if (viewerRole === "member") {
    return (
      <div className="d-actions">
        {err ? <p className="d-err">{err}</p> : null}
        <div className="d-actions-row">
          {discardButton}
          <span className="d-empty d-awaiting">{t.review.awaitingAdmin}</span>
          <button className="d-btn-sec oc-tappable" disabled={pending} onClick={() => setReopening(true)}>
            {t.detail.reopenWithComment}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="d-actions">
      {err ? <p className="d-err">{err}</p> : null}
      <div className="d-actions-row">
        {discardButton}
        {!allTicked ? (
          <button
            className="d-btn-ghost oc-tappable"
            disabled={pending}
            onClick={() => validate(true)}
            title={t.detail.validateAnywayTitle}
          >
            {t.detail.validateAnyway}
          </button>
        ) : null}
        <button className="d-btn-sec oc-tappable" disabled={pending} onClick={() => setReopening(true)}>
          {t.detail.reopenWithComment}
        </button>
        <button
          className="d-btn-pri oc-tappable"
          disabled={pending || !allTicked}
          title={allTicked ? undefined : t.detail.validateDisabledTitle}
          onClick={() => validate(false)}
        >
          {pending ? t.detail.validating : t.detail.validate}
        </button>
      </div>
    </div>
  );
}

/**
 * AGB-72: the width at which the detail stops being a centred panel and
 * becomes a full screen sheet. Kept in step with the breakpoint that carries
 * the sheet rules in nebula.css.
 */
const SHEET_QUERY = "(max-width: 768px), (orientation: landscape) and (max-height: 500px)";

function Detail({
  card,
  missions,
  onClose,
  viewerRole,
  queue,
  t,
}: {
  card: OpenBoardCard;
  missions: BoardMissionOption[];
  onClose: () => void;
  viewerRole: ViewerRole;
  queue?: ReviewQueuePosition;
  t: Dict;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [ticks, setTicks] = useState<ValidationTickView[]>(card.validationTicks);
  const [tickErr, setTickErr] = useState<string | null>(null);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // The panel is a dialog, so it takes the focus when it opens and gives the
  // page back its scroll when it closes. Without the lock the board scrolls
  // under the panel on a phone, which is the list moving while the reading
  // stands still.
  //
  // AGB-72: under the sheet breakpoint hidden overflow is not a lock a touch
  // gesture respects, so the body is pinned at the offset it already had and
  // put back on it when the sheet goes. The list comes back where it was
  // left, never at the top.
  useEffect(() => {
    panel.current?.focus();
    const body = document.body;
    const previous = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };
    const offset = window.scrollY;
    const sheet = window.matchMedia(SHEET_QUERY).matches;
    body.style.overflow = "hidden";
    if (sheet) {
      body.style.position = "fixed";
      body.style.top = `${-offset}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
    }
    return () => {
      body.style.overflow = previous.overflow;
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.left = previous.left;
      body.style.right = previous.right;
      body.style.width = previous.width;
      window.scrollTo(0, offset);
    };
  }, []);

  const reviewing = card.status === "feito";
  const allTicked = card.comoConfirmo.every((_, index) =>
    ticks.some((t) => t.index === index),
  );

  const toggleTick = (index: number, checked: boolean) => {
    const previous = ticks;
    setTickErr(null);
    // Optimistic: the server records the real who/when on refresh.
    setTicks(
      checked
        ? [
            ...previous.filter((t) => t.index !== index),
            { index, byEmail: "you", at: new Date().toISOString() },
          ]
        : previous.filter((t) => t.index !== index),
    );
    start(async () => {
      const r = await tickValidationStepAction(card.id, index, checked);
      if (!r.ok) {
        setTicks(previous);
        setTickErr(r.error);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <div className="ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="detail nebula-glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panel}
      >
        {/* The way out is a glyph and not a character borrowed from the font:
            ✕ was whatever the reader's system had for that codepoint, at
            whatever weight it came in (AGB-73). */}
        <button className="d-close" onClick={onClose} aria-label={t.detail.close}>
          <Icon name="close" label={null} size={15} />
        </button>
        <div className="d-head">
          {queue ? (
            // The review list's place in line (E1): "1 of 4 to review", with the
            // neighbours one step away on either side.
            <div className="d-queue">
              <button
                type="button"
                className="d-queue-step oc-tappable"
                onClick={queue.onPrevious}
                disabled={queue.total < 2}
                aria-label={t.review.previous}
              >
                <Icon name="chevronLeft" label={null} size={14} />
              </button>
              <span className="d-queue-pos">
                <b>{t.review.position(queue.index + 1, queue.total)}</b> {t.review.positionSuffix}
              </span>
              <button
                type="button"
                className="d-queue-step oc-tappable"
                onClick={queue.onNext}
                disabled={queue.total < 2}
                aria-label={t.review.next}
              >
                <Icon name="chevronRight" label={null} size={14} />
              </button>
            </div>
          ) : null}
          <span>{card.shortId}</span>
          <CardLocation card={card} t={t} />
          <span className={`tag ${card.tipo}`}>{card.tipo}</span>
          <span className={`d-status ${STATUS_CHIP[card.status]}`}>
            {/* The same mark the card's column carries on the board, so the
                chip and the column say the same thing the same way. */}
            <StatusMark status={card.status} />
            {statusLabels(t)[card.status]}
          </span>
        </div>
        <h3 id={titleId}>{card.title}</h3>
        {/* AGB-74: the contract and the checklist, which is what a review
            acts on. On a wide screen this is the main column and the
            metadata sits beside it; below the sheet breakpoint both
            wrappers become display: contents, so the phone reads the very
            same single column it read before, in the same DOM order it
            always had. */}
        <div className="d-main">
          <div className="d-sec">
            <SectionLabel icon="spec" text={t.detail.what} />
            <Markdown text={card.oQue} className="md-field" />
          </div>
          <div className="d-sec">
            <SectionLabel icon="reason" text={t.detail.why} />
            <Markdown text={card.porQue} className="md-field" />
          </div>
          <div className={`d-sec${reviewing ? " d-sec-validate" : ""}`}>
            <SectionLabel
              icon="checklist"
              text={reviewing ? t.detail.validationHowToConfirm : t.detail.howToConfirm}
              right={
                (card.status === "feito" || card.status === "validado") &&
                card.comoConfirmo.length > 0 ? (
                  <span className={`d-progress${allTicked ? " done" : ""}`}>
                    {ticks.length}/{card.comoConfirmo.length}
                  </span>
                ) : undefined
              }
            />
            {reviewing && card.howToVerify ? <HowToVerify value={card.howToVerify} t={t} /> : null}
            {card.comoConfirmo.length === 0 ? (
              /* An empty contract is a fact about the card, not a dash. */
              <p className="d-empty">{t.detail.noSteps}</p>
            ) : (
              <ConfirmChecklist
                card={card}
                ticks={ticks}
                onToggle={reviewing ? toggleTick : undefined}
                t={t}
              />
            )}
            {tickErr ? <p className="d-err">{tickErr}</p> : null}
          </div>
        </div>
        {/* What is read rather than acted upon. Beside the contract on a
            desktop instead of a screen below it, which is what turned a
            review into scrolling past everything twice. */}
        <div className="d-rail">
          <div className="d-sec d-grid">
            <MissionField card={card} missions={missions} t={t} />
          </div>
          <Attempts card={card} t={t} />
          <div className="d-sec">
            <SectionLabel icon="roles" text={t.detail.roles} />
            <div className="d-roles">
              <span className="rl">{t.detail.origin} <b>{card.origem}</b></span>
              <span className="rl">
                {t.detail.executor} <CliMark cli={card.ranCli} />
                {/* The claim's own name, which is the CLI whenever it sent one
                    and whatever else it sent when it did not. */}
                <b>{card.ranCli ?? card.executor ?? "—"}</b>
              </span>
              <span className="rl">{t.board.returnsTo} <b>{card.devolve}</b></span>
            </div>
          </div>
          {card.timeline.length > 0 ? (
            <div className="d-sec">
              <SectionLabel icon="timeline" text={t.detail.timeline} />
              <div className="d-timeline">
                {card.timeline.map((entry, index) => (
                  <div className="d-evid d-tl-entry" key={index}>
                    <span
                      className={`tag ${
                        entry.kind === "spawn_failure"
                          ? "bug"
                          : entry.kind === "report" || entry.kind === "comment"
                            ? "rfc"
                            : "feature"
                      }`}
                    >
                      {entry.kind === "spawn_failure"
                        ? t.detail.spawnFailure
                        : entry.kind === "claim_release"
                          ? t.detail.claimRelease
                        : entry.kind === "claim_stale"
                          ? t.detail.claimStale
                          : entry.kind === "validation"
                            ? t.detail.validationByAgent
                            : entry.kind === "report"
                              ? t.detail.report
                              : entry.kind === "comment"
                                ? t.detail.report
                                : t.detail.executorSwap}
                    </span>{" "}
                    <Markdown inline text={entry.body} />
                    <span className="d-tl-meta">
                      {" "}· {entry.author ?? "agent"} · {entry.at}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="d-sec d-grid">
            <div>
              <SectionLabel icon="branch" text={t.detail.branch} />
              <p className="d-mono">{card.branch ?? "—"}</p>
              {card.commit ? (
                <p>
                  <span className="d-mono">{t.detail.commit} </span>
                  {card.commitUrl ? (
                    <a
                      href={card.commitUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="d-mono"
                    >
                      {card.commit}
                      <Icon name="external" label={null} size={12} />
                    </a>
                  ) : (
                    <span className="d-mono">{card.commit}</span>
                  )}
                </p>
              ) : null}
              {card.deliveryVerification ? (
                <p className={card.deliveryUnverified ? "d-usage-warning" : "d-empty"}>
                  {card.deliveryUnverified
                    ? card.deliveryWarning ?? t.detail.commitUnverified
                    : t.detail.commitVerified}
                </p>
              ) : null}
              {card.supersedes ? (
                <p>
                  <a href={`#board-card-${card.supersedes.id}`}>
                    {t.board.continues} {card.supersedes.shortId}
                  </a>
                </p>
              ) : null}
              {card.status === "descartado" && card.supersededBy ? (
                <p>
                  <a href={`#board-card-${card.supersededBy.id}`}>
                    {t.board.discardedTo} {card.supersededBy.shortId}
                  </a>
                </p>
              ) : null}
              {card.resolvedIn ? (
                <p>
                  <span className="tag feature">
                    {t.detail.resolvedIn} {card.resolvedIn}
                  </span>
                </p>
              ) : null}
              {card.reportsCount > 0 ? (
                <p className="d-mono">{t.detail.reports(card.reportsCount)}</p>
              ) : null}
            </div>
            {card.telemetry ? (
              <div>
                <SectionLabel icon="telemetry" text={t.detail.telemetry} />
                <p className="d-tel">{card.telemetry}</p>
                {card.usageSuspect ? (
                  <p className="d-usage-warning">{t.detail.usageSuspect}</p>
                ) : null}
                {/* The card line has room for one clock, this panel for both:
                    what the agent worked, and how long the card stayed open. */}
                {card.duration ? (
                  <div className="d-clocks">
                    {card.duration.execution ? (
                      <span className="d-clock">
                        {t.detail.execution} <b>{card.duration.execution}</b>{" "}
                        <i>{t.detail.executionSource}</i>
                      </span>
                    ) : null}
                    {card.duration.elapsed ? (
                      <span className="d-clock">
                        {t.detail.elapsed} <b>{card.duration.elapsed}</b>{" "}
                        <i>{t.detail.elapsedSource}</i>
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {card.handoff ? (
            <div className="d-sec">
              <SectionLabel icon="handoff" text={t.detail.agentHandoff} />
              <div className="d-evid">{card.handoff}</div>
            </div>
          ) : null}
          {card.transcript ? <Transcript view={card.transcript} t={t} /> : null}
        </div>
        {/* Last in the panel and last in the reading, so it is the row the
            whole card leads to. On a desktop it holds the bottom of the
            panel while the two columns scroll under it (AGB-74). */}
        <DetailActions
          card={card}
          allTicked={allTicked}
          onClose={onClose}
          onValidated={queue?.onValidated}
          viewerRole={viewerRole}
          t={t}
        />
      </div>
    </div>
  );
}

type DetailState =
  | { id: string; status: "loading" }
  | { id: string; status: "error"; error: string }
  | { id: string; status: "ready"; detail: BoardCardDetail };

/**
 * The open card's detail, read from the server when the card opens: the list
 * only carries each card's line. It is read again when `version` moves, which
 * is the board's signature, so the panel follows a change the same way the
 * list does and a poll that found nothing new asks for nothing. A card already
 * on screen stays there while it is read again; only a first read shows the
 * skeleton, and only a first read that fails shows the error.
 */
function useCardDetail(cardId: string | null, version: string | undefined, t: Dict) {
  const [state, setState] = useState<DetailState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cardId) return;
    let live = true;
    setState((current) =>
      current?.id === cardId && current.status === "ready"
        ? current
        : { id: cardId, status: "loading" },
    );
    loadBoardCardDetailAction(cardId).then(
      (result) => {
        if (!live) return;
        setState((current) =>
          result.ok
            ? { id: cardId, status: "ready", detail: result.detail }
            : current?.id === cardId && current.status === "ready"
              ? current
              : { id: cardId, status: "error", error: result.error },
        );
      },
      () => {
        if (!live) return;
        setState((current) =>
          current?.id === cardId && current.status === "ready"
            ? current
            : { id: cardId, status: "error", error: t.detail.loadError },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [cardId, version, attempt, t]);
  return {
    state: state && state.id === cardId ? state : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** The panel's place when the card's detail could not be read. */
function DetailError({
  message,
  onRetry,
  onClose,
  t,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
  t: Dict;
}) {
  return (
    <div className="ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="detail nebula-glass" role="alertdialog" aria-modal="true" tabIndex={-1}>
        <button className="d-close" onClick={onClose} aria-label={t.detail.close}>
          <Icon name="close" label={null} size={15} />
        </button>
        <p className="d-err">{message}</p>
        <div className="d-actions">
          <button className="d-btn-pri oc-tappable" onClick={onRetry}>
            {t.detail.retry}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a board loaded by page draws past its cards (OCL board lazy): the
 * exact count of every column, and where a column still has cards to bring.
 * Without it the board holds every card and counts what it holds.
 */
export type BoardColumnsView = {
  counts: ColumnCounts;
  /** The column's next page; null when the column has no more. */
  next: Record<ColumnStatus, string | null>;
  loading: Partial<Record<ColumnStatus, boolean>>;
  /** The column was scrolled near its end. */
  onNearEnd: (status: ColumnStatus) => void;
};

/** The element that scrolls the column, or null for the page itself. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return null;
}

/**
 * The end of a column that has more to bring: when it comes within a screen
 * of view, the next page is asked for. No button and no "older" line — the
 * filter decides what a column holds, the scroll only how much of it is
 * drawn. Keyed by the cursor, so each page landing watches afresh, and a
 * column still short of the screen asks again on its own.
 */
export function ColumnMore({
  loading,
  onNearEnd,
  label,
}: {
  loading: boolean;
  onNearEnd: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useRef(onNearEnd);
  near.current = onNearEnd;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) near.current();
      },
      { root: scrollParent(el), rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="col-tail" aria-hidden={loading ? undefined : true}>
      {loading ? <span className="col-tail-dot" role="status" aria-label={label} /> : null}
    </div>
  );
}

export function Board({
  cards,
  lang,
  missions,
  showProject = false,
  selectable = false,
  selectedIds = [],
  onToggleSelect,
  initialOpen = null,
  cardAddresses = false,
  openedByAddress = false,
  detailVersion,
  viewerRole = "admin",
  columns,
}: {
  cards: BoardCard[];
  lang: string;
  missions: BoardMissionOption[];
  /** True while more than one project shares the board. */
  showProject?: boolean;
  selectable?: boolean;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  /** The card a link asked to open on arrival. */
  initialOpen?: BoardCard | null;
  /**
   * An open card has its own address (/cards/OCL-12, E3): opening one pushes
   * it, Back closes the sheet. Only where that address serves this very
   * board, so a refresh with the card open rebuilds the same page.
   */
  cardAddresses?: boolean;
  /** The page was reached by the open card's address, not from the board. */
  openedByAddress?: boolean;
  /** The board's signature: when it moves, the open card's detail is read again. */
  detailVersion?: string;
  /** Who is looking: the amber and the Validate button are the admin's. */
  viewerRole?: ViewerRole;
  /** The columns come by page: their exact counts and the next page to bring. */
  columns?: BoardColumnsView;
}) {
  const t = dict(lang);
  const colLabel = columnLabels(t);
  // The end of a column that still has cards to bring, in either layout.
  const renderMore = (status: ColumnStatus) => {
    const next = columns?.next[status];
    if (!columns || !next) return null;
    return (
      <ColumnMore
        key={next}
        loading={Boolean(columns.loading[status])}
        onNearEnd={() => columns.onNearEnd(status)}
        label={t.board.columnLoading}
      />
    );
  };
  const [open, setOpen] = useState<BoardCard | null>(initialOpen);
  // The line of the open card as the latest refresh drew it; the one it was
  // opened with when the filter no longer shows it.
  const openLine = open ? (cards.find((card) => card.id === open.id) ?? open) : null;
  const detail = useCardDetail(open?.id ?? null, detailVersion, t);
  const picked = new Set(selectedIds);

  // Arrived by the open card's address: there is no board behind it in the
  // history yet. Otherwise the board is right behind the card, and closing
  // goes Back to it (with its query), so the browser's Back and the sheet's
  // close are one and the same step.
  const arrivedOnCard = useRef(openedByAddress);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const openCard = useCallback(
    (card: BoardCard) => {
      setOpen(card);
      if (!cardAddresses) return;
      const path = cardPath(card.shortId);
      if (cardIdFromPath(window.location.pathname) !== null) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
    },
    [cardAddresses],
  );

  const closeCard = useCallback(() => {
    setOpen(null);
    if (!cardAddresses || cardIdFromPath(window.location.pathname) === null) return;
    if (arrivedOnCard.current) {
      arrivedOnCard.current = false;
      window.history.replaceState(null, "", "/board");
    } else {
      window.history.back();
    }
  }, [cardAddresses]);

  // Back and Forward move between the board and a card's address.
  useEffect(() => {
    if (!cardAddresses) return;
    const onPop = () => {
      const id = cardIdFromPath(window.location.pathname);
      if (!id) {
        setOpen(null);
        return;
      }
      const wanted = id.toUpperCase();
      setOpen(cardsRef.current.find((card) => card.shortId.toUpperCase() === wanted) ?? null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [cardAddresses]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCard();
    },
    [closeCard],
  );
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  // The same card in both layouts: the phone list is a different arrangement
  // of this board, never a second version of it.
  const renderCard = (card: BoardCard) => (
    <Card
      key={card.id}
      card={card}
      onOpen={openCard}
      showProject={showProject}
      selectable={selectable}
      selected={picked.has(card.id)}
      onToggleSelect={onToggleSelect ?? (() => {})}
      t={t}
    />
  );

  // The phone gets the same card reduced to a row: one component less to keep
  // in step, because both read the very same BoardCard.
  const renderRow = (card: BoardCard) => (
    <CardRow
      key={card.id}
      card={card}
      onOpen={openCard}
      showProject={showProject}
      selectable={selectable}
      selected={picked.has(card.id)}
      onToggleSelect={onToggleSelect ?? (() => {})}
      t={t}
    />
  );

  return (
    <>
      <div className="board">
        {COLUMN_STATUSES.map((status) => {
          const list = cards.filter((c) => c.status === status);
          return (
            // The id is the target of the topbar state chips (OCL-20): the
            // review and running counts jump to the column they count.
            <div key={status} id={`board-col-${status}`}>
              <div className="col-head">
                {/* The mark anchors the column, the word still names it. */}
                <StatusMark status={status} />
                <span className="col-title" title={colLabel[status]}>
                  {colLabel[status]}
                </span>
                <span className={countClass(status, viewerRole)}>
                  {columns ? columns.counts[status] : list.length}
                </span>
              </div>
              <div className="col">
                {list.length === 0 && !columns?.next[status] ? (
                  <EmptyState status={status} t={t} />
                ) : (
                  list.map(renderCard)
                )}
                {renderMore(status)}
              </div>
            </div>
          );
        })}
      </div>
      {/* Below the mobile breakpoint the stylesheet hides the columns and
          shows this instead: one column at a time, as a list you can read. */}
      <BoardMobileList
        cards={cards}
        labels={colLabel}
        renderRow={renderRow}
        renderEmpty={(status) => <EmptyState status={status} t={t} />}
        renderMore={renderMore}
        counts={columns?.counts}
        countClass={(status) => countClass(status, viewerRole)}
        t={t}
      />
      {openLine ? (
        <CardSheetBody
          line={openLine}
          detail={detail}
          missions={missions}
          onClose={closeCard}
          viewerRole={viewerRole}
          t={t}
        />
      ) : null}
    </>
  );
}

export type ViewerRole = "admin" | "member";

/** Where the open card sits in the review list, and how to move along it. */
export type ReviewQueuePosition = {
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  /** Validating moves on to the next card instead of closing the sheet. */
  onValidated: () => void;
};

/**
 * The To review counter is the one column count that waits for a person, so
 * it alone wears the attention amber, and only for the admin: a member's
 * cards wait on someone else (F10).
 */
function countClass(status: ColumnStatus, viewerRole: ViewerRole): string {
  return status === "feito" && viewerRole === "admin" ? "count attention" : "count";
}

function CardSheetBody({
  line,
  detail,
  missions,
  onClose,
  viewerRole,
  queue,
  t,
}: {
  line: BoardCard;
  detail: ReturnType<typeof useCardDetail>;
  missions: BoardMissionOption[];
  onClose: () => void;
  viewerRole: ViewerRole;
  queue?: ReviewQueuePosition;
  t: Dict;
}) {
  if (!detail.state || detail.state.status === "loading") return <DetailSkeleton />;
  if (detail.state.status === "error") {
    return (
      <DetailError message={detail.state.error} onRetry={detail.retry} onClose={onClose} t={t} />
    );
  }
  return (
    <Detail
      key={line.id}
      card={{ ...line, ...detail.state.detail }}
      missions={missions}
      onClose={onClose}
      viewerRole={viewerRole}
      queue={queue}
      t={t}
    />
  );
}

/**
 * The card sheet on its own, for a list that is not the board: the To review
 * list opens its cards here, with their place in line (E1). Same detail,
 * same actions, same skeleton and error as the board's.
 */
export function CardSheet({
  card,
  lang,
  missions,
  detailVersion,
  viewerRole,
  queue,
  onClose,
}: {
  card: BoardCard;
  lang: string;
  missions: BoardMissionOption[];
  detailVersion?: string;
  viewerRole: ViewerRole;
  queue?: ReviewQueuePosition;
  onClose: () => void;
}) {
  const t = dict(lang);
  const detail = useCardDetail(card.id, detailVersion, t);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <CardSheetBody
      line={card}
      detail={detail}
      missions={missions}
      onClose={onClose}
      viewerRole={viewerRole}
      queue={queue}
      t={t}
    />
  );
}
