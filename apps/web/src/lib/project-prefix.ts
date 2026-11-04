/**
 * The card prefix as the "+ Projeto" form checks it while it is typed (E5).
 * The rules are the ones `project_create` and the onboarding step run on the
 * server, which stays the last word: this only says it sooner.
 */

export type PrefixCheck =
  | { ok: true; prefix: string }
  | { ok: false; reason: "empty" | "invalid" }
  | { ok: false; reason: "taken"; owner: string };

/** 2 to 4 letters or digits: the same shape as `isValidPrefix` in mcp-core. */
const PREFIX_SHAPE = /^[A-Za-z0-9]{2,4}$/;

export function checkProjectPrefix(
  raw: string,
  projects: ReadonlyArray<{ name: string; idPrefix: string }>,
): PrefixCheck {
  const typed = raw.trim();
  if (!typed) return { ok: false, reason: "empty" };
  if (!PREFIX_SHAPE.test(typed)) return { ok: false, reason: "invalid" };
  const prefix = typed.toUpperCase();
  const owner = projects.find((p) => p.idPrefix.toUpperCase() === prefix);
  return owner ? { ok: false, reason: "taken", owner: owner.name } : { ok: true, prefix };
}
