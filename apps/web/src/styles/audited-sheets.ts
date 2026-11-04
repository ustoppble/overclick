import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

/**
 * The component sheets the style guards audit — the single list every guard
 * (`tokens.test.ts`, `type-ramp.test.ts`, `naked-element-selectors.test.ts`)
 * reads from, so "which sheets are covered" has one answer (OCL-89, item 3:
 * `app/globals.css` joins this list — it is the file whose bare `label`
 * selector broke the Filtros panel, see `naked-element-selectors.test.ts`).
 */
export const COMPONENT_SHEETS: Record<string, string> = {
  "styles/nebula.css": read("nebula.css"),
  // Navigation plan E1: the global bar, the status mark, the review list and
  // the attention amber's closed list, in a sheet of their own.
  "styles/global-bar.css": read("global-bar.css"),
  "app/usage/insights.css": read("../app/usage/insights.css"),
  "app/usage/usage-tabs.css": read("../app/usage/usage-tabs.css"),
  "app/settings/settings-groups.css": read("../app/settings/settings-groups.css"),
  "app/settings/project-context.module.css": read(
    "../app/settings/project-context.module.css",
  ),
  "app/globals.css": read("../app/globals.css"),
};

/**
 * globals.css predates the `--oc-*` system: it is the auth/login shell and
 * keeps its own local custom properties (`--bg`, `--fg`, ...), not the
 * board's design-token contract. It is audited by every guard above, but is
 * exempt, explicitly, from the two `tokens.test.ts` checks that assume the
 * `--oc-*` contract: no component owns a colour literal, and every token
 * asked for is one the base theme declares. A future migration of the auth
 * shell onto `--oc-*` removes this entry.
 */
export const LEGACY_LOCAL_TOKEN_SHEETS = new Set(["app/globals.css"]);
