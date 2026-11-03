"use client";

import { acceptInvitationAction, requestInviteCodeAction } from "../../../actions/team";
import { EmailCodeSteps } from "../../../components/email-code-steps";
import { dict } from "../../../lib/i18n";

/**
 * The invited person types the address the invitation was made for and
 * proves it with the code sent there; only then does the account exist. No
 * password. The address is not printed: they type it.
 */
export function InviteForm({ token, lang }: { token: string; lang: string }) {
  const t = dict(lang);
  return (
    <EmailCodeSteps
      lang={lang}
      idPrefix="invite"
      requestAction={requestInviteCodeAction}
      verifyAction={acceptInvitationAction}
      hidden={{ token }}
      intro={t.auth.inviteIntro}
      sentLine={t.auth.inviteSent}
      submit={t.auth.inviteAccept}
      submitting={t.auth.inviteAccepting}
    />
  );
}
