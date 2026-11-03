"use client";

import { loginWithCodeAction, requestLoginCodeAction } from "../../actions/auth";
import { EmailCodeSteps } from "../../components/email-code-steps";
import { dict } from "../../lib/i18n";

/**
 * Sign-in by a code sent by email. The "sent" line is the server's neutral
 * answer, said the same way whether or not the address has an account.
 */
export function LoginCodeForm({ lang }: { lang: string }) {
  const t = dict(lang);
  return (
    <EmailCodeSteps
      lang={lang}
      idPrefix="code"
      requestAction={requestLoginCodeAction}
      verifyAction={loginWithCodeAction}
      intro={t.auth.codeIntro}
      sentLine={t.auth.codeSent}
      submit={t.auth.signIn}
      submitting={t.auth.signingIn}
    />
  );
}
