"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { unvalidateTaskAction } from "../../actions/review";
import { CliMark } from "../../components/cli-mark";
import { Icon } from "../../components/icon";
import { subscribeToBoardRefresh } from "../../lib/board-refresh";
import { boardSignatureAction } from "../../actions/board-cards";
import { publishGlobalCounts } from "../../components/global-bar/counts-channel";
import { formatElapsed } from "../../lib/format";
import { dict } from "../../lib/i18n";
import { nextInQueue } from "../../lib/review-queue-order";
import {
  CardSheet,
  type BoardCard,
  type BoardMissionOption,
  type ViewerRole,
} from "./board";

export type ReviewQueueRow = {
  card: BoardCard;
  deliveredAt: string;
  checks: { done: number; total: number };
};

/** How long Undo stays offered after a card is validated. */
const UNDO_MS = 10_000;

type ValidatedToast = { id: string; shortId: string };

/**
 * The To review list (navigation plan E1, F1): every delivery waiting in the
 * reader's scope, from any date, the one delivered longest ago first. The
 * board's period does not apply here. A card opened from it carries its
 * place in line ("1 of 3"); Validate moves on to the next card of the same
 * list and offers Undo, which puts the card back where it was.
 */
export function ReviewQueueView({
  lang,
  rows,
  missions,
  viewerRole,
  scopeLabel,
  count,
  openCardId,
  boardSignature,
}: {
  lang: string;
  rows: ReviewQueueRow[];
  missions: BoardMissionOption[];
  viewerRole: ViewerRole;
  /** The scope in words: "Overclock › overclick", or every project. */
  scopeLabel: string;
  /** How many wait: the queue's length, the number the chip carries (B2). */
  count: number;
  /** The card a link asked to open (?card=OCL-12). */
  openCardId: string | null;
  boardSignature: string;
}) {
  const t = dict(lang);
  const router = useRouter();
  const admin = viewerRole === "admin";
  const ids = useMemo(() => rows.map((row) => row.card.id), [rows]);
  const [openId, setOpenId] = useState<string | null>(openCardId);
  const [toast, setToast] = useState<ValidatedToast | null>(null);
  const [undoing, startUndo] = useTransition();
  const [, startRefresh] = useTransition();
  // A card that just left the list (validated) is still drawn until the
  // sheet moves on; its line is kept here.
  const known = useRef(new Map<string, BoardCard>());
  for (const row of rows) known.current.set(row.card.id, row.card);
  const open = openId ? (known.current.get(openId) ?? null) : null;

  // The list follows writes made elsewhere on the board's cheap poll.
  const signatureRef = useRef(boardSignature);
  signatureRef.current = boardSignature;
  useEffect(
    () =>
      subscribeToBoardRefresh({
        refresh: () => startRefresh(() => router.refresh()),
        signature: async () => {
          const answer = await boardSignatureAction();
          if (answer && "signature" in answer) {
            publishGlobalCounts(answer.counts);
            return answer.signature;
          }
          return answer;
        },
        held: () => signatureRef.current,
      }),
    [router],
  );

  // The address stays the list's (/board?status=feito): rewriting it per card
  // made the refresh after Validate reload the whole document, which took
  // Undo with it. A link with ?card= still opens that card on arrival.
  const show = useCallback((id: string | null) => setOpenId(id), []);

  const step = (delta: number) => {
    if (!openId || ids.length === 0) return;
    const at = ids.indexOf(openId);
    const next = ids[(Math.max(at, 0) + delta + ids.length) % ids.length]!;
    show(next);
  };

  const validated = () => {
    if (!openId) return;
    const card = known.current.get(openId);
    if (card) setToast({ id: card.id, shortId: card.shortId });
    show(nextInQueue(ids, openId));
  };

  const undo = () => {
    if (!toast) return;
    const { id } = toast;
    startUndo(async () => {
      const result = await unvalidateTaskAction(id);
      if (!result.ok) return;
      setToast(null);
      show(id);
      router.refresh();
    });
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const position = open ? ids.indexOf(open.id) : -1;
  const now = Date.now();

  return (
    <div className="rq-page">
      <div className="rq-head">
        <div className="rq-head-text">
          <h1 className="rq-title">
            {admin ? t.review.title : t.review.titleMember}{" "}
            <span className={`rq-n${admin ? " attention" : ""}`}>{count}</span>
          </h1>
          <p className="rq-lead">{admin ? t.review.lead(scopeLabel) : t.review.leadMember}</p>
        </div>
        {admin && rows.length > 0 ? (
          <button type="button" className="rq-oldest" onClick={() => show(ids[0]!)}>
            {t.review.reviewOldest}
            <Icon name="chevronRight" label={null} size={14} />
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <section className="rq-empty">
          <h2>{admin ? t.review.empty : t.review.emptyMember}</h2>
          <p>{admin ? t.review.emptyBody : t.review.emptyMemberBody}</p>
          <a href="/board">{t.review.backToBoard}</a>
        </section>
      ) : (
        <>
          <div className="rq-cols" aria-hidden="true">
            <span>{t.review.colCard}</span>
            <span />
            <span className="rq-hide-md">{t.review.colRanBy}</span>
            <span className="r rq-hide-md">{t.review.colChecks}</span>
            <span className="r rq-hide-md">{t.review.colCost}</span>
            <span className="r">{t.review.colDelivered}</span>
            <span />
          </div>
          <div className="rq-list" role="list">
            {rows.map(({ card, deliveredAt, checks }) => {
              const cost = card.telemetryLine.find((segment) => segment.kind === "cost");
              const context = [card.projectName, card.mission].filter(Boolean).join(" · ");
              return (
                <button
                  key={card.id}
                  type="button"
                  role="listitem"
                  className={`rq-row${card.id === openId ? " current" : ""}`}
                  onClick={() => show(card.id)}
                >
                  <span className="rq-id">{card.shortId}</span>
                  <span className="rq-main">
                    <b title={card.title}>{card.title}</b>
                    <span className="rq-ctx">{context}</span>
                  </span>
                  <span className="rq-who rq-hide-md">
                    <CliMark cli={card.ranCli} />
                    {card.harnessChain ?? ""}
                  </span>
                  <span className="r rq-num rq-hide-md">
                    {checks.total > 0 ? `${checks.done}/${checks.total}` : "—"}
                  </span>
                  <span className="r rq-num rq-hide-md">{cost?.text ?? "—"}</span>
                  <span className="r rq-when">
                    {t.review.deliveredAgo(formatElapsed(now - new Date(deliveredAt).getTime()))}
                  </span>
                  <Icon name="chevronRight" label={null} size={14} />
                </button>
              );
            })}
          </div>
        </>
      )}

      {open ? (
        <CardSheet
          key={open.id}
          card={open}
          lang={lang}
          missions={missions}
          detailVersion={boardSignature}
          viewerRole={viewerRole}
          queue={
            admin && position >= 0
              ? {
                  index: position,
                  total: ids.length,
                  onPrevious: () => step(-1),
                  onNext: () => step(1),
                  onValidated: validated,
                }
              : undefined
          }
          onClose={() => show(null)}
        />
      ) : null}

      {toast ? (
        <div className="rq-toast" role="status">
          <Icon name="check" label={null} size={14} />
          {t.review.validated(toast.shortId)}
          <button type="button" onClick={undo} disabled={undoing}>
            {undoing ? t.review.undoing : t.review.undo}
          </button>
        </div>
      ) : null}
    </div>
  );
}
