import { redirect } from "next/navigation";
import { Icon } from "../../components/icon";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { Wordmark } from "../../components/wordmark";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import {
  formatDuration,
  formatElapsed,
  formatMoneyOrNone,
  formatTokens,
} from "../../lib/format";
import { dict } from "../../lib/i18n";
import { loadModelPrices } from "../../lib/prices";
import {
  loadOrganizationOverviews,
  type OrganizationOverview,
} from "../../lib/organizations-query";
import { organizationsCopy, type OrganizationsCopy } from "./copy";

export const dynamic = "force-dynamic";

/** "2 estimated · 1 usage not reported", or the all-clear. Never a silent sum. */
function honestyNote(
  totals: OrganizationOverview["totals"],
  t: OrganizationsCopy,
): string {
  const parts: string[] = [];
  if (totals.estimated > 0) parts.push(t.estimatedCount(totals.estimated));
  if (totals.missing > 0) parts.push(t.missingCount(totals.missing));
  return parts.length > 0 ? parts.join(" · ") : t.allReported;
}

function OrganizationSection({
  org,
  pricingEnabled,
  lang,
  t,
}: {
  org: OrganizationOverview;
  pricingEnabled: boolean;
  lang: "en" | "pt-BR";
  t: OrganizationsCopy;
}) {
  return (
    <section className="ins-panel nebula-glass" aria-label={org.name}>
      <div className="ins-cap">
        <span>{org.name}</span>
        {org.hasContext ? (
          <span className="ins-cap-note">ctx</span>
        ) : null}
      </div>

      <div className="ins-tiles">
        {/* Tokens and time first: they are true on every plan. Money is a
            layer this workspace switched on, or it is simply absent. */}
        <div className="ins-tile nebula-glass">
          <div className="ins-lbl">{t.totalTokens}</div>
          <div className="ins-num">{formatTokens(org.totals.tokens)}</div>
          <div className="ins-note">{honestyNote(org.totals, t)}</div>
        </div>
        <div className="ins-tile nebula-glass">
          <div className="ins-lbl">{t.totalTime}</div>
          <div className="ins-num">{formatDuration(org.totals.durationMs)}</div>
          {/* Time a card sat claimed is not time anyone worked, so it is
              named apart instead of swelling the number above. */}
          {org.totals.elapsedOnly > 0 ? (
            <div className="ins-note">
              {t.elapsedNote(
                formatElapsed(org.totals.elapsedMs),
                org.totals.elapsedOnly,
              )}
            </div>
          ) : null}
        </div>
        {pricingEnabled ? (
          <div className="ins-tile nebula-glass">
            <div className="ins-lbl">{t.totalCost}</div>
            {/* Nothing priced means no figure, not a figure of zero. */}
            <div className="ins-num">
              {formatMoneyOrNone(org.totals.costUsd, t.noCost, lang)}
            </div>
          </div>
        ) : null}
        <div className="ins-tile nebula-glass">
          <div className="ins-lbl">{t.attempts}</div>
          <div className="ins-num">{org.totals.attempts}</div>
        </div>
      </div>

      <div className="ins-cap">
        <span>{t.projects}</span>
        <span className="ins-cap-note">{org.projects.length}</span>
      </div>
      {org.projects.length === 0 ? (
        <p className="ins-cap-note">{t.noProjects}</p>
      ) : (
        <ul className="org-list">
          {org.projects.map((proj) => (
            <li key={proj.id}>
              {proj.name} <span className="ins-cap-note">({proj.idPrefix})</span>
            </li>
          ))}
        </ul>
      )}

      <div className="ins-cap">
        <span>{t.activeMissions}</span>
        <span className="ins-cap-note">{org.activeMissions.length}</span>
      </div>
      {org.activeMissions.length === 0 ? (
        <p className="ins-cap-note">{t.noMissions}</p>
      ) : (
        <ul className="org-list">
          {org.activeMissions.map((miss) => (
            <li key={miss.id}>{miss.title}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function OrganizationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");

  // Same rule as the board and the Insights page: no money layer, no price
  // table to read.
  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  const organizations = await loadOrganizationOverviews(
    db(),
    ws.id,
    ws.pricingEnabled,
    prices,
  );

  const shared = dict(ws.language);
  const t = organizationsCopy(ws.language);
  const lang = ws.language === "pt-BR" ? "pt-BR" : "en";

  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />

      <div className="page ins-page">
        <header className="ins-topbar-wrap">
          <div className="ins-topbar-l1">
            <Wordmark label={shared.board.homeLink} />
            <div className="spacer" />
            <a className="btn-ghost" href="/settings?tab=organizations">
              <Icon name="settings" label={null} size={14} />
              {t.manage}
            </a>
            <a className="btn-ghost ins-back" href="/home">
              <Icon name="back" label={null} size={14} />
              {t.backToBoard}
            </a>
          </div>
          <div className="ins-topbar-l2">
            <div className="crumb">
              {ws.name} / <b>{t.title}</b>
            </div>
          </div>
        </header>

        <header className="ins-head">
          <h1>{t.title}</h1>
          <p className="page-sub">{t.sub}</p>
        </header>

        {organizations.length === 0 ? (
          /* An empty page is a state, not a missing one: it says what is
             missing and where the thing that fills it is made. */
          <div className="ins-empty nebula-glass">
            <Icon name="empty" label={null} size={26} className="ins-empty-icon" />
            <p className="ins-empty-title">{t.empty}</p>
            <a className="btn-ghost ins-empty-cta" href="/settings?tab=organizations">
              <Icon name="settings" label={null} size={14} />
              {t.manage}
            </a>
          </div>
        ) : (
          organizations.map((org) => (
            <OrganizationSection
              key={org.id}
              org={org}
              pricingEnabled={ws.pricingEnabled}
              lang={lang}
              t={t}
            />
          ))
        )}
      </div>

      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
