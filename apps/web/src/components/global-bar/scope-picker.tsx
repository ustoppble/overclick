"use client";

import { useEffect, useRef, useState } from "react";
import {
  projectsInOrganizations,
  selectOnly,
  toggleOrganization,
  toggleProject,
} from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../icon";

export type ScopeOrganization = { id: string; name: string };
export type ScopeProject = { id: string; name: string; organizationId: string };
export type ScopeValue = { organizationIds: string[]; projectIds: string[] };

/** The scope in words, organization first: "Overclock › overclick". */
export function scopeWords(
  organizations: ScopeOrganization[],
  projects: ScopeProject[],
  value: ScopeValue,
  t: Dict,
): { organization: string; project: string } {
  const organization =
    value.organizationIds.length === 1
      ? (organizations.find((item) => item.id === value.organizationIds[0])?.name ??
        t.board.allOrganizations)
      : value.organizationIds.length > 1
        ? t.board.organizationsPicked(value.organizationIds.length)
        : organizations.length === 1
          ? organizations[0]!.name
          : t.board.allOrganizations;
  const project =
    value.projectIds.length === 1
      ? (projects.find((item) => item.id === value.projectIds[0])?.name ?? t.board.allProjects)
      : value.projectIds.length > 1
        ? t.board.projectsPicked(value.projectIds.length)
        : projects.length === 1
          ? projects[0]!.name
          : t.board.allProjects;
  return { organization, project };
}

/**
 * The scope, in the global bar (navigation plan E4): organization › projects in
 * one control, right after the wordmark, the same on the Board, Missões and
 * Consumo. It took over the board's organization and project filters, with
 * their rules (toggle, "only", All at both ends). With one organization and one
 * project there is nothing to choose, so it is the name as fixed text (F17).
 * On the phone it keeps the organization only.
 */
export function ScopePicker({
  organizations,
  projects,
  value,
  onChange,
  t,
}: {
  organizations: ScopeOrganization[];
  projects: ScopeProject[];
  value: ScopeValue;
  onChange: (next: ScopeValue) => void;
  t: Dict;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const words = scopeWords(organizations, projects, value, t);
  const badge = (words.organization.trim()[0] ?? "?").toUpperCase();
  const label = (
    <>
      <span className="gb-scope-badge" aria-hidden="true">
        {badge}
      </span>
      <span className="gb-scope-org">{words.organization}</span>
      <span className="gb-scope-sep" aria-hidden="true">
        ›
      </span>
      <span className="gb-scope-proj">{words.project}</span>
    </>
  );

  if (organizations.length <= 1 && projects.length <= 1) {
    return (
      <span className="gb-scope gb-scope-fixed" title={`${words.organization} › ${words.project}`}>
        {label}
      </span>
    );
  }

  const shownProjects = projectsInOrganizations(projects, value.organizationIds);
  const allOrganizations = value.organizationIds.length === 0;
  const allProjects = value.projectIds.length === 0;

  const row = (
    key: string,
    name: string,
    picked: boolean,
    onToggle: () => void,
    onOnly: (() => void) | null,
  ) => (
    <div className="gb-scope-row" role="presentation" key={key}>
      <button
        type="button"
        role="option"
        aria-selected={picked}
        className={`gb-scope-opt${picked ? " on" : ""}`}
        onClick={onToggle}
      >
        <span className="gb-scope-box" aria-hidden="true">
          {picked ? <Icon name="check" label={null} size={12} /> : null}
        </span>
        <span className="gb-scope-name" title={name}>
          {name}
        </span>
      </button>
      {onOnly ? (
        <button
          type="button"
          className="gb-scope-only"
          title={t.board.filterOnlyHint(name)}
          aria-label={t.board.filterOnlyHint(name)}
          onClick={onOnly}
        >
          {t.board.filterOnly}
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="gb-scope-wrap" ref={root}>
      <button
        type="button"
        className="gb-scope"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t.filterLine.scope}: ${words.organization} › ${words.project}`}
        title={`${words.organization} › ${words.project}`}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        <Icon name="chevronDown" label={null} size={14} />
      </button>
      {open ? (
        <div className="gb-scope-panel" role="dialog" aria-label={t.filterLine.scope}>
          {organizations.length > 1 ? (
            <section aria-labelledby="gb-scope-orgs">
              <h3 id="gb-scope-orgs">{t.filterLine.scopeOrganizations}</h3>
              <div role="listbox" aria-multiselectable="true" aria-labelledby="gb-scope-orgs">
                {row("all", t.board.allOrganizations, allOrganizations, () =>
                  onChange({ organizationIds: [], projectIds: [] }), null)}
                {organizations.map((org) =>
                  row(
                    org.id,
                    org.name,
                    value.organizationIds.includes(org.id),
                    // The projects on screen belong to the business that just
                    // changed; keeping them would leave an empty board.
                    () =>
                      onChange({
                        organizationIds: toggleOrganization(value.organizationIds, org.id, organizations),
                        projectIds: [],
                      }),
                    () => onChange({ organizationIds: selectOnly(org.id, organizations), projectIds: [] }),
                  ),
                )}
              </div>
            </section>
          ) : null}
          <section aria-labelledby="gb-scope-projects">
            <h3 id="gb-scope-projects">{t.filterLine.scopeProjects}</h3>
            <div role="listbox" aria-multiselectable="true" aria-labelledby="gb-scope-projects">
              {row("all", t.board.allProjects, allProjects, () =>
                onChange({ ...value, projectIds: [] }), null)}
              {shownProjects.map((proj) =>
                row(
                  proj.id,
                  proj.name,
                  value.projectIds.includes(proj.id),
                  () =>
                    onChange({
                      ...value,
                      projectIds: toggleProject(value.projectIds, proj.id, shownProjects),
                    }),
                  () => onChange({ ...value, projectIds: selectOnly(proj.id, shownProjects) }),
                ),
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
