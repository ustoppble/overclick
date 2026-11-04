"use client";

import type { AutoUpdateRecord } from "@agent-board/db";
import { useState } from "react";
import { runSourceUpdateAction } from "../actions/updates";
import { asLang, formatDateTime } from "../lib/format";
import { dict } from "../lib/i18n";
import type { Runtime } from "../lib/runtime";
import type { SourceUpdateReport } from "../lib/source-update";

/**
 * What the Updates tab says about updating this instance.
 *
 * A container instance has no button: nothing in the app may restart a
 * container (that took the docker socket, which is root on the host), so the
 * panel names the one command to run on the server and stops there.
 *
 * An instance that runs from the checkout instead of an image has no container
 * to recreate. There the button runs the update itself, in this process's own
 * repository, and reports every step it took. The commands stay on screen for
 * whoever would rather type them.
 */
export function UpdatePanel({
  version,
  runtime,
  manualCommand,
  sourceCommand,
  lastUpdate,
  lang,
}: {
  version: string;
  runtime: Runtime;
  manualCommand: string;
  sourceCommand: string;
  /** What the last update did, whoever started it. Null until one runs. */
  lastUpdate: AutoUpdateRecord | null;
  lang: string;
}) {
  const t = dict(lang);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sourceRunning, setSourceRunning] = useState(false);
  const [report, setReport] = useState<SourceUpdateReport | null>(null);

  /**
   * The source install path. One call runs the whole thing and answers with
   * the step log: this server updates its own checkout and stays up while it
   * does, so there is nothing to poll from outside.
   */
  const updateFromSource = async (force = false) => {
    setErr(null);
    setReport(null);
    setSourceRunning(true);
    const result = await runSourceUpdateAction({ force }).catch(() => null);
    setSourceRunning(false);
    if (!result) {
      // Only the opt-in restart ends this process, and it answers first.
      setErr(t.updates.appRestarting);
      return;
    }
    if (!result.ok) {
      setErr(result.error);
      return;
    }
    setReport(result.report);
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const runtimeLabel =
    runtime === "container" ? t.updates.runtimeContainer : t.updates.runtimeSource;

  const commandRow = (command: string) => (
    <div className="upd-cmd-row">
      <code>{command}</code>
      <button className="btn-ghost" onClick={() => void copy(command)}>
        {copied === command ? t.detail.copied : t.wizard.copy}
      </button>
    </div>
  );

  return (
    <div className="upd-panel">
      <p className="upd-version">{t.updates.runningVersion(version, runtimeLabel)}</p>

      {runtime === "source" ? (
        <>
          <p className="upd-state">{t.updates.sourceDetected}</p>
          <div className="save-row">
            {/* Force is always here, in every mode: the instance that needs it
                is the one whose version already matches and is still broken. */}
            <button
              className="btn-ghost"
              disabled={sourceRunning}
              title={t.updates.forceNote}
              onClick={() => void updateFromSource(true)}
            >
              {t.updates.forceBtn}
            </button>
            <button
              className="btn-new"
              disabled={sourceRunning}
              onClick={() => void updateFromSource()}
            >
              {sourceRunning ? t.updates.updating : t.updates.sourceUpdateBtn}
            </button>
          </div>
          {report ? null : lastUpdate ? (
            <p className="upd-state">
              {t.updates.lastRun(
                formatDateTime(lastUpdate.at, asLang(lang)),
                t.updates.outcome[lastUpdate.outcome],
                lastUpdate.version,
              )}
            </p>
          ) : null}
          {report ? (
            <>
              {report.outcome === "refused" ? (
                <p className="upd-state bad">
                  {report.reason === "dirty-tree"
                    ? t.updates.refusedDirty
                    : t.updates.refusedNoRepo}
                </p>
              ) : null}
              {report.steps.length ? (
                <ul className="upd-steps">
                  {report.steps.map((step) => (
                    <li key={step.id} className={`upd-step ${step.status}`}>
                      <span className="upd-step-name">{t.updates.step[step.id]}</span>{" "}
                      <span className="upd-step-status">
                        {t.updates.stepStatus[step.status]}
                      </span>
                      {step.note ? <> · {t.updates.stepNote[step.note]}</> : null}
                      {step.detail ? <pre className="upd-log">{step.detail}</pre> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* The refusal already said everything: no result line on top. */}
              {report.outcome !== "refused" ? (
                <p
                  className={`upd-state${
                    report.outcome === "failed"
                      ? " bad"
                      : report.outcome === "updated"
                        ? " ok"
                        : ""
                  }`}
                >
                  {report.outcome === "updated"
                    ? t.updates.resultUpdated
                    : report.outcome === "current"
                      ? t.updates.resultCurrent
                      : t.updates.resultFailed}
                </p>
              ) : null}
              {report.detail ? <pre className="upd-log">{report.detail}</pre> : null}
            </>
          ) : null}
          <p className="upd-state">{t.updates.sourceManualPath}</p>
          {commandRow(sourceCommand)}
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            {t.updates.sourceRestart}
          </div>
        </>
      ) : (
        <>
          <p className="upd-state">{t.updates.serverOnly}</p>
          {commandRow(manualCommand)}
        </>
      )}
      {err ? <p className="werr">{err}</p> : null}
    </div>
  );
}
