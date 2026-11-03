"use client";

import { useActionState, useEffect, useState } from "react";
import { emergencyLoginAction, type AuthState } from "../../../actions/auth";
import { dict } from "../../../lib/i18n";

/**
 * The token rides after the `#`, which the browser never sends: it is read
 * here, posted once with the button, and wiped from the address bar so it
 * does not sit in history.
 */
export function EmergencyForm({ lang }: { lang: string }) {
  const t = dict(lang);
  const [token, setToken] = useState("");
  const [state, action, pending] = useActionState<AuthState, FormData>(
    emergencyLoginAction,
    null,
  );

  useEffect(() => {
    setToken(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      {state?.error ? (
        <p className="auth-err" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn-next" type="submit" disabled={pending || !token}>
        {pending ? t.auth.signingIn : t.auth.emergencyEnter}
      </button>
    </form>
  );
}
