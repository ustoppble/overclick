"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createOrganizationAction,
  deleteOrganizationAction,
  saveOrganizationAction,
} from "../../actions/organizations";
import { Markdown } from "../../components/markdown";
import { dict } from "../../lib/i18n";
import { ORGANIZATION_CONTEXT_MAX_CHARS } from "../../lib/organizations";
import styles from "./project-context.module.css";

export type OrganizationRow = {
  id: string;
  name: string;
  context: string;
  /** What the deletion has to refuse over, read before anyone clicks it. */
  projectCount: number;
  missionCount: number;
};

/**
 * Organizations in Settings: create, rename, delete, and the business briefing
 * itself. It is the project context editor's screen on purpose — same picker,
 * same textarea beside the same preview, same counter — because it is the same
 * job on a different row, and a second layout for it would be a second thing
 * to learn.
 */
export function OrganizationContextEditor({
  organizations,
  lang,
}: {
  organizations: OrganizationRow[];
  lang: string;
}) {
  const t = dict(lang);
  const router = useRouter();
  const [rows, setRows] = useState(organizations);
  const [selectedId, setSelectedId] = useState(organizations[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];

  const patchSelected = (patch: Partial<OrganizationRow>) => {
    if (!selected) return;
    setRows((current) =>
      current.map((row) => (row.id === selected.id ? { ...row, ...patch } : row)),
    );
    setMessage(null);
    setError(null);
  };

  const create = () =>
    start(async () => {
      setMessage(null);
      setError(null);
      const result = await createOrganizationAction({ name: newName });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNewName("");
      setMessage(t.settings.organizationCreated);
      router.refresh();
    });

  const save = () =>
    start(async () => {
      if (!selected) return;
      setMessage(null);
      setError(null);
      const result = await saveOrganizationAction({
        organizationId: selected.id,
        name: selected.name,
        context: selected.context,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(t.settings.organizationSaved);
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      if (!selected) return;
      setMessage(null);
      setError(null);
      const result = await deleteOrganizationAction({
        organizationId: selected.id,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows((current) => current.filter((row) => row.id !== selected.id));
      setSelectedId("");
      setMessage(t.settings.organizationDeleted);
      router.refresh();
    });

  const overLimit =
    (selected?.context.length ?? 0) > ORGANIZATION_CONTEXT_MAX_CHARS;

  return (
    <>
      <p className="page-sub">{t.settings.organizationsSub}</p>

      <div className="set-card">
        <label className={styles.fieldLabel} htmlFor="organization-new">
          {t.settings.organizationNew}
        </label>
        <input
          id="organization-new"
          className={`input ${styles.version}`}
          maxLength={200}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t.settings.organizationNewPlaceholder}
        />
        <div className="save-row">
          <button
            className="btn-new"
            type="button"
            disabled={pending || newName.trim().length === 0}
            onClick={create}
          >
            {pending ? t.settings.saving : t.settings.organizationCreate}
          </button>
        </div>
      </div>

      {selected ? (
        <div className="set-card">
          <label className={styles.fieldLabel} htmlFor="settings-organization">
            {t.settings.organizationLabel}
          </label>
          <select
            id="settings-organization"
            className={`sel ${styles.projectPicker}`}
            value={selected.id}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setMessage(null);
              setError(null);
            }}
          >
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>

          <label className={styles.fieldLabel} htmlFor="organization-name">
            {t.settings.organizationName}
          </label>
          <input
            id="organization-name"
            className={`input ${styles.version}`}
            maxLength={200}
            value={selected.name}
            onChange={(event) => patchSelected({ name: event.target.value })}
          />

          <div className={styles.workspace}>
            <div>
              <label className={styles.fieldLabel} htmlFor="organization-context">
                {t.settings.organizationContext}
              </label>
              <textarea
                id="organization-context"
                className={styles.editor}
                value={selected.context}
                onChange={(event) => patchSelected({ context: event.target.value })}
                placeholder={t.settings.organizationContextPlaceholder}
              />
              <span
                className={`${styles.counter}${overLimit ? ` ${styles.counterOver}` : ""}`}
              >
                {t.settings.projectContextCount(
                  selected.context.length,
                  ORGANIZATION_CONTEXT_MAX_CHARS,
                )}
              </span>
            </div>
            <div>
              <span className={styles.previewLabel}>{t.settings.projectPreview}</span>
              <div className={styles.preview}>
                {selected.context.trim() ? (
                  <Markdown text={selected.context} />
                ) : (
                  <p className={styles.empty}>{t.settings.projectPreviewEmpty}</p>
                )}
              </div>
            </div>
          </div>

          <div className="policy-note">{t.settings.organizationContextHint}</div>
          {/* What deletion will refuse over, said before it is attempted. */}
          <div className="policy-note">
            {t.settings.organizationHolds(
              selected.projectCount,
              selected.missionCount,
            )}
          </div>
          {error ? <p className={`werr ${styles.feedback}`} role="alert">{error}</p> : null}
          {message ? <p className={`wok ${styles.feedback}`} role="status">{message}</p> : null}
          <div className="save-row">
            <button
              className="btn-ghost"
              type="button"
              disabled={pending}
              onClick={remove}
            >
              {t.settings.organizationDelete}
            </button>
            <button
              className="btn-new"
              type="button"
              disabled={pending || overLimit}
              onClick={save}
            >
              {pending ? t.settings.saving : t.settings.organizationSave}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
