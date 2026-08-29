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
import {
  answerOpenTaskAction,
  reopenTaskAction,
  tickValidationStepAction,
  validateTaskAction,
} from "../../actions/review";
import {
  COLUMN_STATUSES,
  type ColumnStatus,
} from "../../lib/board-columns";
import { pickRowNumber, typeInitial } from "../../lib/board-row";
import { cliDiffers } from "../../lib/cli-mark";
import { dict, type Dict } from "../../lib/i18n";
import { CliMark } from "../../components/cli-mark";
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
    | "claim_release"
    | "claim_stale";
  body: string;
  author: string | null;
  at: string;
};

export type BoardCard = {
  id: string;
  shortId: string;
  title: string;
  tipo: "feature" | "bug" | "rfc";
  priority: "urgente" | "alta" | "media" | "baixa";
  status: "aberto" | "em_execucao" | "feito" | "validado" | "descartado";
  supersedes: { id: string; shortId: string } | null;
  supersededBy: { id: string; shortId: string } | null;
  isExample: boolean;
  oQue: string;
  porQue: string;
  comoConfirmo: ConfirmStep[];
  validationTicks: ValidationTickView[];
  howToVerify: string | null;
  /** The business the card's project belongs to, which the board filters by. */
  organizationId: string;
  projectId: string;
  projectName: string;
  missionId: string | null;
  mission: string | null;
  /** Planned harness with its effort, for the detail panel. */
  harness: string | null;
  /** The CLI the card planned, for its brand mark. Null when it planned none. */
  plannedCli: string | null;
  /** The CLI that actually claimed the card, for its brand mark. */
  ranCli: string | null;
  /** Every distinct CLI that attempted this card, including earlier reopens. */
  executors: string[];
  /** Plan and reality in one value: "sonnet-5", or "sonnet-5 → fable-5". */
  harnessChain: string | null;
  /** What actually ran, set only when it was not what the card planned. */
  harnessRan: string | null;
  /** Where the attempt's current model identity came from. */
  modelSource: "declared" | "harness" | "measured" | null;
  /** True when this card waits on the review of whoever is looking at it. */
  awaitingMyReview: boolean;
  devolve: string;
  origem: string;
  executor: string | null;
  elapsed: string | null;
  /** Lease age, independent from total time since claim. */
  claimInactive: string | null;
  /** True once another executor may reclaim without force. */
  claimStale: boolean;
  branch: string | null;
  commit?: string | null;
  commitUrl?: string | null;
  deliveryUnverified?: boolean;
  deliveryVerification?: "verified" | "unverified" | null;
  deliveryWarning?: string | null;
  resolvedIn: string | null;
  reportsCount: number;
  timeline: TimelineEntry[];
  /** The whole breakdown in words, for the detail panel. */
  telemetry: string | null;
  /** The same numbers spelled for the single line the card has. */
  telemetryLine: TelemetrySegment[];
  /** Null when neither clock ran on this card. */
  duration: DurationView | null;
  /** Server guard: this attempt's counters stay outside trusted Insights totals. */
  usageSuspect: boolean;
  transcript: TranscriptView | null;
  handoff: string | null;
};

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
    return activity ? (
      <span className="telemetry">
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
 * The CLI of a card, as the brand mark the app already ships (AGB-66). The
 * plan's mark leads, and when another CLI actually took the card its mark
 * follows: the same planned to actual reading the model chain has, in the
 * width a glyph costs instead of the width a word costs.
 */
function CardCli({ card }: { card: BoardCard }) {
  const swapped = cliDiffers(card.plannedCli, card.ranCli);
  const lead = card.plannedCli ?? card.ranCli;
  if (!lead) return null;
  return (
    <span className="meta-cli">
      <CliMark cli={lead} />
      {swapped ? (
        <>
          <span className="meta-cli-arrow" aria-hidden="true">
            →
          </span>
          <CliMark cli={card.ranCli} />
        </>
      ) : null}
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
  const harness =
    card.harnessChain ?? (exec ? (card.executor ?? t.board.agent) : null);
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
      <CliMark cli={card.ranCli ?? card.plannedCli} />
      {num ? <span className={`ml-num tel-${num.kind}`}>{num.text}</span> : null}
    </div>
  );
}

function fmtTickWhen(at: string): string {
  const d = new Date(at);
  return d.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  card: BoardCard;
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
                  {t.detail.checkedBy} {tick.byEmail} · {fmtTickWhen(tick.at)}
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

function CardLocation({
  card,
  onMissionSelect,
  onClose,
  t,
}: {
  card: BoardCard;
  onMissionSelect?: (missionId: string) => void;
  onClose: () => void;
  t: Dict;
}) {
  const hasMission = Boolean(card.missionId && card.mission?.trim());

  return (
    <nav className="d-location" aria-label={t.detail.cardLocation}>
      <span className="d-location-project" title={card.projectName}>
        {card.projectName}
      </span>
      <span className="d-location-separator" aria-hidden="true">
        ›
      </span>
      {hasMission ? (
        onMissionSelect ? (
          <button
            className="d-location-mission"
            type="button"
            onClick={() => {
              onMissionSelect(card.missionId!);
              onClose();
            }}
            aria-label={t.detail.filterByMission}
            title={card.mission!}
          >
            {card.mission}
          </button>
        ) : (
          <span className="d-location-mission" title={card.mission!}>
            {card.mission}
          </span>
        )
      ) : (
        <span className="d-location-empty">{t.detail.missionNone}</span>
      )}
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
  t,
}: {
  card: BoardCard;
  allTicked: boolean;
  onClose: () => void;
  t: Dict;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reopening, setReopening] = useState(false);
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<string | null>(null);

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

  if (card.status !== "feito") return null;

  const validate = (override: boolean) =>
    start(async () => {
      setErr(null);
      const r = await validateTaskAction(card.id, { override });
      if (!r.ok) setErr(r.error);
      else {
        onClose();
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

  return (
    <div className="d-actions">
      {err ? <p className="d-err">{err}</p> : null}
      <div className="d-actions-row">
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
  onMissionSelect,
  onClose,
  t,
}: {
  card: BoardCard;
  missions: BoardMissionOption[];
  onMissionSelect?: (missionId: string) => void;
  onClose: () => void;
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
          <span>{card.shortId}</span>
          <CardLocation
            card={card}
            onMissionSelect={onMissionSelect}
            onClose={onClose}
            t={t}
          />
          <span className={`tag ${card.tipo}`}>{card.tipo}</span>
          <span className={`d-status ${STATUS_CHIP[card.status]}`}>
            {/* The same mark the card's column carries on the board, so the
                chip and the column say the same thing the same way. */}
            <Icon name={COLUMN_ICON[card.status]} label={null} size={11} />
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
            <div>
              <SectionLabel icon="harness" text={t.detail.harness} />
              <p className="d-mono d-harness">
                <CardCli card={card} />
                <span>{card.harness ?? "—"}</span>
              </p>
              {/* The board folds plan and reality into one value; here they
                  stay apart, so the effort planned and the model that ran are
                  both readable. */}
              {card.harnessRan ? (
                <p className="d-mono d-harness-ran">
                  {t.detail.harnessRan} {card.harnessRan}
                </p>
              ) : null}
              {card.modelSource === "harness" ? (
                <p>
                  <span className="tag feature">
                    {t.detail.modelSourceHarness}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
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
        <DetailActions card={card} allTicked={allTicked} onClose={onClose} t={t} />
      </div>
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
  onMissionSelect,
}: {
  cards: BoardCard[];
  lang: string;
  missions: BoardMissionOption[];
  /** True while more than one project shares the board. */
  showProject?: boolean;
  selectable?: boolean;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  onMissionSelect?: (missionId: string) => void;
}) {
  const t = dict(lang);
  const colLabel = columnLabels(t);
  const [open, setOpen] = useState<BoardCard | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const picked = new Set(selectedIds);

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(null);
  }, []);
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  // A short loading beat when opening a card lets the modal show a skeleton
  // instead of popping straight into content, matching the loading states of
  // the other three surfaces without changing how the card data is fetched.
  const openCard = useCallback((card: BoardCard) => {
    setOpen(card);
    setDetailLoading(true);
    const timer = window.setTimeout(() => setDetailLoading(false), 180);
    return () => window.clearTimeout(timer);
  }, []);

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
                <Icon
                  name={COLUMN_ICON[status]}
                  label={null}
                  size={14}
                  className="col-mark"
                />
                {colLabel[status]} <span className="count">{list.length}</span>
              </div>
              <div className="col">
                {list.length === 0 ? (
                  <EmptyState status={status} t={t} />
                ) : (
                  list.map(renderCard)
                )}
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
        t={t}
      />
      {open && detailLoading ? <DetailSkeleton /> : null}
      {open && !detailLoading ? (
        <Detail
          card={open}
          missions={missions}
          onMissionSelect={onMissionSelect}
          onClose={() => setOpen(null)}
          t={t}
        />
      ) : null}
    </>
  );
}
