"use client";

import { useState } from "react";
import { dict } from "../lib/i18n";
import type { Runtime } from "../lib/runtime";

export function UpdateBanner({
  version,
  changelog,
  url,
  runtime,
  lang,
  manualCommand,
  sourceCommand,
}: {
  version: string;
  changelog: string;
  url: string;
  /** From the checkout there is no image to pull: the commands differ. */
  runtime: Runtime;
  lang: string;
  /** Resolved server-side from the deploy mode (OCL-73): hosted instances
   * must never see the quickstart's raw compose command. */
  manualCommand: string;
  sourceCommand: string;
}) {
  const t = dict(lang);
  const [hidden, setHidden] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  if (hidden) return null;

  const notes = changelog.trim();

  return (
    <div className="update-banner nebula-glass">
      <div className="ub-head">
        <b>{t.updates.newVersion(version)}</b>
        {notes ? (
          <button
            type="button"
            className="ub-notes-toggle"
            aria-expanded={showNotes}
            onClick={() => setShowNotes((v) => !v)}
          >
            {t.updates.releaseNotes} {showNotes ? "▴" : "▾"}
          </button>
        ) : (
          <a href={url} target="_blank" rel="noreferrer">
            {t.updates.releaseNotes}
          </a>
        )}
        <div className="spacer" />
        <button className="btn-ghost oc-tappable" onClick={() => setHidden(true)}>
          {t.updates.dismiss}
        </button>
      </div>
      {notes && showNotes ? <pre className="ub-notes">{notes.slice(0, 800)}</pre> : null}
      {/* No button: the banner only says there is a release and how to get it.
          Updating is a command on the server, never something this page does. */}
      {runtime === "source" ? (
        <div className="ub-cmd">
          <span>{t.updates.bannerSource}</span>
          <code>{sourceCommand}</code>
        </div>
      ) : (
        <div className="ub-cmd">
          <span>{t.updates.runOnServer}</span>
          <code>{manualCommand}</code>
        </div>
      )}
    </div>
  );
}
