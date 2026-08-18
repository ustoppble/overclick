"use client";

import type { AutoUpdateRecord, UpdateMode } from "@agent-board/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveClaimTimeoutAction } from "../../actions/claims";
import { saveCardapioAction, type CardapioInput } from "../../actions/cardapio";
import { addSeenExecutorAction, saveExecutorsAction } from "../../actions/executors";
import { saveLanguageAction } from "../../actions/language";
import { savePricesAction, savePricingEnabledAction } from "../../actions/prices";
import { saveRecipesAction } from "../../actions/recipes";
import {
  createPairingCodeAction,
  createTokenAction,
  revokeTokenAction,
} from "../../actions/tokens";
import { saveUpdateModeAction } from "../../actions/updates";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { UpdatePanel } from "../../components/update-panel";
import { Wordmark } from "../../components/wordmark";
import {
  ExecutorsGrid,
  type ExecutorSelection,
} from "../../components/executors-grid";
import {
  CUSTOM_EXECUTOR_ID,
  EXECUTOR_CATALOG,
  cardapioLabel,
  resolveCatalogCli,
} from "../../lib/executors";
import { LANGUAGES, dict, type Dict } from "../../lib/i18n";
import type { Runtime } from "../../lib/runtime";
import type { UpdaterState } from "../../lib/updates";

/** The three modes, in the order they escalate: silence, tell, act. */
const UPDATE_MODES: readonly UpdateMode[] = ["off", "check", "auto"];
import type {
  ModelPriceRow,
  RecipeCoverage,
  UsageRecipeRow,
} from "@agent-board/db";

type CardapioRow = {
  activityType: string;
  cli: string | null;
  model: string | null;
  /** Line of succession, best first. The head is what `model` also holds. */
  chain: string[];
  effort: string;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** How many links a row shows: first choice, escalation, floor. */
const CHAIN_SLOTS = 3;
type SeenSuggestion = { cli: string; model: string; count: number; lastSeenAt: string };
/** One line of the price table, as the form edits it (numbers stay strings). */
type PriceRow = {
  model: string;
  label: string;
  input: string;
  output: string;
  cache: string;
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

const EFFORTS = ["low", "medium", "high"] as const;

function fmtDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });
}
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
  executors,
  seenSuggestions,
  cardapio,
  prices,
  pricingEnabled,
  claimTimeoutMinutes,
  /** The tab a link asked for (OCL-20), already validated on the server. */
  initialTab,
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
}: {
  host: string;
  origin: string;
  workspaceName: string;
  projectName: string;
  executors: ExecutorSelection;
  seenSuggestions: SeenSuggestion[];
  cardapio: CardapioRow[];
  prices: ModelPriceRow[];
  pricingEnabled: boolean;
  claimTimeoutMinutes: number;
  initialTab: string;
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
  const dateLocale = lang === "pt-BR" ? "pt-BR" : "en-US";
  const router = useRouter();
  const [tab, setTab] = useState<string>(initialTab);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tabs = [
    { id: "exec", label: t.settings.tabExecutors },
    { id: "policy", label: t.settings.tabPolicy },
    { id: "prices", label: t.settings.tabPrices },
    { id: "recipes", label: t.settings.tabRecipes },
    { id: "tokens", label: t.settings.tabTokens },
    { id: "claims", label: t.settings.tabClaims },
    { id: "language", label: t.settings.tabLanguage },
    { id: "updates", label: t.updates.tabUpdates },
  ];

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

  // ---- executors
  const [sel, setSel] = useState<ExecutorSelection>(executors);
  const [added, setAdded] = useState<string[]>([]);
  const saveExec = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await saveExecutorsAction(sel);
      if (!r.ok) setErr(r.error);
      else { setMsg(t.settings.execSaved); router.refresh(); }
    });
  const addSeen = (s: SeenSuggestion) =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await addSeenExecutorAction(s.cli, s.model);
      if (!r.ok) setErr(r.error);
      else {
        const targetId = resolveCatalogCli(s.cli) ?? s.cli.toLowerCase();
        // Mirror the server change locally so the grid and the policy
        // selects pick the pair up without a reload.
        setSel((prev) => ({
          ...prev,
          models: {
            ...prev.models,
            [targetId]: [...new Set([...(prev.models[targetId] ?? []), s.model])],
          },
          enabled: {
            ...prev.enabled,
            [targetId]: [...new Set([...(prev.enabled[targetId] ?? []), s.model])],
          },
          labels: EXECUTOR_CATALOG.some((d) => d.id === targetId)
            ? prev.labels
            : { ...prev.labels, [targetId]: s.cli },
        }));
        setAdded((prev) => [...prev, `${s.cli}·${s.model}`]);
        setMsg(t.settings.addedMsg(s.cli, s.model));
        router.refresh();
      }
    });

  // ---- harness policy (cardapio)
  const [rows, setRows] = useState<CardapioRow[]>(cardapio);
  const cliOptions = [
    ...Object.keys(sel.enabled).map((id) => ({
      id,
      label: EXECUTOR_CATALOG.find((d) => d.id === id)?.label ?? sel.labels[id] ?? id,
    })),
    ...(sel.customEnabled
      ? [{ id: CUSTOM_EXECUTOR_ID, label: sel.customName.trim() || "Custom" }]
      : []),
  ];
  const modelsFor = (cli: string | null): string[] => {
    if (!cli) {
      const all = cliOptions.flatMap((o) => sel.enabled[o.id] ?? []);
      return [...new Set(all)];
    }
    if (cli === CUSTOM_EXECUTOR_ID) return ["generic-mcp"];
    return sel.enabled[cli]?.length
      ? sel.enabled[cli]
      : (sel.models[cli] ?? EXECUTOR_CATALOG.find((d) => d.id === cli)?.models ?? []);
  };
  const setRow = (i: number, patch: Partial<CardapioRow>) => {
    setRows(rows.map((r, j) => {
      if (j !== i) return r;
      const next = { ...r, ...patch };
      if (patch.cli !== undefined) {
        const models = modelsFor(patch.cli || null);
        if (!next.model || !models.includes(next.model)) next.model = models[0] ?? null;
      }
      return next;
    }));
  };
  /**
   * Writes one link of the line of succession. Blanking a link closes the gap
   * rather than leaving a hole, and the head keeps `model` in step: that field
   * is what the card and the MCP contract print.
   */
  const setChainLink = (i: number, slot: number, model: string) => {
    setRows(rows.map((r, j) => {
      if (j !== i) return r;
      const chain = [...r.chain];
      while (chain.length < CHAIN_SLOTS) chain.push("");
      chain[slot] = model;
      const kept = chain.filter((name, at) => name && chain.indexOf(name) === at);
      return { ...r, chain: kept, model: kept[0] ?? null };
    }));
  };
  const savePolicy = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await saveCardapioAction(rows as CardapioInput[]);
      if (!r.ok) setErr(r.error);
      else { setMsg(t.settings.policySaved); router.refresh(); }
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
  const [pairFresh, setPairFresh] = useState<{ code: string } | null>(null);
  const [pairCopied, setPairCopied] = useState(false);
  const pairCmd = pairFresh
    ? `curl -sX POST ${origin}/api/pair \\\n  -H 'Content-Type: application/json' -d '{"code":"${pairFresh.code}"}'`
    : "";
  const genPair = () =>
    start(async () => {
      setErr(null); setMsg(null);
      const r = await createPairingCodeAction(newLabel || "paired agent");
      if (!r.ok) return setErr(r.error);
      setPairFresh({ code: r.code });
      setNewLabel("");
    });
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
        <div className="topbar nebula-glass">
          <Wordmark label={t.board.homeLink} />
          <div className="crumb">{workspaceName} / <b>{projectName}</b></div>
          <div className="spacer" />
          <a className="btn-ghost" href="/home">{t.settings.backToBoard}</a>
        </div>

        <h1>{t.settings.title}</h1>
        <p className="page-sub">{t.settings.sub}</p>

        <div className="settabs" role="tablist" aria-label={t.settings.title}>
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              id={`settab-${tb.id}`}
              aria-selected={tab === tb.id}
              aria-controls={`setpane-${tb.id}`}
              className={tab === tb.id ? "on" : ""}
              onClick={() => { setTab(tb.id); setErr(null); setMsg(null); }}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {/* A save that failed and a save that worked both have to reach a
            screen reader, and neither may be the first thing a sighted user
            misses because it printed below the fold. */}
        {err ? <p className="werr" role="alert">{err}</p> : null}
        {msg ? <p className="wok" role="status">{msg}</p> : null}

        {/* ---- EXECUTORS ---- */}
        <div
          className={`tabpane${tab === "exec" ? " active" : ""}`}
          id="setpane-exec"
          role="tabpanel"
          aria-labelledby="settab-exec"
        >
          {seenSuggestions.filter((s) => !added.includes(`${s.cli}·${s.model}`)).length > 0 ? (
            <div className="seen-sugg">
              <div className="sec-cap">{t.settings.seenCap}</div>
              <div className="seen-row">
                {seenSuggestions
                  .filter((s) => !added.includes(`${s.cli}·${s.model}`))
                  .map((s) => (
                    <span key={`${s.cli}·${s.model}`} className="seen-chip">
                      <b>{s.cli}</b> · {s.model}
                      <small>{t.settings.connections(s.count)}</small>
                      <button
                        className="seen-add"
                        disabled={pending}
                        onClick={() => addSeen(s)}
                      >
                        {t.settings.add}
                      </button>
                    </span>
                  ))}
              </div>
              <div className="seen-note">{t.settings.seenNote}</div>
            </div>
          ) : null}
          <ExecutorsGrid value={sel} onChange={setSel} />
          <div className="hint">
            <b>{t.settings.execHintStrong}</b> {t.settings.execHint}
          </div>
          <div className="save-row">
            <button className="btn-new" disabled={pending} onClick={saveExec}>
              {pending ? t.settings.saving : t.settings.saveExecutors}
            </button>
          </div>
        </div>

        {/* ---- HARNESS POLICY ---- */}
        <div
          className={`tabpane${tab === "policy" ? " active" : ""}`}
          id="setpane-policy"
          role="tabpanel"
          aria-labelledby="settab-policy"
        >
          <div className="set-scroll">
          <table className="policy harness">
            <thead>
              <tr><th>{t.settings.thActivity}</th><th>{t.settings.thCli}</th><th>{t.settings.thModel}</th><th>{t.settings.thEffort}</th><th>{t.settings.thLastChange}</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const meta = t.cardapio[r.activityType] ?? cardapioLabel(r.activityType);
                const models = modelsFor(r.cli);
                return (
                  <tr key={r.activityType}>
                    <td className="act">{meta.label}<small>{meta.hint}</small></td>
                    <td data-label={t.settings.thCli}>
                      <select className="sel" value={r.cli ?? ""} onChange={(e) => setRow(i, { cli: e.target.value || null })}>
                        <option value="">{t.settings.noPreference}</option>
                        {cliOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="chain" data-label={t.settings.thModel}>
                      {Array.from({ length: CHAIN_SLOTS }, (_, slot) => {
                        const picked = r.chain[slot] ?? "";
                        // A model the policy names but this CLI no longer
                        // offers stays selectable, so opening Settings never
                        // silently rewrites a line somebody declared.
                        const orphan = picked && !models.includes(picked);
                        return (
                          <span key={slot} className="link">
                            {/* the glyph itself is CSS: across on a desktop
                                row, downward once the row becomes a block */}
                            {slot > 0 ? <i aria-hidden="true" /> : null}
                            <select
                              className={`sel${orphan ? " orphan" : ""}`}
                              aria-label={t.settings.chainSlot(slot + 1, meta.label)}
                              value={picked}
                              onChange={(e) => setChainLink(i, slot, e.target.value)}
                            >
                              {/* the head of the chain declares a model or it
                                  declares none: a word, not a dash nobody can
                                  read out of a closed select */}
                              <option value="">{slot === 0 ? t.settings.noPreference : t.settings.chainNone}</option>
                              {orphan ? <option value={picked}>{picked}</option> : null}
                              {models.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </span>
                        );
                      })}
                    </td>
                    <td data-label={t.settings.thEffort}>
                      <select className="sel eff" value={r.effort} onChange={(e) => setRow(i, { effort: e.target.value })}>
                        {EFFORTS.map((e2) => <option key={e2} value={e2}>{e2}</option>)}
                      </select>
                    </td>
                    <td className="who" data-label={t.settings.thLastChange}>
                      {r.updatedBy && r.updatedAt ? (
                        <>{r.updatedBy}<small>{fmtDate(r.updatedAt, dateLocale)}</small></>
                      ) : (
                        <span className="dim">{t.settings.neverChanged}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div className="policy-note">
            {t.settings.policyNote} <b>harness_list</b> {t.settings.policyNoteAfter}
          </div>
          <div className="save-row">
            <button className="btn-new" disabled={pending} onClick={savePolicy}>
              {pending ? t.settings.saving : t.settings.savePolicy}
            </button>
          </div>
        </div>

        {/* ---- MODEL PRICES ---- */}
        <div
          className={`tabpane${tab === "prices" ? " active" : ""}`}
          id="setpane-prices"
          role="tabpanel"
          aria-labelledby="settab-prices"
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
                    <button className="seen-add" onClick={() => addPriceRow(model)}>
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
                  [row.input, row.output, row.cache].every(
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
                      <span className="dim">{t.settings.priceSeeded(row.seededAt)}</span>
                    ) : (
                      <>
                        {t.settings.priceEdited}
                        {row.updatedBy ? <small>{row.updatedBy}</small> : null}
                      </>
                    )}
                    {addedModels.includes(row.label) ? (
                      <button className="seen-add" onClick={() => removePriceRow(i)}>
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
                      <button className="seen-add" onClick={() => addPriceRow(model)}>
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
          className={`tabpane${tab === "recipes" ? " active" : ""}`}
          id="setpane-recipes"
          role="tabpanel"
          aria-labelledby="settab-recipes"
        >
          <p className="page-sub">{t.settings.recipesSub}</p>
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

        {/* ---- TOKENS ---- */}
        <div
          className={`tabpane${tab === "tokens" ? " active" : ""}`}
          id="setpane-tokens"
          role="tabpanel"
          aria-labelledby="settab-tokens"
        >
          <div className="sec-cap" style={{ marginTop: 0 }}>
            {t.settings.tokensCap}
          </div>
          <div className="tok-list">
            {tokens.length === 0 ? (
              <div className="empty-col">{t.settings.tokensEmpty}</div>
            ) : (
              tokens.map((tok) => (
                <div key={tok.id} className={`tok${tok.revoked ? " revoked" : ""}`}>
                  <div className="meta">
                    <div className="label">
                      {tok.label}
                      {tok.canManage ? (
                        <span className="tok-cap">{t.settings.manageBadge}</span>
                      ) : null}
                    </div>
                    <div className="sub">
                      {t.settings.created} {fmtDate(tok.createdAt, dateLocale)} ·{" "}
                      {tok.revoked ? t.settings.revoked : fmtLastUse(tok.lastUsedAt, t)}
                    </div>
                  </div>
                  <span className="val">{tok.masked}</span>
                  <button className="btn-rev" disabled={pending || tok.revoked} onClick={() => revoke(tok.id)}>
                    {tok.revoked ? t.settings.revoked : t.settings.revoke}
                  </button>
                </div>
              ))
            )}
          </div>

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
        </div>

        {/* ---- CLAIM LEASE ---- */}
        <div
          className={`tabpane${tab === "claims" ? " active" : ""}`}
          id="setpane-claims"
          role="tabpanel"
          aria-labelledby="settab-claims"
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
          className={`tabpane${tab === "language" ? " active" : ""}`}
          id="setpane-language"
          role="tabpanel"
          aria-labelledby="settab-language"
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
          className={`tabpane${tab === "updates" ? " active" : ""}`}
          id="setpane-updates"
          role="tabpanel"
          aria-labelledby="settab-updates"
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
      </div>
    </>
  );
}
