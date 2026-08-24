"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  deleteEmptyMissionAction,
  updateMissionAction,
} from "../../actions/missions";
import { Markdown } from "../../components/markdown";
import type { Dict } from "../../lib/i18n";
import type { BoardMissionOption } from "./board";
import { MissionProgressBar } from "./mission-progress-bar";

function statusLabel(status: BoardMissionOption["status"], t: Dict): string {
  if (status === "pausada") return t.board.missionStatusPaused;
  if (status === "concluida") return t.board.missionStatusCompleted;
  return t.board.missionStatusActive;
}

/** Static reading kept separate so the render contract has a focused test. */
export function MissionOverview({
  mission,
  t,
}: {
  mission: BoardMissionOption;
  t: Dict;
}) {
  const counts = [
    [t.board.statusOpen, mission.counts.aberto],
    [t.board.statusInProgress, mission.counts.em_execucao],
    [t.board.statusDone, mission.counts.feito],
    [t.board.statusValidated, mission.counts.validado],
  ] as const;

  return (
    <div className="mission-overview">
      <div className="mission-heading">
        <div className="mission-kicker">
          <span>{t.board.missionLabel}</span>
          <span className={`mission-status ${mission.status}`}>
            {statusLabel(mission.status, t)}
          </span>
        </div>
        <h1>{mission.title}</h1>
        {mission.objective ? (
          <Markdown text={mission.objective} className="mission-objective" />
        ) : (
          <p className="mission-empty">{t.board.missionNoObjective}</p>
        )}
      </div>
      <div className="mission-counts" aria-label={t.board.missionCardCounts}>
        {counts.map(([label, value]) => (
          <span className="mission-count" key={label}>
            <b>{value}</b>
            {label}
          </span>
        ))}
      </div>
      <div className="mission-progress-row">
        <MissionProgressBar counts={mission.counts} t={t} size="lg" />
      </div>
      <details className="mission-context">
        <summary>{t.board.missionContext}</summary>
        {mission.context ? (
          <Markdown text={mission.context} />
        ) : (
          <p className="mission-empty">{t.board.missionNoContext}</p>
        )}
      </details>
    </div>
  );
}

export function MissionHeader({
  mission,
  t,
  onDeleted,
}: {
  mission: BoardMissionOption;
  t: Dict;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState(mission.title);
  const [objective, setObjective] = useState(mission.objective);
  const [context, setContext] = useState(mission.context);
  const [status, setStatus] = useState(mission.status);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    setEditing(false);
    setConfirmingDelete(false);
    setTitle(mission.title);
    setObjective(mission.objective);
    setContext(mission.context);
    setStatus(mission.status);
    setError(null);
  }, [mission]);

  function save() {
    start(async () => {
      setError(null);
      const result = await updateMissionAction({
        missionId: mission.id,
        title,
        objective,
        context,
        status,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function remove() {
    start(async () => {
      setError(null);
      const result = await deleteEmptyMissionAction(mission.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDeleted();
      router.refresh();
    });
  }

  return (
    <section
      className="mission-header nebula-glass"
      aria-label={t.board.missionLabel}
    >
      {editing ? (
        <div className="mission-editor">
          <div className="mission-editor-fields">
            <label>
              <span>{t.board.missionTitle}</span>
              <input
                value={title}
                maxLength={200}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              <span>{t.board.missionStatus}</span>
              <select
                value={status}
                disabled={pending}
                onChange={(event) =>
                  setStatus(event.target.value as BoardMissionOption["status"])
                }
              >
                <option value="ativa">{t.board.missionStatusActive}</option>
                <option value="pausada">{t.board.missionStatusPaused}</option>
                <option value="concluida">{t.board.missionStatusCompleted}</option>
              </select>
            </label>
            <label className="mission-field-wide">
              <span>{t.board.missionObjective}</span>
              <textarea
                value={objective}
                rows={3}
                disabled={pending}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <label className="mission-field-wide">
              <span>{t.board.missionContext}</span>
              <textarea
                value={context}
                rows={8}
                disabled={pending}
                onChange={(event) => setContext(event.target.value)}
              />
            </label>
          </div>
          <div className="mission-preview">
            <span className="mission-form-label">{t.board.missionPreview}</span>
            <Markdown text={objective || t.board.missionNoObjective} />
            {context ? <Markdown text={context} /> : null}
          </div>
          {error ? <p className="mission-error">{error}</p> : null}
          <div className="mission-actions">
            <button
              className="d-btn-sec"
              type="button"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              {t.board.missionCancel}
            </button>
            <button
              className="d-btn-pri"
              type="button"
              disabled={pending || title.trim().length === 0}
              onClick={save}
            >
              {pending ? t.board.missionSaving : t.board.missionSave}
            </button>
          </div>
        </div>
      ) : (
        <>
          <MissionOverview mission={mission} t={t} />
          {error ? <p className="mission-error">{error}</p> : null}
          <div className="mission-actions">
            {mission.counts.total === 0 ? (
              confirmingDelete ? (
                <div className="mission-delete-confirm">
                  <span>{t.board.missionDeleteConfirm}</span>
                  <button
                    className="d-btn-sec"
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    {t.board.missionCancel}
                  </button>
                  <button
                    className="mission-delete-button"
                    type="button"
                    disabled={pending}
                    onClick={remove}
                  >
                    {pending ? t.board.missionDeleting : t.board.missionDelete}
                  </button>
                </div>
              ) : (
                <button
                  className="mission-delete-button"
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                >
                  {t.board.missionDelete}
                </button>
              )
            ) : null}
            <button
              className="d-btn-sec"
              type="button"
              onClick={() => setEditing(true)}
            >
              {t.board.missionEdit}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
