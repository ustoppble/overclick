"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createMissionAction } from "../../actions/missions";
import { Icon } from "../../components/icon";
import { dict } from "../../lib/i18n";

/**
 * "+ New mission" on the missions list (E3): a title is all it asks, and the
 * new mission's page is where the rest is written.
 */
export function NewMission({ lang }: { lang: string }) {
  const t = dict(lang);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      setError(null);
      const result = await createMissionAction({ title, objective: "", context: "" });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/missions/${result.mission.id}`);
    });

  if (!open) {
    return (
      <div className="ms-new">
        <button type="button" className="ms-btn primary" onClick={() => setOpen(true)}>
          <Icon name="plus" label={null} size={14} />
          {t.missions.newMission}
        </button>
      </div>
    );
  }
  return (
    <form
      className="ms-new"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <input
        aria-label={t.missions.newMissionTitle}
        placeholder={t.missions.newMissionTitle}
        value={title}
        maxLength={200}
        disabled={pending}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
      />
      {error ? <span className="ms-err">{error}</span> : null}
      <button type="button" className="ms-btn" disabled={pending} onClick={() => setOpen(false)}>
        {t.board.missionCancel}
      </button>
      <button type="submit" className="ms-btn primary" disabled={pending || !title.trim()}>
        {pending ? t.board.missionCreating : t.board.missionCreate}
      </button>
    </form>
  );
}
