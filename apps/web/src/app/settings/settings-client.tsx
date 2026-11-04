"use client";

import type { AutoUpdateRecord, UpdateMode } from "@agent-board/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import type { SettingsGroupId } from "./groups";
import { SettingsGroupsNav } from "./settings-groups-nav";
import { ProjectCreateForm } from "./project-create-form";
import { saveClaimTimeoutAction } from "../../actions/claims";
import { saveLanguageAction } from "../../actions/language";
import { savePricesAction, savePricingEnabledAction } from "../../actions/prices";
import { saveRecipesAction } from "../../actions/recipes";
import {
  createPairingCodeAction,
  createTokenAction,
  revokeTokenAction,
  setTokenManageAction,
} from "../../actions/tokens";
import { saveUpdateModeAction } from "../../actions/updates";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import {
  PluginInstall,
  type PluginPairing,
} from "../../components/plugin-install";
import { UpdatePanel } from "../../components/update-panel";
import { asLang, formatCalendarDate, formatMediumDate } from "../../lib/format";
import { LANGUAGES, dict, type Dict } from "../../lib/i18n";
import type { Runtime } from "../../lib/runtime";
import type { UpdaterState } from "../../lib/updates";
import {
  OrganizationContextEditor,
  type OrganizationRow,
} from "./organization-context-editor";
import { TeamPanel, type TeamData } from "./team-panel";
import {
  ProjectContextEditor,
  type ProjectContextRow,
} from "./project-context-editor";

/** Which panel lives in which group (E5): the tabs became links to these. */
export type SettingsView = SettingsGroupId | "my-agent";

const PANE_VIEW: Record<string, SettingsView> = {
  organizations: "organizations-projects",
  projects: "organizations-projects",
  prices: "prices",
  recipes: "agents",
  tokens: "agents",
  team: "team",
  claims: "agents",
  language: "system",
  updates: "system",
};

/** The three modes, in the order they escalate: silence, tell, act. */
const UPDATE_MODES: readonly UpdateMode[] = ["off", "check", "auto"];
import type {
  ModelPriceRow,
  RecipeCoverage,
  UsageRecipeRow,
} from "@agent-board/db";

/** One line of the price table, as the form edits it (numbers stay strings). */
type PriceRow = {
  model: string;
  label: string;
  input: string;
  output: string;
  cache: string;
  cacheWrite: string;
  source: "seed" | "custom";
  seededAt: string | null;
  updatedBy: string | null;
};
type TokenRow = {
  id: string;
  label: string;
  masked: string;
  canManage: boolean;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

function fmtLastUse(iso: string | null, t: Dict): string {
  if (!iso) return t.settings.neverUsed;
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return t.settings.justNow;
  if (m < 60) return t.board.minAgo(m);
  const h = Math.round(m / 60);
  if (h < 24) return t.board.hAgo(h);
  const d = Math.round(h / 24);
  return d === 1 ? t.settings.yesterday : t.board.dAgo(d);
}

export function SettingsClient({
  host,
  origin,
  workspaceName,
  projectName,
  organizations,
  projects,
  prices,
  pricingEnabled,
  claimTimeoutMinutes,
  /** The tab a link asked for (OCL-20), already validated on the server. */
  view,
  footer,
  unpricedModels,
  unpricedRanModels,
  recipes,
  coverage,
  tokens,
  lang,
  updateMode,
  updateLog,
  version,
  runtime,
  updater,
  enableCommand,
  manualCommand,
  sourceCommand,
  isAdmin,
  team,
}: {
  /** False for a member: only their own tokens and pairing are shown. */
  isAdmin: boolean;
  /** Invitations and the people on the board. Null for a member. */
  team: TeamData | null;
  host: string;
  origin: string;
  workspaceName: string;
  projectName: string;
  organizations: OrganizationRow[];
  projects: ProjectContextRow[];
  prices: ModelPriceRow[];
  pricingEnabled: boolean;
  claimTimeoutMinutes: number;
  /**
   * What this page shows: one of the Settings groups, or "my-agent" for the
   * member's own connections (and the admin's, at /account/agent).
   */
  view: SettingsView;
  /** Server-rendered extras under the panels (Meu agente's links). */
  footer?: ReactNode;
  /** Every model this board knows of, configured or seen, with no price row. */
  unpricedModels: string[];
  /**
   * The subset that already ran cards here. Those are the ones costing money
   * the board cannot count, so they are flagged instead of merely listed.
   */
  unpricedRanModels: string[];
  recipes: UsageRecipeRow[];
  /**
   * Which of the CLIs this workspace runs have a recipe of their own.
   * Computed on the server: importing the helper here would drag the whole
   * db package, and its postgres client, into the browser bundle.
   */
  coverage: RecipeCoverage[];
  tokens: TokenRow[];
  lang: string;
  /** What this instance may do about new releases. */
  updateMode: UpdateMode;
  /** What the last update did, automatic or not. Null until one runs. */
  updateLog: AutoUpdateRecord | null;
  version: string;
  /** Read on the server: whether this instance runs from an image or a checkout. */
  runtime: Runtime;
  /** Read on the server: whether the optional updater sidecar is alive. */
  updater: UpdaterState;
  enableCommand: string;
  manualCommand: string;
  sourceCommand: string;
}) {
  const t = dict(lang);
  const router = useRouter();
  // The panel a pane belongs to is on screen when its group is the view; the
  // tokens pane is also the whole of "Meu agente".
  const shown = (pane: string) =>
    pane === "tokens" && view === "my-agent" ? true : PANE_VIEW[pane] === view;
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);


  // ---- update mode (off by default: no outbound request at all)
  const [updMode, setUpdMode] = useState<UpdateMode>(updateMode);
  const saveUpd = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await saveUpdateModeAction(updMode);
      if (!r.ok) setErr(r.error);
      else { setMsg(t.updates.checkSaved); router.refresh(); }
    });

  // ---- language
  const [langSel, setLangSel] = useState(lang);
  const saveLang = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await saveLanguageAction(langSel);
      if (!r.ok) setErr(r.error);
      else { setMsg(dict(langSel).settings.langSaved); router.refresh(); }
    });

  // ---- orphaned claim lease
  const [claimTimeout, setClaimTimeout] = useState(String(claimTimeoutMinutes));
  const saveClaimTimeout = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await saveClaimTimeoutAction(Number(claimTimeout));
      if (!r.ok) setErr(r.error);
      else { setMsg(t.settings.claimTimeoutSaved); router.refresh(); }
    });

  // ---- cost layer, opt-in and off by default
  const [pricingOn, setPricingOn] = useState(pricingEnabled);
  const savePricing = (next: boolean) =>
    start(async () => {
      setErr(null); setMsg(null);
      setPricingOn(next);
      const r = await savePricingEnabledAction(next);
      if (!r.ok) { setPricingOn(!next); setErr(r.error); }
      else { setMsg(t.settings.pricingSaved); router.refresh(); }
    });

  // ---- model prices
  const [priceRows, setPriceRows] = useState<PriceRow[]>(
    prices.map((p) => ({
      model: p.model,
      label: p.label,
      input: String(p.inputPerMtok),
      output: String(p.outputPerMtok),
      cache: String(p.cachePerMtok),
      cacheWrite: String(p.cacheWritePerMtok),
      source: p.source,
      seededAt: p.seededAt,
      updatedBy: p.updatedBy,
    })),
  );
  const [addedModels, setAddedModels] = useState<string[]>([]);
  const [newModel, setNewModel] = useState("");
  const setPrice = (i: number, patch: Partial<PriceRow>) =>
    setPriceRows(priceRows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const addPriceRow = (model: string) => {
    const label = model.trim();
    if (!label) return;
    // Functional update: filling every unpriced model at once adds several
    // rows in one render, and each one has to see the ones before it.
    setPriceRows((prev) =>
      prev.some((row) => row.label.toLowerCase() === label.toLowerCase())
        ? prev
        : [
            ...prev,
            {
              model: label,
              label,
              input: "0",
              output: "0",
              cache: "0",
              cacheWrite: "0",
              source: "custom",
              seededAt: null,
              updatedBy: null,
            },
          ],
    );
    setAddedModels((prev) =>
      prev.includes(label) ? prev : [...prev, label],
    );
    setNewModel("");
  };
  const removePriceRow = (i: number) =>
    setPriceRows(priceRows.filter((_, j) => j !== i));
  /** Models that ran here and are still waiting for a number in this form. */
  const pendingRanModels = unpricedRanModels.filter(
    (model) => !addedModels.includes(model),
  );
  /** Fills the table with a row per model that ran here with no price. */
  const addAllRanModels = () => {
    for (const model of pendingRanModels) addPriceRow(model);
  };
  const savePrices = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await savePricesAction(
        priceRows.map((row) => ({
          model: row.model,
          label: row.label,
          inputPerMtok: Number(row.input),
          outputPerMtok: Number(row.output),
          cachePerMtok: Number(row.cache),
          cacheWritePerMtok: Number(row.cacheWrite),
        })),
      );
      if (!r.ok) setErr(r.error);
      else { setMsg(t.settings.pricesSaved); router.refresh(); }
    });

  // ---- usage recipes
  const [recipeRows, setRecipeRows] = useState<UsageRecipeRow[]>(recipes);
  // A save refreshes the server data; adopt it, so the badge stops claiming a
  // recipe is the shipped one right after somebody rewrote it.
  const [recipesSeen, setRecipesSeen] = useState(recipes);
  if (recipesSeen !== recipes) {
    setRecipesSeen(recipes);
    setRecipeRows(recipes);
  }
  const uncovered = coverage.filter((row) => !row.covered);
  const setRecipe = (i: number, patch: Partial<UsageRecipeRow>) =>
    setRecipeRows(recipeRows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const saveRecipes = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await saveRecipesAction(
        recipeRows.map((row) => ({
          cli: row.cli,
          label: row.label,
          instructions: row.instructions,
          command: row.command,
        })),
      );
      if (!r.ok) setErr(r.error);
      else { setMsg(t.settings.recipesSaved); router.refresh(); }
    });

  // ---- tokens
  const [newLabel, setNewLabel] = useState("");
  const [fresh, setFresh] = useState<{ secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [newCanManage, setNewCanManage] = useState(false);
  const genToken = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await createTokenAction(newLabel || "unnamed token", newCanManage);
      if (!r.ok) return setErr(r.error);
      setFresh({ secret: r.secret });
      setNewLabel("");
      setNewCanManage(false);
      router.refresh();
    });
  const revoke = (id: string) =>
    start(async () => {
      setErr(null);
      const r = await revokeTokenAction(id);
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  // The capability is decided on the row, not only at creation: a token that
  // arrived through pairing is born without it, and until this existed there
  // was no control anywhere that could turn it on (OCL-136).
  const setManage = (id: string, canManage: boolean) =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await setTokenManageAction(id, canManage);
      if (!r.ok) setErr(r.error);
      else { setMsg(canManage ? t.settings.manageGranted : t.settings.manageRevoked); router.refresh(); }
    });
  const copyFresh = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(
        `claude mcp add --transport http overclick \\\n  ${origin}/mcp \\\n  --header "Authorization: Bearer ${fresh.secret}"`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  // ---- pairing code: the token never travels through a chat
  //
  // One state for both surfaces, because the board keeps one live code per
  // workspace: generating from either place kills the other's code, and two
  // blocks showing two different sets of six digits, one of them already dead,
  // is the confusion that costs somebody a terminal round trip.
  const [pairFresh, setPairFresh] = useState<PluginPairing | null>(null);
  const [pairCopied, setPairCopied] = useState(false);
  const [machineLabel, setMachineLabel] = useState("");
  const pairCmd = pairFresh
    ? `curl -sX POST ${origin}/api/pair \\\n  -H 'Content-Type: application/json' -d '{"code":"${pairFresh.code}"}'`
    : "";
  const makePairing = (label: string) =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await createPairingCodeAction(label || "paired agent");
      if (!r.ok) return setErr(r.error);
      setPairFresh({ id: r.id, code: r.code, expiresAt: r.expiresAt });
    });
  const genPair = () => makePairing(newLabel);
  const genPluginPairing = () => makePairing(machineLabel);
  const copyPair = async () => {
    if (!pairFresh) return;
    try {
      await navigator.clipboard.writeText(pairCmd);
      setPairCopied(true);
      setTimeout(() => setPairCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <>
      <NebulaAtmosphere />
      <div className="page">
        {/* The wordmark and the way back live in the global bar now
            (navigation plan E1). */}

        <h1>{view === "my-agent" ? t.account.title : t.settings.title}</h1>
        <p className="page-sub">{view === "my-agent" ? t.account.sub : t.settings.sub}</p>

        <div className={view === "my-agent" ? undefined : "sgroups-layout"}>
        {view === "my-agent" ? null : <SettingsGroupsNav current={view} t={t} />}
        <div className="sgroups-main">
        {/* A save that failed and a save that worked both have to reach a
            screen reader, and neither may be the first thing a sighted user
            misses because it printed below the fold. */}
        {err ? <p className="werr" role="alert">{err}</p> : null}
        {msg ? <p className="wok" role="status">{msg}</p> : null}

        {isAdmin ? (<>
        {/* ---- ORGANIZATIONS ---- */}
        <div
          className={`tabpane${shown("organizations") ? " active" : ""}`}
          id="setpane-organizations"
        >
          <OrganizationContextEditor organizations={organizations} lang={lang} />
        </div>

        {/* ---- PROJECT CONTEXT ---- */}
        <div
          className={`tabpane${shown("projects") ? " active" : ""}`}
          id="setpane-projects"
        >
          <ProjectCreateForm
            organizations={organizations}
            projects={projects}
            lang={lang}
          />
          <ProjectContextEditor
            key={projects.map((row) => row.id).join(",")}
            projects={projects}
            lang={lang}
          />
        </div>

        {/* ---- MODEL PRICES ---- */}
        <div
          className={`tabpane${shown("prices") ? " active" : ""}`}
          id="setpane-prices"
        >
          <p className="page-sub">{t.settings.pricesSub}</p>
          {/* The switch comes first: everything below it only matters once
              somebody decides this board should talk about money at all. */}
          <label className="upd-toggle">
            <input
              type="checkbox"
              checked={pricingOn}
              disabled={pending}
              onChange={(e) => savePricing(e.target.checked)}
            />
            <span>{t.settings.pricingToggle}</span>
          </label>
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            {pricingOn ? t.settings.pricingOnNote : t.settings.pricingOffNote}
          </div>

          {/* Models that already ran cards here with nothing to price them
              by. Every run of theirs is spending the board cannot count, so
              this sits above the table with one click that fills them in. */}
          {pendingRanModels.length > 0 ? (
            <div className="seen-sugg price-alert">
              <div className="sec-cap">
                {t.settings.priceMissingRan(pendingRanModels.length)}
              </div>
              <div className="policy-note" style={{ borderTop: 0, paddingTop: 0 }}>
                {t.settings.priceMissingRanNote}
              </div>
              <div className="seen-row">
                {pendingRanModels.map((model) => (
                  <span key={model} className="seen-chip">
                    <b>{model}</b>
                    <button className="seen-add oc-tappable" onClick={() => addPriceRow(model)}>
                      {t.settings.add}
                    </button>
                  </span>
                ))}
                <button className="btn-new" onClick={addAllRanModels}>
                  {t.settings.priceFillAll}
                </button>
              </div>
            </div>
          ) : null}

          <div className="set-scroll">
          <table className="policy prices">
            <thead>
              <tr>
                <th>{t.settings.thPriceModel}</th>
                <th>{t.settings.thPriceInput}</th>
                <th>{t.settings.thPriceOutput}</th>
                <th>{t.settings.thPriceCache}</th>
                <th>{t.settings.thPriceCacheWrite}</th>
                <th>{t.settings.thPriceOrigin}</th>
              </tr>
            </thead>
            <tbody>
              {priceRows.map((row, i) => {
                // A row added for a model that ran here still reads as unpriced
                // while every number in it is zero: the form was filled with
                // placeholders, not with a price somebody looked up.
                const ranHere = unpricedRanModels.includes(row.label);
                const stillEmpty =
                  ranHere &&
                  [row.input, row.output, row.cache, row.cacheWrite].every(
                    (value) => Number(value) === 0,
                  );
                return (
                <tr key={row.model}>
                  <td className="act">
                    {row.label}
                    {stillEmpty ? (
                      <small className="price-flag">
                        {t.settings.priceUnpriced}
                      </small>
                    ) : null}
                  </td>
                  {(
                    [
                      ["input", t.settings.thPriceInput],
                      ["output", t.settings.thPriceOutput],
                      ["cache", t.settings.thPriceCache],
                      ["cacheWrite", t.settings.thPriceCacheWrite],
                    ] as const
                  ).map(([field, heading]) => (
                    <td key={field} data-label={heading}>
                      <input
                        className="input"
                        type="number"
                        min="0"
                        step="0.01"
                        value={row[field]}
                        onChange={(e) => setPrice(i, { [field]: e.target.value })}
                      />
                    </td>
                  ))}
                  <td className="who" data-label={t.settings.thPriceOrigin}>
                    {row.source === "seed" && row.seededAt ? (
                      <span className="dim">{t.settings.priceSeeded(formatCalendarDate(row.seededAt, t.lang))}</span>
                    ) : (
                      <>
                        {t.settings.priceEdited}
                        {row.updatedBy ? <small>{row.updatedBy}</small> : null}
                      </>
                    )}
                    {addedModels.includes(row.label) ? (
                      <button className="seen-add oc-tappable" onClick={() => removePriceRow(i)}>
                        {t.settings.priceRemove}
                      </button>
                    ) : null}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {unpricedModels.filter((m) => !addedModels.includes(m)).length > 0 ? (
            <div className="seen-sugg">
              <div className="sec-cap">{t.settings.priceSeenModels}</div>
              <div className="seen-row">
                {unpricedModels
                  .filter((m) => !addedModels.includes(m))
                  .map((model) => (
                    <span key={model} className="seen-chip">
                      <b>{model}</b>
                      <button className="seen-add oc-tappable" onClick={() => addPriceRow(model)}>
                        {t.settings.add}
                      </button>
                    </span>
                  ))}
              </div>
            </div>
          ) : null}

          <div className="gen-row">
            <input
              className="input"
              style={{ maxWidth: 320 }}
              placeholder={t.settings.priceAddModel}
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
            />
            <button className="btn-new" onClick={() => addPriceRow(newModel)}>
              {t.settings.priceAdd}
            </button>
          </div>

          <div className="policy-note">{t.settings.priceCacheNote}</div>
          <div className="save-row">
            <button className="btn-new" disabled={pending} onClick={savePrices}>
              {pending ? t.settings.saving : t.settings.savePrices}
            </button>
          </div>
        </div>

        {/* ---- USAGE RECIPES ---- */}
        <div
          className={`tabpane${shown("recipes") ? " active" : ""}`}
          id="usage-recipes"
        >
          <p className="page-sub">{t.settings.recipesSub}</p>
          {/* The Executors tab left with E2: the board records what ran and
              never chooses it, so the tab that names the CLIs says who does. */}
          <div className="hint" style={{ marginBottom: 12 }}>{t.record.decidedInOverclock}</div>
          {/* A missing recipe used to be invisible: the tab listed the recipes
              that exist and said nothing about the CLIs falling through to the
              generic one, which is where precision is lost silently. */}
          {coverage.length > 0 && (
            <div className="set-card rec-cover">
              <div className="rec-head">
                <span className="rec-name">{t.settings.recipeCoverageTitle}</span>
                <span className="sec-cap" style={{ margin: 0 }}>
                  {uncovered.length === 0
                    ? t.settings.recipeCoverageAllCovered
                    : `${uncovered.length}/${coverage.length} ${t.settings.recipeCoverageFallback}`}
                </span>
              </div>
              <ul className="cover-list">
                {coverage.map((row) => (
                  <li key={row.cli} className={row.covered ? "has" : "missing"}>
                    <span className="cover-cli">{row.label}</span>
                    <span className="cover-state">
                      {row.covered
                        ? t.settings.recipeCoverageOwn
                        : t.settings.recipeCoverageFallback}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="sec-cap">{t.record.ranFromAttempts}</p>
              {uncovered.length > 0 && (
                <p className="sec-cap">{t.settings.recipeCoverageNote}</p>
              )}
            </div>
          )}
          {/* One recipe is a heading and two fields, so it gets the shape of a
              group: four of them in a row used to read as one long page with
              no seam between the CLI you meant to edit and the next one. */}
          {recipeRows.map((row, i) => (
            <div key={row.cli} className="set-card recipe">
              <div className="rec-head">
                <span className="rec-name">{row.label}</span>
                <span className="sec-cap" style={{ margin: 0 }}>
                  {row.command.trim()
                    ? t.settings.recipeYieldsTokens
                    : t.settings.recipeYieldsNone}
                  {" · "}
                  {row.source === "seed"
                    ? t.settings.recipeShipped
                    : `${t.settings.recipeEdited}${row.updatedBy ? ` · ${row.updatedBy}` : ""}`}
                </span>
              </div>
              <label className="lbl" htmlFor={`recipe-inst-${row.cli}`}>
                {t.settings.recipeInstructions}
              </label>
              <textarea
                id={`recipe-inst-${row.cli}`}
                className="input"
                rows={3}
                value={row.instructions}
                onChange={(e) => setRecipe(i, { instructions: e.target.value })}
              />
              <label className="lbl" htmlFor={`recipe-cmd-${row.cli}`}>
                {t.settings.recipeCommand}
              </label>
              <textarea
                id={`recipe-cmd-${row.cli}`}
                className={`input d-mono${row.command ? " filled" : ""}`}
                rows={2}
                placeholder={t.settings.recipeNoCommand}
                value={row.command}
                onChange={(e) => setRecipe(i, { command: e.target.value })}
              />
            </div>
          ))}
          <div className="gen-row">
            <button className="btn-new" disabled={pending} onClick={saveRecipes}>
              {pending ? t.settings.saving : t.settings.saveRecipes}
            </button>
          </div>
        </div>
        </>) : null}

        {/* ---- TOKENS ---- */}
        <div
          className={`tabpane${shown("tokens") ? " active" : ""}`}
          id="connections"
        >
          {/* Same offer as onboarding step three, for everyone who already
              walked past it: the plugin first, the hand-written MCP entry
              folded away under it (OCL-102). */}
          <PluginInstall
            origin={origin}
            t={t}
            label={machineLabel}
            onLabelChange={setMachineLabel}
            pairing={pairFresh}
            onGenerate={genPluginPairing}
            pending={pending}
          />

          <div className="sec-cap">{t.settings.tokensCap}</div>
          <div className="tok-list">
            {tokens.length === 0 ? (
              <div className="empty-col">{t.settings.tokensEmpty}</div>
            ) : (
              tokens.map((tok) => (
                <div key={tok.id} className={`tok${tok.revoked ? " revoked" : ""}`}>
                  <div className="meta">
                    <div className="label">{tok.label}</div>
                    <div className="sub">
                      {t.settings.created} {formatMediumDate(tok.createdAt, asLang(lang))} ·{" "}
                      {tok.revoked ? t.settings.revoked : fmtLastUse(tok.lastUsedAt, t)}
                    </div>
                  </div>
                  {/* The box the MCP refusal points at. It is a control and not
                      a badge because reading "this token needs manage" and
                      finding nothing to tick is the whole bug (OCL-136). */}
                  {isAdmin ? (
                  <label className="tok-cap" title={t.settings.manageLabel}>
                    <input
                      type="checkbox"
                      checked={tok.canManage}
                      disabled={pending || tok.revoked}
                      aria-label={`${t.settings.manageLabel} (${tok.label})`}
                      onChange={(e) => setManage(tok.id, e.target.checked)}
                    />
                    <span>{t.settings.manageBadge}</span>
                  </label>
                  ) : null}
                  <span className="val">{tok.masked}</span>
                  <button className="btn-rev" disabled={pending || tok.revoked} onClick={() => revoke(tok.id)}>
                    {tok.revoked ? t.settings.revoked : t.settings.revoke}
                  </button>
                </div>
              ))
            )}
          </div>

          <details className="alt-path">
          <summary>{t.plugin.manualCap}</summary>
          <p className="plug-lead">{t.plugin.manualNote}</p>

          {fresh ? (
            <div className="fresh-tok">
              <div className="lbl">{t.settings.freshToken}</div>
              <div className="cmd">{fresh.secret}
                <button className={`copy${copied ? " ok" : ""}`} onClick={copyFresh}>
                  {copied ? t.wizard.copied : t.settings.copyCommand}
                </button>
              </div>
            </div>
          ) : null}

          {/* Naming it, choosing what it may do and generating it are one
              decision, so they sit inside one group instead of drifting down
              the page as three unrelated controls. */}
          <div className="set-card">
            <div className="sec-cap">{t.settings.newTokenCap}</div>
            <div className="gen-row">
              <input
                className="input"
                style={{ maxWidth: 320 }}
                placeholder={t.settings.tokenPlaceholder}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <button className="btn-new" disabled={pending} onClick={genPair}>
                {pending ? t.wizard.generating : t.settings.generatePairBtn}
              </button>
              <button className="btn-new" disabled={pending} onClick={genToken}>
                {pending ? t.wizard.generating : t.settings.generateTokenBtn}
              </button>
            </div>

            {isAdmin ? (
              <>
                <label className="upd-toggle">
                  <input
                    type="checkbox"
                    checked={newCanManage}
                    onChange={(e) => setNewCanManage(e.target.checked)}
                  />
                  <span>{t.settings.manageLabel}</span>
                </label>
                <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
                  {t.settings.manageNote}
                </div>
              </>
            ) : null}
          </div>

          {pairFresh ? (
            <div className="fresh-tok">
              <div className="lbl">{t.settings.freshPair}</div>
              <div className="pair-code">{pairFresh.code}</div>
              <div className="cmd">{pairCmd}
                <button className={`copy${pairCopied ? " ok" : ""}`} onClick={copyPair}>
                  {pairCopied ? t.wizard.copied : t.wizard.copy}
                </button>
              </div>
              <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
                {t.settings.pairNote}
              </div>
            </div>
          ) : null}

          <div className="sec-cap">{t.settings.connectAgent}</div>
          <div className="cmd">
{`claude mcp add --transport http overclick \\
  ${origin}/mcp \\
  --header "Authorization: Bearer ocb_••••••••••••"`}
          </div>
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            {t.settings.maskedNote}
          </div>
          </details>
        </div>

        {/* ---- TEAM ---- */}
        {isAdmin && team ? (
          <div
            className={`tabpane${shown("team") ? " active" : ""}`}
            id="setpane-team"
          >
            <TeamPanel {...team} origin={origin} t={t} lang={asLang(lang)} />
          </div>
        ) : null}

        {isAdmin ? (<>
        {/* ---- CLAIM LEASE ---- */}
        <div
          className={`tabpane${shown("claims") ? " active" : ""}`}
          id="claim-timeout"
        >
          <div className="set-card">
            <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
              <label htmlFor="settings-claim-timeout">
                {t.settings.claimTimeoutLabel}
              </label>
              <input
                id="settings-claim-timeout"
                className="input"
                type="number"
                min="1"
                max="10080"
                step="1"
                value={claimTimeout}
                onChange={(event) => setClaimTimeout(event.target.value)}
              />
            </div>
            <div className="policy-note" style={{ borderTop: 0, paddingTop: 10 }}>
              {t.settings.claimTimeoutNote}
            </div>
          </div>
          <div className="save-row">
            <button className="btn-new" disabled={pending} onClick={saveClaimTimeout}>
              {pending ? t.settings.saving : t.settings.saveClaimTimeout}
            </button>
          </div>
        </div>

        {/* ---- LANGUAGE ---- */}
        <div
          className={`tabpane${shown("language") ? " active" : ""}`}
          id="language"
        >
          <div className="set-card">
            <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
              <label htmlFor="settings-language">{t.settings.langLabel}</label>
              <select
                id="settings-language"
                className="sel"
                value={langSel}
                onChange={(e) => setLangSel(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="policy-note" style={{ borderTop: 0, paddingTop: 10 }}>
              {t.settings.langNote}
            </div>
          </div>
          <div className="save-row">
            <button className="btn-new" disabled={pending} onClick={saveLang}>
              {pending ? t.settings.saving : t.settings.saveLanguage}
            </button>
          </div>
        </div>

        {/* ---- UPDATES ---- */}
        <div
          className={`tabpane${shown("updates") ? " active" : ""}`}
          id="updates"
        >
          {/* Three modes are one decision, so they read as one set of options
              with a border around them, not as three loose rows. */}
          <div className="set-card upd-modes">
            {UPDATE_MODES.map((mode) => (
              <label className="upd-toggle" key={mode}>
                <input
                  type="radio"
                  name="update-mode"
                  checked={updMode === mode}
                  onChange={() => setUpdMode(mode)}
                />
                <span>
                  {t.updates.mode[mode]}
                  <span className="upd-mode-note">{t.updates.modeNote[mode]}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 0 }}>
            {t.updates.checkNote}
          </div>
          <div className="save-row">
            <button className="btn-new" disabled={pending} onClick={saveUpd}>
              {pending ? t.settings.saving : t.updates.saveCheck}
            </button>
          </div>
          <UpdatePanel
            version={version}
            runtime={runtime}
            enableCommand={enableCommand}
            manualCommand={manualCommand}
            sourceCommand={sourceCommand}
            initialState={updater}
            lastUpdate={updateLog}
            lang={lang}
          />
        </div>
        </>) : null}
        {view === "my-agent" ? footer : null}
        </div>
        </div>
      </div>
    </>
  );
}
