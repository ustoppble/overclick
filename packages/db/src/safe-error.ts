import { randomUUID } from "node:crypto";

/**
 * What a log line may say about a failed operation: the operation, the kind of
 * error, its driver code and a reference to find the event. A driver error's
 * message carries the failed SQL, its parameters and often a person's data, and
 * its stack names paths, so none of them is ever printed.
 */
const CODE = /^[A-Z0-9_]{3,24}$/;
const TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function codeOf(error: unknown): string | null {
  // The driver error is often wrapped (query error -> postgres error); the
  // code lives on the innermost one that has it.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CODE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function describeError(
  operation: string,
  error: unknown,
  ref: string = randomUUID().slice(0, 8),
): string {
  const name = error instanceof Error && TYPE.test(error.name) ? error.name : "unknown";
  return `operation=${operation} type=${name} code=${codeOf(error) ?? "none"} ref=${ref}`;
}
