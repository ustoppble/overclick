import { PROJECT_CONTEXT_MAX_CHARS } from "@agent-board/mcp-core";

/**
 * The organization briefing is bounded by the same limit as the project one:
 * both are markdown handed whole to an agent at claim, and a business rule
 * that does not fit in 32 000 characters is a document, not a briefing.
 *
 * It lives here, and not next to the server action that enforces it, because
 * a "use server" module may only export async functions.
 */
export const ORGANIZATION_CONTEXT_MAX_CHARS = PROJECT_CONTEXT_MAX_CHARS;
