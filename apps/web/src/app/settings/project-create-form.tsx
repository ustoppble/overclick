"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createProjectAction } from "../../actions/projects";
import { dict } from "../../lib/i18n";
import { checkProjectPrefix } from "../../lib/project-prefix";
import styles from "./project-context.module.css";

/**
 * "+ Projeto" (E5, the owner's decision): a project made at the screen, in
 * Settings, with the card prefix checked while it is typed. The server runs
 * the same checks again, because two people can type the same prefix.
 */
export function ProjectCreateForm({
  organizations,
  projects,
  lang,
}: {
  organizations: Array<{ id: string; name: string }>;
  projects: Array<{ name: string; idPrefix: string }>;
  lang: string;
}) {
  const t = dict(lang);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [prefix, setPrefix] = useState("");
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = checkProjectPrefix(prefix, projects);
  const typedBad = prefix.trim() !== "" && !check.ok;
  const hint = !check.ok
    ? check.reason === "invalid"
      ? t.projectNew.prefixInvalid
      : check.reason === "taken"
        ? t.projectNew.prefixTaken(prefix.trim().toUpperCase(), check.owner)
        : t.projectNew.prefixHint
    : t.projectNew.prefixOk(check.prefix);

  const create = () =>
    start(async () => {
      setMessage(null);
      setError(null);
      const result = await createProjectAction({
        name,
        repoUrl: repo,
        prefix,
        organizationId: organizationId || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setRepo("");
      setPrefix("");
      setMessage(t.projectNew.created(result.project.name, result.project.idPrefix));
      router.refresh();
    });

  return (
    <div className="set-card" id="new-project">
      <div className="sec-cap">{t.projectNew.title}</div>
      <p className="page-sub">{t.projectNew.sub}</p>

      <label className={styles.fieldLabel} htmlFor="project-new-name">
        {t.projectNew.name}
      </label>
      <input
        id="project-new-name"
        className={`input ${styles.version}`}
        maxLength={200}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t.projectNew.namePlaceholder}
      />

      <label className={styles.fieldLabel} htmlFor="project-new-repo">
        {t.projectNew.repo}
      </label>
      <input
        id="project-new-repo"
        className={`input ${styles.version}`}
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
        placeholder={t.projectNew.repoPlaceholder}
      />

      <label className={styles.fieldLabel} htmlFor="project-new-prefix">
        {t.projectNew.prefix}
      </label>
      <input
        id="project-new-prefix"
        className={`input ${styles.version}`}
        maxLength={4}
        value={prefix}
        onChange={(event) => setPrefix(event.target.value)}
        placeholder={t.projectNew.prefixPlaceholder}
        aria-invalid={typedBad}
        aria-describedby="project-new-prefix-hint"
      />
      <div
        id="project-new-prefix-hint"
        className={typedBad ? "werr" : "policy-note"}
        role={typedBad ? "alert" : undefined}
      >
        {hint}
      </div>
      <div className="policy-note">{t.projectNew.renameWarning}</div>

      {organizations.length > 1 ? (
        <>
          <label className={styles.fieldLabel} htmlFor="project-new-organization">
            {t.projectNew.organization}
          </label>
          <select
            id="project-new-organization"
            className={`sel ${styles.projectPicker}`}
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
          >
            {organizations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </>
      ) : null}

      {error ? <p className={`werr ${styles.feedback}`} role="alert">{error}</p> : null}
      {message ? <p className={`wok ${styles.feedback}`} role="status">{message}</p> : null}
      <div className="save-row">
        <button
          className="btn-new"
          type="button"
          disabled={pending || name.trim().length === 0 || typedBad}
          onClick={create}
        >
          {pending ? t.settings.saving : t.projectNew.create}
        </button>
      </div>
    </div>
  );
}
