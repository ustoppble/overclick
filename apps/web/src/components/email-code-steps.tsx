"use client";

import { useActionState, useState } from "react";
import { dict } from "../lib/i18n";

type CodeRequestState = { sent: true } | { error: string } | null;
type VerifyState = { error: string } | null;

/**
 * Proving an address with a code it was sent, in two steps on the same card:
 * the address, then the six digits. Every way into the board goes through it
 * — signing in, setting up the first admin, accepting an invitation — and
 * only the two actions and the words differ. `hidden` rides along with both
 * steps (the invitation's token). The "sent" line is whatever the server's
 * step one stands for; for signing in and for invitations it is said the same
 * way whether or not the address is the right one.
 */
export function EmailCodeSteps({
  lang,
  idPrefix,
  requestAction,
  verifyAction,
  hidden = {},
  intro,
  sentLine,
  submit,
  submitting,
}: {
  lang: string;
  idPrefix: string;
  requestAction: (prev: CodeRequestState, formData: FormData) => Promise<CodeRequestState>;
  verifyAction: (prev: VerifyState, formData: FormData) => Promise<VerifyState>;
  hidden?: Record<string, string>;
  intro: string;
  sentLine: (email: string) => string;
  submit: string;
  submitting: string;
}) {
  const t = dict(lang);
  const [email, setEmail] = useState("");
  const [requested, request, requesting] = useActionState<CodeRequestState, FormData>(
    async (prev, formData) => {
      setEmail(String(formData.get("email") ?? "").trim());
      return requestAction(prev, formData);
    },
    null,
  );
  const [state, verify, verifying] = useActionState<VerifyState, FormData>(verifyAction, null);
  // Asking again (another code, or a typo in the address) goes back to the
  // first step and sets the previous answer aside; the next ask's answer is
  // a new object, so it shows again on its own.
  const [dismissed, setDismissed] = useState<CodeRequestState>(null);
  const current = requested === dismissed ? null : requested;

  const sent = current !== null && "sent" in current;
  const requestError = current !== null && "error" in current ? current.error : null;
  const hiddenInputs = Object.entries(hidden).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));

  if (!sent) {
    return (
      <form action={request}>
        <p className="auth-rule">{intro}</p>
        {hiddenInputs}
        <div className="field">
          <label htmlFor={`${idPrefix}-email`}>
            <span>{t.auth.email}</span>
          </label>
          <input
            id={`${idPrefix}-email`}
            className="input"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            defaultValue={email}
            aria-invalid={requestError ? true : undefined}
            aria-describedby={requestError ? `${idPrefix}-request-error` : undefined}
          />
        </div>
        {requestError ? (
          <p className="auth-err" id={`${idPrefix}-request-error`} role="alert">
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
        {sentLine(email)}
      </p>
      {hiddenInputs}
      <input type="hidden" name="email" value={email} />
      <div className="field">
        <label htmlFor={`${idPrefix}-digits`}>
          <span>{t.auth.code}</span>
        </label>
        <input
          id={`${idPrefix}-digits`}
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
          aria-describedby={state?.error ? `${idPrefix}-error` : undefined}
        />
      </div>
      {state?.error ? (
        <p className="auth-err" id={`${idPrefix}-error`} role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn-next" type="submit" disabled={verifying}>
        {verifying ? submitting : submit}
      </button>
      <button className="auth-switch" type="button" onClick={() => setDismissed(requested)}>
        {t.auth.codeResend}
      </button>
    </form>
  );
}
