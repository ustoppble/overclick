/**
 * The one place the "manage" capability is named.
 *
 * The MCP refusal used to invent its own wording ("tick 'can manage the
 * workspace'") while Settings rendered a different sentence, so a user who
 * read the error and went looking for that control found nothing and the
 * tool was, in practice, unreachable (OCL-136, issue #71). The English
 * checkbox copy and the refusal text now come from here, so the two cannot
 * drift again: change the label and the error changes with it.
 *
 * pt-BR still translates the label in the dictionary; the MCP surface answers
 * in English, so it quotes the English one, which is what the board shows a
 * user who never switched language.
 */

/** Visible text of the per-token checkbox in the token list. */
export const MANAGE_BADGE_EN = "manage";

/** Full label of the capability, on the new-token form and as the row title. */
export const MANAGE_LABEL_EN = "This token can change the workspace configuration";

/**
 * Where the human goes to grant it. Named once so the refusal cannot point at
 * a screen that no longer exists.
 */
export const MANAGE_SETTINGS_PATH = "Settings › MCP tokens";

/**
 * What an MCP tool says when the token lacks the flag. It names the exact
 * control, in the exact place, for the exact token, because the alternative
 * is what OCL-136 reported: a permission the UI had no way to give.
 */
export function manageDenialMessage(tool: string, tokenLabel?: string | null): string {
  const which = tokenLabel?.trim() ? ` ("${tokenLabel.trim()}")` : "";
  return (
    `This token cannot change the workspace configuration, so ${tool} is refused. ` +
    `In ${MANAGE_SETTINGS_PATH}, find this token${which} in the list and tick the ` +
    `"${MANAGE_BADGE_EN}" box on its row (full label: "${MANAGE_LABEL_EN}"), ` +
    `or use a token that already has it. A token created by pairing starts without ` +
    `the flag, so this is the way to grant it after install.`
  );
}
