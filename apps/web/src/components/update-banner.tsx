"use client";

import { useState, useTransition } from "react";
import { triggerUpdateAction } from "../actions/updates";
import { dict } from "../lib/i18n";
import type { Runtime } from "../lib/runtime";

export function UpdateBanner({
  version,
  changelog,
  url,
  helper,
  runtime,
  lang,
  manualCommand,
  enableCommand,
  sourceCommand,
}: {
  version: string;
  changelog: string;
  url: string;
  helper: boolean;
  /** From the checkout there is no image to pull: the commands differ. */
  runtime: Runtime;
  lang: string;
  /** Resolved server-side from the deploy mode (OCL-73): hosted instances
   * must never see the quickstart's raw compose command. */
  manualCommand: string;
  enableCommand: string;
  sourceCommand: string;
}) {
  const t = dict(lang);
  const [pending, start] = useTransition();
  const [showCmd, setShowCmd] = useState(false);
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  if (hidden) return null;

  // With the sidecar running the button does the work and the banner stays
  // quiet; without it, the only honest thing to offer is the two commands.
  const onUpdate = () =>
    start(async () => {
      setErr(null);
      if (!helper) {
        setShowCmd(true);
        return;
      }
      const r = await triggerUpdateAction();
      if (!r.ok) setErr(r.error);
      else if (r.triggered) setRequested(true);
      else setShowCmd(true);
    });

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
        <button className="btn-new oc-tappable" disabled={pending || requested} onClick={onUpdate}>
          {t.updates.updateBtn}
        </button>
      </div>
      {notes && showNotes ? <pre className="ub-notes">{notes.slice(0, 800)}</pre> : null}
      {requested ? <p className="wok">{t.updates.updateRequested}</p> : null}
      {showCmd ? (
        runtime === "source" ? (
          <div className="ub-cmd">
            <span>{t.updates.sourceDetected}</span>
            <code>{sourceCommand}</code>
          </div>
        ) : (
          <>
            <div className="ub-cmd">
              <span>{t.updates.runOnServer}</span>
              <code>{manualCommand}</code>
            </div>
            <div className="ub-cmd">
              <span>{t.updates.updaterAbsent}</span>
              <code>{enableCommand}</code>
            </div>
          </>
        )
      ) : null}
      {err ? <p className="werr">{err}</p> : null}
    </div>
  );
}
