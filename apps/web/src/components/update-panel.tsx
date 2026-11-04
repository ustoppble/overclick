"use client";

import type { AutoUpdateRecord } from "@agent-board/db";
import { useState } from "react";
import { asLang, formatDateTime } from "../lib/format";
import { dict } from "../lib/i18n";
import type { Runtime } from "../lib/runtime";

/**
 * What the Updates tab says about updating this instance: the running version
 * and the one command to run on the server, in every runtime. There is no
 * button: nothing in the app updates the instance (a container update needed
 * the docker socket, which is root on the host, and a source install would be
 * the web process rewriting and restarting itself).
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
  const [copied, setCopied] = useState<string | null>(null);

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
          {lastUpdate ? (
            <p className="upd-state">
              {t.updates.lastRun(
                formatDateTime(lastUpdate.at, asLang(lang)),
                t.updates.outcome[lastUpdate.outcome],
                lastUpdate.version,
              )}
            </p>
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
    </div>
  );
}
