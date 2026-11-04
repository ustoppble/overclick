"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createInvitationAction,
  resendInvitationAction,
  revokeInvitationAction,
  setMemberActiveAction,
  setMemberProjectsAction,
} from "../../actions/team";
import { formatMediumDate } from "../../lib/format";
import type { Dict, Lang } from "../../lib/i18n";
import type { PendingInvitation, TeamMember } from "../../lib/invitations";

/** What the server hands the Team tab. Only an admin ever receives it. */
export type TeamData = {
  currentUserId: string;
  /** Each organization with its projects, the ones a member can be linked to. */
  organizations: { id: string; name: string; projects: { id: string; name: string }[] }[];
  members: TeamMember[];
  invitations: PendingInvitation[];
};

/**
 * Invitations and the people on the board (OCL-222). The same token-row
 * vocabulary as the MCP tokens tab, so a person reads as one more thing the
 * admin can switch off, next to the agents. Each is a Settings page of its
 * own: `section` says which one this is.
 */
export function TeamPanel({
  section,
  currentUserId,
  organizations,
  members,
  invitations,
  origin,
  t,
  lang,
}: TeamData & {
  section: "people" | "invitations";
  origin: string;
  t: Dict;
  lang: Lang;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");
  // No project is ticked by default: the admin says who works on what.
  const [inviteProjects, setInviteProjects] = useState<string[]>([]);
  const [fresh, setFresh] = useState<{ url: string; expiresAt: string } | null>(null);
  // The projects being edited on a member's row, until saved.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const projectsOf = (orgId: string | null) =>
    organizations.find((org) => org.id === orgId)?.projects ?? [];
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  const invite = () =>
    start(async () => {
      setErr(null); setMsg(null); setFresh(null);
      const to = email.trim();
      const r = await createInvitationAction({ email: to, organizationId, projectIds: inviteProjects });
      if (!r.ok) { setErr(r.error); return; }
      setFresh({ url: `${origin}${r.path}`, expiresAt: r.expiresAt });
      setMsg(
        r.emailed
          ? t.settings.teamInviteSent(to.toLowerCase())
          : r.notSentBecause === "public-url"
            ? t.settings.teamInviteNoPublicUrl
            : r.notSentBecause === "failed"
              ? t.settings.teamInviteSendFailed
              : t.settings.teamInviteNotSent,
      );
      setEmail("");
      setInviteProjects([]);
      router.refresh();
    });
  const resend = (inv: PendingInvitation) =>
    start(async () => {
      setErr(null); setMsg(null); setFresh(null);
      const r = await resendInvitationAction(inv.id);
      if (!r.ok) { setErr(r.error); return; }
      setFresh({ url: `${origin}${r.path}`, expiresAt: r.expiresAt });
      setMsg(
        r.emailed
          ? t.settings.teamResent(inv.email)
          : r.notSentBecause === "public-url"
            ? t.settings.teamResentNoPublicUrl
            : r.notSentBecause === "failed"
              ? t.settings.teamResentSendFailed
              : t.settings.teamResentNotSent,
      );
      router.refresh();
    });
  const saveProjects = (id: string, projectIds: string[]) =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await setMemberProjectsAction(id, projectIds);
      if (!r.ok) { setErr(r.error); return; }
      setDrafts((all) => {
        const next = { ...all };
        delete next[id];
        return next;
      });
      setMsg(t.settings.teamProjectsSaved);
      router.refresh();
    });
  const withdraw = (id: string) =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await revokeInvitationAction(id);
      if (!r.ok) setErr(r.error);
      else { setMsg(t.settings.teamWithdrawn); router.refresh(); }
    });
  const setActive = (id: string, active: boolean) =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await setMemberActiveAction(id, active);
      if (!r.ok) setErr(r.error);
      else {
        setMsg(active ? t.settings.teamReactivated : t.settings.teamDeactivated);
        router.refresh();
      }
    });
  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const canInvite = organizations.length > 0;

  return (
    <>
      <p className="page-sub">{t.settings.teamSub}</p>
      {err ? <p className="werr" role="alert">{err}</p> : null}
      {msg ? <p className="wok" role="status">{msg}</p> : null}

      {section === "invitations" ? (<>
      <div className="set-card">
        <div className="sec-cap" id="invitations">{t.settings.teamInviteCap}</div>
        {canInvite ? (
          <form
            className="gen-row"
            style={{ flexWrap: "wrap" }}
            onSubmit={(e) => { e.preventDefault(); invite(); }}
          >
            <input
              id="team-invite-email"
              className="input"
              style={{ maxWidth: 280 }}
              type="email"
              autoComplete="off"
              required
              aria-label={t.settings.teamInviteEmail}
              placeholder={t.settings.teamInviteEmail}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              id="team-invite-organization"
              className="sel"
              aria-label={t.settings.teamInviteOrganization}
              value={organizationId}
              onChange={(e) => { setOrganizationId(e.target.value); setInviteProjects([]); }}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
            <button
              className="btn-new"
              type="submit"
              disabled={pending || !email.includes("@") || !organizationId}
            >
              {pending ? t.wizard.generating : t.settings.teamInviteBtn}
            </button>
            <div className="team-projects" role="group" aria-label={t.settings.teamInviteProjects}>
              <span className="team-projects-cap">{t.settings.teamInviteProjects}</span>
              {projectsOf(organizationId).map((proj) => (
                <label key={proj.id} className="tok-cap">
                  <input
                    type="checkbox"
                    checked={inviteProjects.includes(proj.id)}
                    disabled={pending}
                    onChange={(e) => setInviteProjects((list) => toggle(list, proj.id, e.target.checked))}
                  />
                  <span>{proj.name}</span>
                </label>
              ))}
            </div>
            <div className="policy-note" style={{ borderTop: 0, paddingTop: 0, flexBasis: "100%" }}>
              {projectsOf(organizationId).length === 0
                ? t.settings.teamInviteProjectsNone
                : inviteProjects.length === 0
                  ? t.settings.teamInviteNoProjectWarn
                  : null}
            </div>
          </form>
        ) : (
          <div className="policy-note" style={{ borderTop: 0 }}>
            {t.settings.teamNoOrganizations}
          </div>
        )}
      </div>

      {fresh ? (
        <div className="fresh-tok">
          <div className="lbl">{t.settings.teamInviteLink}</div>
          <div className="cmd">{fresh.url}
            <button className={`copy${copied ? " ok" : ""}`} onClick={copy}>
              {copied ? t.wizard.copied : t.wizard.copy}
            </button>
          </div>
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            {t.settings.teamInviteExpires(formatMediumDate(fresh.expiresAt, lang))}
          </div>
        </div>
      ) : null}

      <div className="sec-cap">{t.settings.teamPendingCap}</div>
      <div className="tok-list">
        {invitations.length === 0 ? (
          <div className="empty-col">{t.settings.teamPendingEmpty}</div>
        ) : (
          invitations.map((inv) => (
            <div key={inv.id} className="tok">
              <div className="meta">
                <div className="label">{inv.email}</div>
                <div className="sub">
                  {inv.organizationName} ·{" "}
                  {t.settings.teamPendingProjects(inv.projects.map((p) => p.name))} ·{" "}
                  {t.settings.teamInviteExpires(formatMediumDate(inv.expiresAt, lang))}
                </div>
              </div>
              <button className="btn-rev" disabled={pending} onClick={() => resend(inv)}>
                {t.settings.teamResend}
              </button>
              <button className="btn-rev" disabled={pending} onClick={() => withdraw(inv.id)}>
                {t.settings.teamWithdraw}
              </button>
            </div>
          ))
        )}
      </div>

      </>) : null}

      {section === "people" ? (<>
      <div className="sec-cap" id="people">{t.settings.teamPeopleCap}</div>
      <div className="tok-list">
        {members.map((person) => (
          // No faded row for a deactivated person: the Reactivate button on it
          // has to stay readable, and the status is spelled out in the line.
          <div key={person.id} className="tok">
            <div className="meta">
              <div className="label">{person.email}</div>
              <div className="sub">
                {person.role === "admin" ? t.settings.teamRoleAdmin : t.settings.teamRoleMember}
                {person.organizationName ? ` · ${person.organizationName}` : ""} ·{" "}
                {person.active ? t.settings.teamActive : t.settings.teamInactive} ·{" "}
                {person.role === "member"
                  ? person.installedAt
                    ? `${t.settings.teamInstalled(formatMediumDate(person.installedAt, lang))} · `
                    : `${t.settings.teamRegistered} · `
                  : ""}
                {t.settings.teamTokens(person.tokens)}
                {person.role === "member"
                  ? ` · ${
                      person.projectIds.length === 0
                        ? t.settings.teamProjectsNone
                        : t.settings.teamProjectsCount(person.projectIds.length)
                    }`
                  : ""}
              </div>
              {person.role === "member" ? (
                <MemberProjects
                  projects={projectsOf(person.organizationId)}
                  linked={person.projectIds}
                  draft={drafts[person.id]}
                  pending={pending}
                  t={t}
                  onChange={(next) => setDrafts((all) => ({ ...all, [person.id]: next }))}
                  onSave={(next) => saveProjects(person.id, next)}
                  email={person.email}
                />
              ) : null}
            </div>
            {person.role === "member" && person.id !== currentUserId ? (
              <button
                className="btn-rev"
                disabled={pending}
                onClick={() => setActive(person.id, !person.active)}
              >
                {person.active ? t.settings.teamDeactivate : t.settings.teamReactivate}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      </>) : null}
    </>
  );
}

/**
 * The projects of the member's organization, each a box to tick, and Save
 * once something changed. The note under them says when the member is left
 * with none: they then see no project at all.
 */
function MemberProjects({
  projects,
  linked,
  draft,
  pending,
  t,
  onChange,
  onSave,
  email,
}: {
  projects: { id: string; name: string }[];
  linked: string[];
  draft: string[] | undefined;
  pending: boolean;
  t: Dict;
  onChange: (next: string[]) => void;
  onSave: (next: string[]) => void;
  email: string;
}) {
  const current = draft ?? linked;
  const changed =
    draft !== undefined &&
    (draft.length !== linked.length || draft.some((id) => !linked.includes(id)));
  if (projects.length === 0) {
    return <div className="team-projects-note">{t.settings.teamProjectsEmptyOrganization}</div>;
  }
  return (
    <>
      <div className="team-projects" role="group" aria-label={`${t.settings.teamProjects} (${email})`}>
        <span className="team-projects-cap">{t.settings.teamProjects}</span>
        {projects.map((proj) => (
          <label key={proj.id} className="tok-cap">
            <input
              type="checkbox"
              checked={current.includes(proj.id)}
              disabled={pending}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...new Set([...current, proj.id])]
                    : current.filter((id) => id !== proj.id),
                )
              }
            />
            <span>{proj.name}</span>
          </label>
        ))}
        {changed ? (
          <button className="btn-rev" disabled={pending} onClick={() => onSave(current)}>
            {t.settings.teamProjectsSave}
          </button>
        ) : null}
      </div>
      {current.length === 0 ? (
        <div className="team-projects-note">{t.settings.teamProjectsNone}</div>
      ) : null}
    </>
  );
}
