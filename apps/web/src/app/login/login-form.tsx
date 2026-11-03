"use client";

import { useActionState, useState } from "react";
import { loginAction, type AuthState } from "../../actions/auth";
import { dict } from "../../lib/i18n";
import { LoginCodeForm } from "./login-code-form";

export function LoginForm({
  lang,
  codeEnabled,
}: {
  lang: string;
  /** Whether this instance can send the code; the server decides. */
  codeEnabled: boolean;
}) {
  const [withCode, setWithCode] = useState(false);
  if (withCode && codeEnabled) {
    return <LoginCodeForm lang={lang} onUsePassword={() => setWithCode(false)} />;
  }
  return (
    <PasswordForm
      lang={lang}
      onUseCode={codeEnabled ? () => setWithCode(true) : null}
    />
  );
}

function PasswordForm({
  lang,
  onUseCode,
}: {
  lang: string;
  onUseCode: (() => void) | null;
}) {
  const t = dict(lang);
  const [state, action, pending] = useActionState<AuthState, FormData>(
    loginAction,
    null,
  );

  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="login-email">
          <span>{t.auth.email}</span>
        </label>
        <input
          id="login-email"
          className="input"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? "login-error" : undefined}
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">
          <span>{t.auth.password}</span>
        </label>
        <input
          id="login-password"
          className="input"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? "login-error" : undefined}
        />
      </div>
      {/* The failure belongs to the pair of fields above it, and it is
          announced: a sign-in that silently does nothing is the worst state
          this screen has. */}
      {state?.error ? (
        <p className="auth-err" id="login-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn-next" type="submit" disabled={pending}>
        {pending ? t.auth.signingIn : t.auth.signIn}
      </button>
      {onUseCode ? (
        <button className="auth-switch" type="button" onClick={onUseCode}>
          {t.auth.codeLink}
        </button>
      ) : null}
    </form>
  );
}
