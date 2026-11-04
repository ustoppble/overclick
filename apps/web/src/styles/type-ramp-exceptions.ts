/**
 * Known type-ramp deviations (ux-v2 §2), frozen at OCL-89 and re-synced
 * after the parallel visual-fix cards in this mission landed.
 *
 * The board is mid-migration to the ux-v2 doctrine (OCL-34/35/36/37 and
 * the parallel visual-fix cards, e.g. OCL-83/85/92/93/94).
 * Every entry below is a real, currently-shipping font-size outside
 * 22/16/13/12px, captured so the guard (`type-ramp.test.ts`) can stay
 * green without pretending the migration is finished.
 *
 * This list only shrinks. Deleting an entry here is how a fix card proves
 * its work — the guard's second test fails if an entry lingers after the
 * CSS underneath it is gone. Adding an entry for a *new* violation is a
 * regression, not a fix, and should not happen without a doctrine
 * amendment (see docs/design/amendments.md).
 */
export const KNOWN_TYPE_RAMP_EXCEPTIONS: { file: string; selector: string; value: string }[] = [
  // app/globals.css
  { file: "app/globals.css", selector: ".meta", value: "14px" },
  { file: "app/globals.css", selector: "h1", value: "28px" },
  // app/usage/insights.css
  { file: "app/usage/insights.css", selector: ".nb .ins-empty-title", value: "15px" },
  { file: "app/usage/insights.css", selector: ".nb .ins-table td", value: "12.5px" },
  { file: "app/usage/insights.css", selector: ".nb .ins-tile .ins-num", value: "19px" },
  { file: "app/usage/insights.css", selector: ".nb .ins-tile .ins-num", value: "24px" },
  { file: "app/usage/insights.css", selector: ".nb .ins-tile .ins-num", value: "28px" },
  // styles/nebula.css
  { file: "styles/nebula.css", selector: ".nb .btn-back", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .btn-new", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-btn-pri", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-btn-sec", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-check-step", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-close", value: "15px" },
  { file: "styles/nebula.css", selector: ".nb .d-mission", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-sec .md,\n.nb .md", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-sec p", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .d-textarea", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .detail h3", value: "18px" },
  { file: "styles/nebula.css", selector: ".nb .detail h3", value: "20px" },
  { file: "styles/nebula.css", selector: ".nb .sk-detail h3", value: "20px" },
  { file: "styles/nebula.css", selector: ".nb .input", value: "13.5px" },
  { file: "styles/nebula.css", selector: ".nb .input.mono", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .logo", value: "15px" },
  { file: "styles/nebula.css", selector: ".nb .md h3,\n.nb .md-h", value: "17px" },
  { file: "styles/nebula.css", selector: ".nb .mission-header h1", value: "21px" },
  { file: "styles/nebula.css", selector: ".nb .page-sub", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .plug-lead", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .policy .act", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .recipe textarea.input", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .release-header h1", value: "21px" },
  { file: "styles/nebula.css", selector: ".nb .release-usage b", value: "14px" },
  { file: "styles/nebula.css", selector: ".nb .upd-state", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .upd-step", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .werr", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .wok", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb .wstep h2", value: "21px" },
  { file: "styles/nebula.css", selector: ".nb .wstep h2", value: "26px" },
  { file: "styles/nebula.css", selector: ".nb h1", value: "21px" },
  { file: "styles/nebula.css", selector: ".nb h1", value: "24px" },
  { file: "styles/nebula.css", selector: ".nb-auth .auth-err", value: "12.5px" },
  { file: "styles/nebula.css", selector: ".nb-auth .auth-lead", value: "30px" },
  { file: "styles/nebula.css", selector: ".nb-auth .auth-mark", value: "15px" },
  { file: "styles/nebula.css", selector: ".nb-auth h1", value: "26px" },
];
