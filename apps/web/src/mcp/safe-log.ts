import { randomUUID } from "node:crypto";

/**
 * What a log line may say about a failed tool call: the operation, the kind of
 * error, its driver code and a reference the agent can quote. A driver error's
 * message carries the failed SQL and its parameters (often a person's data) and
 * its stack names paths, so in production none of them is printed.
 */
const CODE = /^[A-Z0-9_]{3,24}$/;
const TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function codeOf(error: unknown): string | null {
  // Drivers wrap each other (query error -> postgres error): take the first code.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CODE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function newErrorRef(): string {
  return randomUUID().slice(0, 8);
}

export function describeError(operation: string, error: unknown, ref: string): string {
  const name = error instanceof Error && TYPE.test(error.name) ? error.name : "unknown";
  return `operation=${operation} type=${name} code=${codeOf(error) ?? "none"} ref=${ref}`;
}

/**
 * Raw diagnostics are a debugging aid that has to be asked for: a dedicated
 * variable, off by default, never honoured in production. Even then the text is
 * redacted — the parameters are cut, e-mails and token-like runs are masked —
 * so a dev log kept or shared by accident does not carry a person's data.
 */
const RAW_OPT_IN = "OVERCLICK_DEBUG_RAW_ERRORS";

function rawDiagnosticsAsked(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const value = process.env[RAW_OPT_IN]?.toLowerCase();
  return value === "1" || value === "true";
}

export function redactDiagnostic(text: string): string {
  return text
    .replace(/params?:[\s\S]*$/im, "params: ***")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@,;]+/g, "***")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "***");
}

function rawDiagnostic(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    parts.push(redactDiagnostic(current instanceof Error ? (current.stack ?? current.message) : String(current)));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\ncaused by: ");
}

/** The one place a thrown error is logged; the safe line is always what it prints. */
export function logToolFailure(operation: string, error: unknown, ref: string): void {
  const line = `[mcp] tool failed: ${describeError(operation, error, ref)}`;
  console.error(line);
  if (rawDiagnosticsAsked()) console.error(`[mcp] ${RAW_OPT_IN} (redacted) ref=${ref}\n${rawDiagnostic(error)}`);
}
