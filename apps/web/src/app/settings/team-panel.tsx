"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createInvitationAction,
  revokeInvitationAction,
  setMemberActiveAction,
} from "../../actions/team";
import { formatMediumDate } from "../../lib/format";
import type { Dict, Lang } from "../../lib/i18n";
import type { PendingInvitation, TeamMember } from "../../lib/invitations";

/** What the server hands the Team tab. Only an admin ever receives it. */
export type TeamData = {
  currentUserId: string;
  organizations: { id: string; name: string }[];
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
  const [fresh, setFresh] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const invite = () =>
    start(async () => {
      setErr(null); setMsg(null); setFresh(null);
      const r = await createInvitationAction({ email, organizationId });
      if (!r.ok) { setErr(r.error); return; }
      setFresh({ url: `${origin}${r.path}`, expiresAt: r.expiresAt });
      setEmail("");
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
              onChange={(e) => setOrganizationId(e.target.value)}
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
                  {t.settings.teamInviteExpires(formatMediumDate(inv.expiresAt, lang))}
                </div>
              </div>
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
              </div>
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
