"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { saveExecutorsAction } from "../../actions/executors";
import { saveProjectAction } from "../../actions/onboarding";
import {
  createPairingCodeAction,
  createTokenAction,
  pollPairingAction,
  pollTokenAction,
  workspaceEverConnectedAction,
} from "../../actions/tokens";
import { Icon } from "../../components/icon";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import {
  ExecutorsGrid,
  type ExecutorSelection,
} from "../../components/executors-grid";
import {
  PluginInstall,
  type PluginPairing,
} from "../../components/plugin-install";
import { dict } from "../../lib/i18n";
import { commandFor } from "./commands";

type ProjectData = {
  name: string;
  repoUrl: string;
  prefix: string;
  nextNumber: number;
};

const CMD_TABS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "gemini-cli", label: "Gemini" },
  { id: "outro", label: "Other" },
] as const;

export function Wizard({
  host,
  origin,
  initialStep,
  project,
  executors,
  lang,
}: {
  host: string;
  origin: string;
  initialStep: number;
  project: ProjectData | null;
  executors: ExecutorSelection;
  lang: string;
}) {
  const t = dict(lang);
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // ---- T1
  const [name, setName] = useState(project?.name ?? "");
  const [repo, setRepo] = useState(project?.repoUrl ?? "");
  const [prefix, setPrefix] = useState(project?.prefix ?? "");
  const [prefixTouched, setPrefixTouched] = useState(Boolean(project));
  const nextNumber = project?.nextNumber ?? 1;

  const derivePrefix = (n: string) => {
    const words = n.trim().split(/\s+/).filter(Boolean);
    let p = words.map((w) => w[0]).join("").toUpperCase().slice(0, 3);
    if (p.length < 2) p = n.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
    return p;
  };

  // ---- T2
  const [sel, setSel] = useState<ExecutorSelection>(executors);
  const execCount = Object.keys(sel.enabled).length + (sel.customEnabled ? 1 : 0);

  // ---- T3
  const [label, setLabel] = useState("Claude Code on this machine");
  const [tab, setTab] = useState<string>("claude-code");
  const [token, setToken] = useState<{ id: string; secret: string } | null>(null);
  const [pairing, setPairing] = useState<PluginPairing | null>(null);
  const [paired, setPaired] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const baseUrl = `${origin}/mcp`;

  // The indicator must survive the reload that happens while the human is in a
  // terminal pasting the command: ask the server on mount instead of trusting
  // what this tab remembers.
  useEffect(() => {
    let cancelled = false;
    void workspaceEverConnectedAction().then((r) => {
      if (!cancelled && r.connected) setConnected(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if ((!token && !pairing) || connected) return;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      // The plugin path has two moments worth showing: the installer taking
      // the code, and the agent making its first call.
      if (pairing && !paired) {
        const p = await pollPairingAction(pairing.id);
        if (p.paired && !stopped) setPaired(true);
      }
      if (token) {
        const r = await pollTokenAction(token.id);
        if (r.used && !stopped) {
          setConnected(true);
          return;
        }
      }
      // The token the installer created belongs to the pairing code, not to
      // this tab, so "has anything ever reached this workspace" is the only
      // question the plugin path can honestly ask.
      if (pairing) {
        const w = await workspaceEverConnectedAction();
        if (w.connected && !stopped) setConnected(true);
      }
    };
    // This step asks the user to leave and paste the command in a terminal;
    // with the tab in the background Chrome throttles setInterval (down to
    // 1x/min). We check again as soon as they come back, so the indicator is
    // already lit when they look.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    pollRef.current = setInterval(check, 2000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [token, pairing, paired, connected]);

  const goNext = () =>
    start(async () => {
      setErr(null);
      if (step === 1) {
        const r = await saveProjectAction({ name, repoUrl: repo, prefix });
        if (!r.ok) return setErr(r.error);
        setStep(2);
      } else if (step === 2) {
        if (execCount === 0) {
          return setErr(t.wizard.t2Error);
        }
        const r = await saveExecutorsAction(sel);
        if (!r.ok) return setErr(r.error);
        setStep(3);
      } else {
        router.push("/home");
      }
    });

  const genToken = () =>
    start(async () => {
      setErr(null);
      const r = await createTokenAction(label);
      if (!r.ok) return setErr(r.error);
      setToken({ id: r.id, secret: r.secret });
    });

  const genPairing = () =>
    start(async () => {
      setErr(null);
      const r = await createPairingCodeAction(label);
      if (!r.ok) return setErr(r.error);
      setPairing({ id: r.id, code: r.code, expiresAt: r.expiresAt });
      setPaired(false);
    });

  const copyCmd = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(commandFor(tab, baseUrl, token.secret));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable; the text stays selectable */
    }
  };

  const maskedSecret = token
    ? revealed
      ? token.secret
      : `${token.secret.slice(0, 7)}${"•".repeat(12)}`
    : `ocb_${"•".repeat(12)}`;

  return (
    <>
      <NebulaAtmosphere />
      <div className="stage">
        <div className="panel wizard">
          {/* The rail and the step column are one body: on a wide screen the
              three landmarks stand beside the step instead of running as a
              line across the top of a panel that then had nothing under it
              for three hundred pixels. Narrower than that, the body is the
              single column it always was. */}
          <div className="wiz-body">
            <ol className="steps-ind">
              {[t.wizard.stepProject, t.wizard.stepExecutors, t.wizard.stepAgent].map(
                (stepLabel, i) => {
                  const n = i + 1;
                  return (
                    <li
                      key={stepLabel}
                      className={step === n ? "cur" : step > n ? "done" : ""}
                      aria-current={step === n ? "step" : undefined}
                      title={stepLabel}
                    >
                      {stepLabel}
                    </li>
                  );
                },
              )}
            </ol>
            <div className="wiz-steps">

            {/* T1: project */}
            <div className={`wstep${step === 1 ? " active" : ""}`}>
              <h2>{t.wizard.t1Title}</h2>
              <p className="sub">{t.wizard.t1Sub}</p>
              <div className="grid2 wiz-fields">
                <div className="field">
                  <label>{t.wizard.projectName}</label>
                  <input
                    className="input"
                    value={name}
                    placeholder="Agent Board"
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!prefixTouched) setPrefix(derivePrefix(e.target.value));
                    }}
                  />
                </div>
                <div className="field">
                  <label>
                    <span className="lbl-text">{t.wizard.repoUrl}</span>
                    <span className="opt">{t.wizard.optional}</span>
                  </label>
                  <input
                    className="input mono"
                    value={repo}
                    placeholder="github.com/you/repo"
                    onChange={(e) => setRepo(e.target.value)}
                  />
                </div>
                <div className="field field-prefix">
                  <label>{t.wizard.idPrefix}</label>
                  <input
                    className="input mono"
                    value={prefix}
                    maxLength={4}
                    placeholder="AGB"
                    style={{ textTransform: "uppercase" }}
                    onChange={(e) => {
                      setPrefixTouched(true);
                      setPrefix(e.target.value.toUpperCase());
                    }}
                  />
                </div>
              </div>
              <div className={`preview${prefix.length >= 2 ? "" : " ghost"}`}>
                <span className="cap">{t.wizard.previewCap}</span>
                {t.wizard.previewCards} <b>{prefix || "…"}-{nextNumber}</b>,{" "}
                <b>{prefix || "…"}-{nextNumber + 1}</b>… {t.wizard.previewBranches}{" "}
                <b>{(prefix || "…").toLowerCase()}-{nextNumber}-card-name</b>.
              </div>
            </div>

            {/* T2: executors */}
            <div className={`wstep${step === 2 ? " active" : ""}`}>
              <h2>{t.wizard.t2Title}</h2>
              <p className="sub">{t.wizard.t2Sub}</p>
              <ExecutorsGrid value={sel} onChange={setSel} />
              <div className="hint">
                <b>{t.wizard.t2HintStrong}</b> {t.wizard.t2Hint}
              </div>
            </div>

            {/* T3: connect the agent */}
            <div className={`wstep${step === 3 ? " active" : ""}`}>
              <h2>{t.wizard.t3Title}</h2>
              <p className="sub">{t.wizard.t3Sub}</p>

              {/* The plugin is the path, and it is the path first: everything
                  the board asks an agent to do (the skill, the hooks, the
                  /overclick commands) comes with it, and the hand-written MCP
                  entry below brings none of it. It was the other way round
                  until OCL-102, which is how the whole 0.2 plugin managed to
                  ship invisible to the people meant to run it. */}
              <PluginInstall
                origin={origin}
                t={t}
                label={label}
                onLabelChange={setLabel}
                pairing={pairing}
                onGenerate={genPairing}
                pending={pending}
              />

              <details className="alt-path">
                <summary>{t.plugin.manualCap}</summary>
                <p className="plug-lead">{t.plugin.manualNote}</p>
                <div className="field" style={{ maxWidth: 420 }}>
                  <label>{t.wizard.tokenName}</label>
                  <input
                    className="input"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    disabled={Boolean(token)}
                  />
                </div>
                {!token ? (
                  <button className="btn-next" style={{ marginBottom: 18 }} disabled={pending} onClick={genToken}>
                    {pending ? t.wizard.generating : t.wizard.generateToken}
                  </button>
                ) : (
                  <>
                    <div className="tabs" role="tablist" aria-label={t.wizard.commandTab}>
                      {CMD_TABS.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          role="tab"
                          aria-selected={tab === c.id}
                          className={tab === c.id ? "on" : ""}
                          onClick={() => setTab(c.id)}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                    <div className="cmd">
                      {commandFor(tab, baseUrl, revealed ? token.secret : maskedSecret)}
                      <button className={`copy${copied ? " ok" : ""}`} onClick={copyCmd}>
                        <Icon name={copied ? "check" : "copy"} label={null} size={12} />
                        {copied ? t.wizard.copied : t.wizard.copy}
                      </button>
                    </div>
                    <div className="tok-note">
                      {t.wizard.tokNote}{" "}
                      <span className="reveal" onClick={() => setRevealed(!revealed)}>
                        {revealed ? t.wizard.hide : t.wizard.reveal}
                      </span>
                    </div>
                  </>
                )}
              </details>

              {token || pairing ? (
                <div className={`conn${connected ? " lit" : ""}`}>
                  <div className="l1">
                    <span className={`pip${connected ? " green" : ""}`} />
                    <span>
                      {connected
                        ? t.wizard.connected
                        : paired
                          ? t.wizard.paired
                          : t.wizard.waiting}
                    </span>
                  </div>
                  <div className="l2">
                    {connected ? `${label} · ${t.wizard.justNow}` : t.wizard.pasteCmd}
                  </div>
                  <div className="cap">
                    {connected
                      ? t.wizard.firstCall
                      : paired
                        ? t.wizard.pairedCap
                        : t.wizard.polling}
                  </div>
                </div>
              ) : null}
            </div>

            {err ? <p className="werr" role="alert">{err}</p> : null}

            </div>
          </div>

          <div className="wfoot">
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={step}
              aria-valuemin={1}
              aria-valuemax={3}
            >
              {/* three of three is the whole bar; step * 33 stopped at 99% and
                  left a sliver of the last step forever unfinished */}
              <i style={{ width: `${(step / 3) * 100}%` }} />
            </div>
            <div className="wbtns">
              {/* The two directions of the wizard were punctuation inside the
                  label, which is a chevron only if the font agrees. They are
                  the set's own here, and silent: the word beside each one is
                  the accessible name already. */}
              <button className="btn-back" disabled={step === 1 || pending} onClick={() => setStep(step - 1)}>
                <Icon name="chevronLeft" label={null} size={13} />
                {t.wizard.back}
              </button>
              <div className="wbtns-end">
                {step === 3 ? (
                  <button
                    type="button"
                    className="skip"
                    onClick={() => router.push("/home")}
                  >
                    {t.wizard.configureLater}
                  </button>
                ) : null}
                <button
                  className={`btn-next${connected ? " go" : ""}`}
                  disabled={pending || (step === 3 && !connected)}
                  onClick={goNext}
                >
                  {step === 3 ? (connected ? t.wizard.seeMyBoard : t.wizard.finish) : t.wizard.next}
                  {/* the last step with nothing connected yet leads nowhere,
                      so it does not carry the glyph that says it does */}
                  {step === 3 && !connected ? null : (
                    <Icon name="chevronRight" label={null} size={13} />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
