"use client";

import { useActionState, useState } from "react";
import {
  loginWithCodeAction,
  requestLoginCodeAction,
  type AuthState,
  type CodeRequestState,
} from "../../actions/auth";
import { dict } from "../../lib/i18n";

/**
 * Sign-in by a code sent by email, in two steps on the same card: the
 * address, then the six digits. The "sent" line is the server's neutral
 * answer, said the same way whether or not the address has an account.
 */
export function LoginCodeForm({ lang }: { lang: string }) {
  const t = dict(lang);
  const [email, setEmail] = useState("");
  const [requested, request, requesting] = useActionState<
    CodeRequestState,
    FormData
  >(async (prev, formData) => {
    setEmail(String(formData.get("email") ?? "").trim());
    return requestLoginCodeAction(prev, formData);
  }, null);
  const [state, verify, verifying] = useActionState<AuthState, FormData>(
    loginWithCodeAction,
    null,
  );
  // Asking again (another code, or a typo in the address) goes back to the
  // first step and sets the previous answer aside; the next ask's answer is
  // a new object, so it shows again on its own.
  const [dismissed, setDismissed] = useState<CodeRequestState>(null);
  const current = requested === dismissed ? null : requested;

  const sent = current !== null && "sent" in current;
  const requestError = current !== null && "error" in current ? current.error : null;

  if (!sent) {
    return (
      <form action={request}>
        <p className="auth-rule">{t.auth.codeIntro}</p>
        <div className="field">
          <label htmlFor="code-email">
            <span>{t.auth.email}</span>
          </label>
          <input
            id="code-email"
            className="input"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            defaultValue={email}
            aria-invalid={requestError ? true : undefined}
            aria-describedby={requestError ? "code-request-error" : undefined}
          />
        </div>
        {requestError ? (
          <p className="auth-err" id="code-request-error" role="alert">
            {requestError}
          </p>
        ) : null}
        <button className="btn-next" type="submit" disabled={requesting}>
          {requesting ? t.auth.codeSending : t.auth.codeSend}
        </button>
      </form>
    );
  }

  return (
    <form action={verify}>
      <p className="auth-rule ok" role="status">
        {t.auth.codeSent(email)}
      </p>
      <input type="hidden" name="email" value={email} />
      <div className="field">
        <label htmlFor="code-digits">
          <span>{t.auth.code}</span>
        </label>
        <input
          id="code-digits"
          className="input"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          autoFocus
          required
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? "code-error" : undefined}
        />
      </div>
      {state?.error ? (
        <p className="auth-err" id="code-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn-next" type="submit" disabled={verifying}>
        {verifying ? t.auth.signingIn : t.auth.signIn}
      </button>
      <button className="auth-switch" type="button" onClick={() => setDismissed(requested)}>
        {t.auth.codeResend}
      </button>
    </form>
  );
}
