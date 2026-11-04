"use client";

import { useMemo, useState } from "react";
import { Icon } from "../../components/icon";
import type { CardInsight } from "../../lib/insights";
import { insightsCopy, type InsightsCopy } from "./copy";
import {
  formatDuration,
  formatElapsed,
  formatMoney,
  formatTokens,
} from "../../lib/format";

type SortKey = "cost" | "tokens" | "time" | "attempts";

/** Every dollar figure on this table says where it came from. */
function sourceLabel(source: CardInsight["costSource"], t: InsightsCopy): string {
  if (source === "computed") return t.sourceComputed;
  if (source === "reported") return t.sourceReported;
  if (source === "estimated") return t.sourceEstimated;
  if (source === "mixed") return t.sourceMixed;
  return t.sourceNone;
}

function valueOf(card: CardInsight, key: SortKey): number {
  // Cards that never reported a cost sort below a real $0 instead of mixing in.
  if (key === "cost") return card.costUsd ?? -1;
  if (key === "tokens") return card.tokens;
  if (key === "time") return card.durationMs;
  return card.attempts;
}

/**
 * The qualifiers the rows carry, as one quiet line under the table. Markers
 * on the values point here; the counts the old inline badges showed are named
 * per card, out of the numeric columns.
 */
function CardFootnote({
  cards,
  pricingEnabled,
  t,
}: {
  cards: CardInsight[];
  /** With money off there is no price to be missing. */
  pricingEnabled: boolean;
  t: InsightsCopy;
}) {
  const items: string[] = [];
  const unpriced = pricingEnabled
    ? cards.filter((c) => c.unpricedTokens > 0)
    : [];
  if (unpriced.length > 0) {
    items.push(
      t.footUnpriced(
        unpriced
          .map((c) => `${c.shortId} ${c.unpricedModels.join(", ")}`)
          .join(" · "),
      ),
    );
  }
  const estimated = cards.filter((c) => c.estimated);
  if (estimated.length > 0) {
    items.push(t.footEstimated(estimated.map((c) => c.shortId).join(" · ")));
  }
  const missing = cards.filter((c) => c.missing);
  if (missing.length > 0) {
    items.push(t.footMissing(missing.map((c) => c.shortId).join(" · ")));
  }
  const zeroUsage = cards.filter((c) => c.zeroUsage);
  if (zeroUsage.length > 0) {
    items.push(t.footZeroUsage(zeroUsage.map((c) => c.shortId).join(" · ")));
  }
  const suspect = cards.filter((c) => c.suspect);
  if (suspect.length > 0) {
    items.push(
      t.footSuspect(
        suspect
          .map(
            (c) =>
              `${c.shortId} ${t.suspectSeparate(formatTokens(c.suspectTokens))}`,
          )
          .join(" · "),
      ),
    );
  }
  const elapsed = cards.filter((c) => c.elapsedMs > 0);
  if (elapsed.length > 0) {
    items.push(
      t.footElapsed(
        elapsed
          .map((c) => `${c.shortId} ${t.elapsedTag(formatElapsed(c.elapsedMs))}`)
          .join(" · "),
      ),
    );
  }
  if (items.length === 0) return null;
  return (
    <p className="ins-foot">
      {items.map((item) => (
        <span key={item} className="ins-foot-item">
          {item}
        </span>
      ))}
    </p>
  );
}

/** The per-card table. Sort state is view-only, so it stays client-side. */
export function CostTable({
  cards,
  lang,
  pricingEnabled,
}: {
  cards: CardInsight[];
  lang: string;
  /** Money is opt-in: with it off there is no cost column to sort by. */
  pricingEnabled: boolean;
}) {
  const t = insightsCopy(lang);
  const [sortKey, setSortKey] = useState<SortKey>(
    pricingEnabled ? "cost" : "tokens",
  );
  const [descending, setDescending] = useState(true);

  const sorted = useMemo(() => {
    const dir = descending ? -1 : 1;
    return [...cards].sort(
      (a, b) => dir * (valueOf(a, sortKey) - valueOf(b, sortKey)),
    );
  }, [cards, sortKey, descending]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) setDescending((d) => !d);
    else {
      setSortKey(key);
      setDescending(true);
    }
  };

  /* Which way the table is sorted, in the set's own glyph. The arrow used to
     be a character glued to the label, at whatever weight the font had for it;
     it is silent here because aria-sort on the header already says it. */
  const arrow = (key: SortKey) =>
    key === sortKey ? (
      <Icon
        name={descending ? "chevronDown" : "chevronUp"}
        label={null}
        size={11}
        className="ins-sort-arrow"
      />
    ) : null;

  const sortable: { key: SortKey; label: string }[] = [
    ...(pricingEnabled ? [{ key: "cost" as const, label: t.colCost }] : []),
    { key: "tokens", label: t.colTokens },
    { key: "time", label: t.colTime },
    { key: "attempts", label: t.colAttempts },
  ];

  return (
    <>
      <div className="ins-scroll">
        <table className="ins-table ins-table-cards">
          <colgroup>
            <col />
            <col className="ins-col-mission" />
            <col className="ins-col-model" />
            {pricingEnabled ? <col className="ins-col-source" /> : null}
            {pricingEnabled ? <col className="ins-col-cost" /> : null}
            <col className="ins-col-tokens" />
            <col className="ins-col-time" />
            <col className="ins-col-attempts" />
          </colgroup>
          <thead>
            <tr>
              <th>{t.colCard}</th>
              <th>{t.colMission}</th>
              <th>{t.colModel}</th>
              {pricingEnabled ? <th>{t.colSource}</th> : null}
              {/* A column header that sorts is a control: a keyboard reaches
                  it, a screen reader is told which way the table is sorted,
                  and the whole cell is the target instead of the glyphs. */}
              {sortable.map((col) => (
                <th
                  key={col.key}
                  className={`ins-sort num${col.key === sortKey ? " on" : ""}`}
                  aria-sort={
                    col.key === sortKey
                      ? descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => toggle(col.key)}
                    title={t.sortHint}
                  >
                    {col.label}
                    {arrow(col.key)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((card) => {
              const models =
                card.models.length > 0
                  ? card.models
                      .map((model) =>
                        card.modelOrigins.some(
                          (origin) =>
                            origin.model === model && origin.source === "harness",
                        )
                          ? `${model} (${t.modelFromHarness})`
                          : model,
                      )
                      .join(", ")
                  : t.noModel;
              return (
                <tr key={card.taskId}>
                  <td>
                    <div className="ins-cardcell">
                      <span className="ins-cid">{card.shortId}</span>
                      <span className="ins-card-title" title={card.title}>
                        {card.title}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span
                      className={`ins-name ins-dim`}
                      title={card.missionTitle ?? t.noMission}
                    >
                      {card.missionTitle ?? t.noMission}
                    </span>
                  </td>
                  <td>
                    <span className="ins-name ins-mono" title={models}>
                      {models}
                    </span>
                  </td>
                  {pricingEnabled ? (
                    <td className={card.costSource ? "" : "ins-dim"}>
                      {sourceLabel(card.costSource, t)}
                    </td>
                  ) : null}
                  {/* Two different silences: a card whose models have no
                      price row, and a card that reported nothing to price.
                      Only the second one is "not reported". */}
                  {pricingEnabled ? (
                    <td className="num">
                      {card.costUsd != null ? (
                        <>
                          <b>{formatMoney(card.costUsd, t.lang)}</b>
                          {card.unpricedTokens > 0 ? (
                            <span
                              className="ins-mark"
                              title={t.noPriceTitle(formatTokens(card.unpricedTokens))}
                            >
                              ⌀
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span
                          className="ins-dim"
                          title={
                            card.unpricedTokens > 0
                              ? t.costNoPriceFor(card.unpricedModels.join(", "))
                              : undefined
                          }
                        >
                          {card.unpricedTokens > 0
                            ? t.costNoPriceFor(card.unpricedModels.join(", "))
                            : card.zeroUsage
                              ? t.costZeroUsage
                              : card.suspect
                                ? t.suspectCount(1)
                                : card.estimated
                                  ? t.estimatedCount(1)
                                  : t.costNotReported}
                        </span>
                      )}
                    </td>
                  ) : null}
                  <td className="num">
                    {formatTokens(card.tokens)}
                    {card.estimated || card.missing || card.zeroUsage || card.suspect ? (
                      <span
                        className="ins-mark"
                        title={
                          card.suspect
                            ? t.suspectSeparate(formatTokens(card.suspectTokens))
                            : card.missing
                              ? t.missingCount(1)
                              : card.zeroUsage
                                ? t.zeroUsageCount(1)
                                : t.estimatedCount(1)
                        }
                      >
                        {card.suspect
                          ? "!"
                          : card.missing
                            ? "○"
                            : card.zeroUsage
                              ? "0"
                              : "≈"}
                      </span>
                    ) : null}
                  </td>
                  {/* A card whose agents reported no execution time shows the
                      time it stayed open instead, labeled, never as work. */}
                  <td className="num">
                    {card.durationMs > 0 || card.elapsedMs === 0 ? (
                      formatDuration(card.durationMs)
                    ) : (
                      <span className="ins-dim">
                        {t.elapsedTag(formatElapsed(card.elapsedMs))}
                      </span>
                    )}
                  </td>
                  <td className="num">{card.attempts}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <CardFootnote cards={cards} pricingEnabled={pricingEnabled} t={t} />
    </>
  );
}
