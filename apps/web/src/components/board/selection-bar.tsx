"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { discardCardsAction, type KeptCard } from "../../actions/discard";
import {
  assignCardsToMissionAction,
  createMissionAction,
  restoreCardMissionsAction,
  type CardMissionBefore,
} from "../../actions/missions";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../icon";

/**
 * Selecionar (navigation plan E6, F9 of the review): the board's explicit
 * selection mode. The button is always on the filter line; turned on, the
 * cards answer a tap with their checkbox and the bar at the foot reads
 * "Nenhum selecionado" → "N selecionados · Mover para missão… · Descartar ·
 * Cancelar". There is no Validar here, on purpose: validating is read card by
 * card. Descartar is the admin's (task_update needs can_manage), behind a
 * required reason and a confirmation that says how many — and no undo.
 *
 * The move is the code the board already had with no way in (the old
 * BulkMissionBar): assignCardsToMissionAction, the same rule as the card
 * detail's mission field and the MCP's task_update.
 */

type MissionLike = { id: string; title: string; status: "ativa" | "pausada" | "concluida" };

/** The missions a selection may go to: the ones in progress, paused included. */
export function movableMissions<T extends MissionLike>(missions: T[]): T[] {
  return missions.filter((item) => item.status !== "concluida");
}

/** The first sentence of a refusal, for a line that has room for one. */
export function firstSentence(text: string): string {
  const cut = text.search(/[.!?](\s|$)/);
  const head = cut === -1 ? text : text.slice(0, cut + 1);
  // A parenthesis opened in the sentence and closed past it would be cut in
  // half; the clause before it says enough.
  const open = head.indexOf(" (");
  return open > 0 && !head.slice(open).includes(")") ? `${head.slice(0, open)}.` : head;
}

/** What the bar leaves behind once it has acted: a line at the foot of the board. */
export type SelectionNotice =
  | { kind: "moved"; count: number; where: string; previous: CardMissionBefore[] }
  | { kind: "undone" }
  | { kind: "discarded"; count: number; kept: { shortId: string; error: string }[] }
  | { kind: "error"; message: string };

export function SelectToggle({
  on,
  onToggle,
  t,
}: {
  on: boolean;
  onToggle: () => void;
  t: Dict;
}) {
  return (
    <>
      <button
        className={`btn-ghost sel-toggle${on ? " on" : ""}`}
        type="button"
        aria-pressed={on}
        aria-label={t.selection.select}
        onClick={onToggle}
      >
        <Icon name="select" label={null} size={14} />
        <span className="sel-toggle-txt">{on ? t.selection.selecting : t.selection.select}</span>
      </button>
      {on ? <span className="sel-hint">{t.selection.hint}</span> : null}
    </>
  );
}

export function DiscardConfirm({
  count,
  reason,
  pending,
  error,
  onReason,
  onConfirm,
  onCancel,
  t,
}: {
  count: number;
  reason: string;
  pending: boolean;
  error: string | null;
  onReason: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  t: Dict;
}) {
  return (
    <div className="sel-pop sel-discard" role="dialog" aria-label={t.selection.discardTitle(count)}>
      <b className="sel-pop-head">{t.selection.discardTitle(count)}</b>
      <p className="sel-note">{t.selection.discardNote}</p>
      <textarea
        className="sel-reason"
        autoFocus
        rows={3}
        placeholder={t.selection.discardReason}
        aria-label={t.selection.discardReason}
        value={reason}
        disabled={pending}
        onChange={(event) => onReason(event.target.value)}
      />
      {error ? <p className="sel-err">{error}</p> : null}
      <div className="sel-pop-row">
        <button className="sel-btn quiet" type="button" disabled={pending} onClick={onCancel}>
          {t.selection.cancel}
        </button>
        <button
          className="sel-btn danger"
          type="button"
          disabled={pending || !reason.trim()}
          onClick={onConfirm}
        >
          {pending ? t.selection.discarding : t.selection.discardConfirm(count)}
        </button>
      </div>
    </div>
  );
}

type Open = "none" | "menu" | "create" | "discard";

export function SelectionBar({
  selected,
  shortIds,
  missions,
  organizationId,
  viewerRole,
  onMoved,
  onDiscarded,
  onCancel,
  t,
}: {
  selected: string[];
  /** id → short id, to name the cards a partial discard left behind. */
  shortIds: Map<string, string>;
  missions: MissionLike[];
  /** The business the board is filtered to, where "Nova missão…" files it. */
  organizationId: string | null;
  viewerRole: "admin" | "member";
  onMoved: (notice: Extract<SelectionNotice, { kind: "moved" }>) => void;
  onDiscarded: (notice: Extract<SelectionNotice, { kind: "discarded" }>) => void;
  onCancel: () => void;
  t: Dict;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<Open>("none");
  const [reason, setReason] = useState("");
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const n = selected.length;
  const canDiscard = viewerRole === "admin";
  const openRef = useRef(open);
  openRef.current = open;

  // Esc closes what is open on the bar first, then leaves the mode; a tap
  // outside closes the menu. The bar exists only while the mode does.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (openRef.current !== "none") {
        setOpen("none");
        setErr(null);
      } else onCancel();
    }
    function onPointerDown(event: PointerEvent) {
      if (openRef.current === "none") return;
      if (!root.current?.contains(event.target as Node)) setOpen("none");
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onCancel]);

  // Nothing picked, nothing to act on: an open menu or confirmation closes.
  useEffect(() => {
    if (n === 0) setOpen("none");
  }, [n]);

  const move = (missionId: string | null, where: string) =>
    start(async () => {
      setErr(null);
      const r = await assignCardsToMissionAction(selected, missionId);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      onMoved({ kind: "moved", count: n, where, previous: r.previous });
      router.refresh();
    });

  const createAndMove = () =>
    start(async () => {
      setErr(null);
      const created = await createMissionAction({
        title,
        objective: "",
        context: "",
        organizationId,
      });
      if (!created.ok) {
        setErr(created.error);
        return;
      }
      const r = await assignCardsToMissionAction(selected, created.mission.id);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      onMoved({ kind: "moved", count: n, where: title.trim(), previous: r.previous });
      router.refresh();
    });

  const discard = () =>
    start(async () => {
      setErr(null);
      const r = await discardCardsAction(selected, reason);
      const named = (kept: KeptCard[] | undefined) =>
        (kept ?? []).map((k) => ({ shortId: shortIds.get(k.id) ?? k.id, error: k.error }));
      if (!r.ok) {
        const kept = named(r.kept);
        setErr(
          kept.length > 0
            ? `${t.selection.keptHead(kept.length)} ${kept.map((k) => `${k.shortId}: ${firstSentence(k.error)}`).join(" · ")}`
            : r.error,
        );
        return;
      }
      onDiscarded({ kind: "discarded", count: r.discarded.length, kept: named(r.kept) });
      router.refresh();
    });

  const shown = movableMissions(missions);

  return (
    <div className="sel-bar" role="region" aria-label={t.selection.region} ref={root}>
      <span className="sel-count">{n === 0 ? t.selection.none : t.selection.count(n)}</span>
      <div className="sel-move">
        <button
          className="sel-btn primary"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open === "menu" || open === "create"}
          disabled={n === 0 || pending}
          onClick={() => {
            setErr(null);
            setOpen((current) => (current === "menu" || current === "create" ? "none" : "menu"));
          }}
        >
          {t.selection.move}
          <Icon name="chevronDown" label={null} size={14} />
        </button>
        {open === "menu" ? (
          <div className="sel-pop sel-menu" role="menu" aria-label={t.selection.movePanel(n)}>
            <span className="sel-pop-label">{t.selection.movePanel(n)}</span>
            {shown.map((item) => (
              <button
                key={item.id}
                className="sel-mi"
                type="button"
                role="menuitem"
                disabled={pending}
                onClick={() => move(item.id, item.title)}
              >
                <span className="sel-mi-title" title={item.title}>
                  {item.title}
                </span>
                {item.status === "pausada" ? (
                  <span className="sel-mi-end">{t.selection.paused}</span>
                ) : null}
              </button>
            ))}
            <hr />
            <button
              className="sel-mi"
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={() => move(null, t.selection.noMission)}
            >
              {t.selection.noMission}
            </button>
            <button
              className="sel-mi"
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={() => setOpen("create")}
            >
              <Icon name="plus" label={null} size={14} />
              {t.selection.newMission}
            </button>
            {err ? <p className="sel-err">{err}</p> : null}
          </div>
        ) : null}
        {open === "create" ? (
          <div className="sel-pop sel-create" role="dialog" aria-label={t.selection.newMission}>
            <span className="sel-pop-label">{t.selection.movePanel(n)}</span>
            <input
              className="sel-input"
              autoFocus
              maxLength={200}
              placeholder={t.selection.newMissionTitle}
              aria-label={t.selection.newMissionTitle}
              value={title}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && title.trim()) createAndMove();
              }}
            />
            {err ? <p className="sel-err">{err}</p> : null}
            <div className="sel-pop-row">
              <button
                className="sel-btn quiet"
                type="button"
                disabled={pending}
                onClick={() => setOpen("menu")}
              >
                {t.selection.cancel}
              </button>
              <button
                className="sel-btn primary"
                type="button"
                disabled={pending || !title.trim()}
                onClick={createAndMove}
              >
                {t.selection.createAndMove}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {canDiscard ? (
        <button
          className="sel-btn danger quiet sel-discard-btn"
          type="button"
          disabled={n === 0 || pending}
          onClick={() => {
            setErr(null);
            setOpen("discard");
          }}
        >
          {t.selection.discard}
        </button>
      ) : null}
      <button className="sel-btn quiet sel-cancel" type="button" disabled={pending} onClick={onCancel}>
        {t.selection.cancel}
      </button>
      {open === "discard" ? (
        <DiscardConfirm
          count={n}
          reason={reason}
          pending={pending}
          error={err}
          onReason={setReason}
          onConfirm={discard}
          onCancel={() => {
            setOpen("none");
            setErr(null);
          }}
          t={t}
        />
      ) : null}
      {err && open === "none" ? <p className="sel-err sel-bar-err">{err}</p> : null}
    </div>
  );
}

/**
 * The line the bar leaves once it has acted: "N cards movidos para X ·
 * Desfazer", the undo of a move, or what a discard did and which cards stayed.
 */
export function SelectionNoticeLine({
  notice,
  onChange,
  t,
}: {
  notice: SelectionNotice;
  onChange: (next: SelectionNotice | null) => void;
  t: Dict;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // A plain confirmation goes by itself; one that lists cards left behind,
  // or an error, waits to be read and closed.
  useEffect(() => {
    const lasting =
      notice.kind === "error" || (notice.kind === "discarded" && notice.kept.length > 0);
    if (lasting) return;
    const timer = window.setTimeout(() => onChange(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [notice, onChange]);

  const undo = (previous: CardMissionBefore[]) =>
    start(async () => {
      const r = await restoreCardMissionsAction(previous);
      onChange(r.ok ? { kind: "undone" } : { kind: "error", message: r.error });
      router.refresh();
    });

  let text: string;
  if (notice.kind === "moved") text = t.selection.moved(notice.count, notice.where);
  else if (notice.kind === "undone") text = t.selection.undone;
  else if (notice.kind === "error") text = notice.message;
  else text = t.selection.discarded(notice.count);

  return (
    <div className="sel-toast" role="status">
      {notice.kind === "error" ? null : <Icon name="check" label={null} size={14} />}
      <span className="sel-toast-txt">
        {text}
        {notice.kind === "discarded" && notice.kept.length > 0 ? (
          <span className="sel-toast-kept">
            {" · "}
            {t.selection.keptHead(notice.kept.length)}
            {notice.kept.map((k) => (
              // The tool's whole explanation stays on the title; the line
              // carries its first sentence, the one that says why.
              <span key={k.shortId} className="sel-kept" title={k.error}>
                <b>{k.shortId}</b> {firstSentence(k.error)}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {notice.kind === "moved" ? (
        <button
          className="sel-btn sm"
          type="button"
          disabled={pending}
          onClick={() => undo(notice.previous)}
        >
          {t.selection.undo}
        </button>
      ) : (
        <button
          className="sel-btn sm quiet"
          type="button"
          aria-label={t.selection.dismiss}
          onClick={() => onChange(null)}
        >
          <Icon name="close" label={null} size={14} />
        </button>
      )}
    </div>
  );
}
