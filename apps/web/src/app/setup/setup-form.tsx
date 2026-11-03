"use client";

import { requestSetupCodeAction, signupAction } from "../../actions/auth";
import { EmailCodeSteps } from "../../components/email-code-steps";
import { dict } from "../../lib/i18n";

/** The first admin's address, proved with a code before the account exists. No password. */
export function SetupForm({ lang }: { lang: string }) {
  const t = dict(lang);
  return (
    <EmailCodeSteps
      lang={lang}
      idPrefix="setup"
      requestAction={requestSetupCodeAction}
      verifyAction={signupAction}
      intro={t.auth.setupIntro}
      sentLine={t.auth.setupSent}
      submit={t.auth.createAccount}
      submitting={t.auth.creating}
    />
  );
}
