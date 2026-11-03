"use client";

import { LoginCodeForm } from "./login-code-form";

/**
 * The one way in: a code sent to the address (no password, since the owner's
 * call of 2026-11-03). An instance that cannot send mail has no way in from
 * this screen at all, so it says that instead of offering a form that only
 * fails once the address is typed; the server owner's way in is then the
 * emergency link (deploy/README.md).
 */
export function LoginForm({
  lang,
  codeEnabled,
  unavailable,
}: {
  lang: string;
  /** Whether this instance can send the code; the server decides. */
  codeEnabled: boolean;
  /** What the screen says when it cannot. */
  unavailable: string;
}) {
  if (!codeEnabled) {
    return (
      <p className="auth-err" role="alert">
        {unavailable}
      </p>
    );
  }
  return <LoginCodeForm lang={lang} />;
}
