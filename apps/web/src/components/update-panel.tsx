"use client";

import type { AutoUpdateRecord } from "@agent-board/db";
import { useCallback, useEffect, useState } from "react";
import {
  readUpdaterStateAction,
  runSourceUpdateAction,
  triggerUpdateAction,
} from "../actions/updates";
import { dict } from "../lib/i18n";
import type { Runtime } from "../lib/runtime";
import type { SourceUpdateReport } from "../lib/source-update";
import type { UpdaterState } from "../lib/updates";

/** How often the panel asks the shared volume what the sidecar is doing. */
const POLL_MS = 2000;

/**
 * The Update button, and the honest version of what it can do.
 *
 * With the optional updater profile running, the button asks it to pull the
 * new image and recreate the app, then follows the run to its result. The app
 * is recreated in the middle of that run, so the progress is read from the
 * volume both containers share and survives the restart that kills this page's
 * own server.
 *
 * Without the sidecar there is nothing on this machine allowed to restart a
 * container, so the panel says so and shows the one command that changes it,
 * with what that command costs.
 *
 * None of that exists when the instance runs from the checkout instead of an
 * image: no container to recreate, no profile to enable. There the button runs
 * the update itself, in this process's own repository, and reports every step
 * it took. The commands stay on screen for whoever would rather type them.
 */
export function UpdatePanel({
  version,
  runtime,
  enableCommand,
  manualCommand,
  sourceCommand,
  initialState,
  lastUpdate,
  lang,
}: {
  version: string;
  runtime: Runtime;
  enableCommand: string;
  manualCommand: string;
  sourceCommand: string;
  initialState: UpdaterState;
  /** What the last update did, whoever started it. Null until one runs. */
  lastUpdate: AutoUpdateRecord | null;
  lang: string;
}) {
  const t = dict(lang);
  const [state, setState] = useState(initialState);
  const [running, setRunning] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sourceRunning, setSourceRunning] = useState(false);
  const [report, setReport] = useState<SourceUpdateReport | null>(null);

  const phase = state.status?.phase ?? null;
  const finished = phase === "done" || phase === "failed";

  const poll = useCallback(async () => {
    const result = await readUpdaterStateAction().catch(() => null);
    // A null result is the app being recreated under us. That is the update
    // working, not an error: keep polling until it answers again.
    if (!result) {
      setUnreachable(true);
      return;
    }
    setUnreachable(false);
    if (result.ok) setState(result.state);
    else setErr(result.error);
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [running, poll]);

  // The sidecar reached an end state: stop asking.
  useEffect(() => {
    if (running && finished) setRunning(false);
  }, [running, finished]);

  const update = async () => {
    setErr(null);
    // The previous run's result must not read as this one's: the server drops
    // the status file, this drops the copy already on screen.
    setState((current) => ({ ...current, status: null }));
    setRunning(true);
    const result = await triggerUpdateAction().catch(() => null);
    if (!result) {
      setUnreachable(true);
      return;
    }
    if (!result.ok) {
      setErr(result.error);
      setRunning(false);
      return;
    }
    if (!result.triggered) {
      // The sidecar stopped between the page load and the click.
      setRunning(false);
      await poll();
    }
  };

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

  const phaseLabel = phase ? t.updates.phase[phase] : null;

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
                new Date(lastUpdate.at).toLocaleString(
                  lang === "pt-BR" ? "pt-BR" : "en-US",
                ),
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
      ) : state.running ? (
        <>
          <p className="upd-state ok">{t.updates.updaterDetected}</p>
          <div className="save-row">
            <button className="btn-new" disabled={running} onClick={update}>
              {running ? t.updates.updating : t.updates.updateBtn}
            </button>
          </div>
          {unreachable ? <p className="upd-state">{t.updates.appRestarting}</p> : null}
          {phaseLabel ? (
            <p className={`upd-state${phase === "failed" ? " bad" : phase === "done" ? " ok" : ""}`}>
              {phaseLabel}
            </p>
          ) : null}
          {state.status?.detail ? (
            <pre className="upd-log">{state.status.detail}</pre>
          ) : null}
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            {t.updates.socketNote}
          </div>
        </>
      ) : (
        <>
          <p className="upd-state">{t.updates.updaterAbsent}</p>
          {commandRow(enableCommand)}
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            {t.updates.socketNote}
          </div>
          <p className="upd-state">{t.updates.manualPath}</p>
          {commandRow(manualCommand)}
        </>
      )}
      {err ? <p className="werr">{err}</p> : null}
    </div>
  );
}
