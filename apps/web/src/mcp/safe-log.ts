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

/** The one place a thrown error is logged; production keeps to the safe line. */
export function logToolFailure(operation: string, error: unknown, ref: string): void {
  const line = `[mcp] tool failed: ${describeError(operation, error, ref)}`;
  if (process.env.NODE_ENV === "production") console.error(line);
  else console.error(line, error);
}
