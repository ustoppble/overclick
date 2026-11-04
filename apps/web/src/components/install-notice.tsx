"use client";

import { useState, useTransition } from "react";
import { dismissInstallNoticesAction } from "../actions/team";
import { dict } from "../lib/i18n";

/**
 * The admin's heads-up that a member's install worked (OCL-222): the first
 * call of one of their tokens. Dismissing it is remembered per admin, so the
 * same install is announced once.
 */
export function InstallNotice({
  members,
  lang,
}: {
  members: { userId: string; email: string }[];
  lang: string;
}) {
  const t = dict(lang);
  const [hidden, setHidden] = useState(false);
  const [pending, start] = useTransition();
  if (hidden || members.length === 0) return null;

  const dismiss = () =>
    start(async () => {
      const r = await dismissInstallNoticesAction();
      if (r.ok) setHidden(true);
    });

  return (
    <div className="update-banner nebula-glass" role="status">
      <div className="ub-head">
        <b>{t.board.memberInstalled(members.map((m) => m.email))}</b>
        <a href="/settings/team/people">{t.board.memberInstalledLink}</a>
        <div className="spacer" />
        <button className="btn-ghost oc-tappable" disabled={pending} onClick={dismiss}>
          {t.updates.dismiss}
        </button>
      </div>
    </div>
  );
}
