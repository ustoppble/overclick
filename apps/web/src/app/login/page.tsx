import { canCreateFirstAdmin } from "@agent-board/db";
import { redirect } from "next/navigation";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { emailConfigured } from "../../lib/email";
import { dict } from "../../lib/i18n";
import { countUsers } from "../../lib/instance";
import { APP_VERSION } from "../../lib/updates";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/home");

  const users = await countUsers();
  if (canCreateFirstAdmin(users)) redirect("/setup");

  const ws = await db().query.workspace.findFirst();
  const t = dict(ws?.language);

  return (
    <div className="nb nebula-surface nb-center nb-auth">
      <NebulaAtmosphere />
      <div className="stage">
        <div className="auth-shell">
          {/* The wide screen gets the one thing a person needs on the way in:
              what this is, and the facts that are the reason it runs on their
              own machine. Narrower than that it is hidden and the card is
              the whole screen, exactly as before. */}
          <aside className="auth-aside">
            <p className="auth-mark">
              over<span>click</span>
            </p>
            <p className="auth-lead">{t.auth.asideLead}</p>
            <ul className="auth-facts">
              <li>{t.auth.factHosted}</li>
              <li>{t.auth.factOpen}</li>
              <li>{t.auth.factAgents}</li>
            </ul>
          </aside>
          <div className="panel auth-card nebula-glass">
            <p className="brand">{t.auth.brand}</p>
            <h1>{t.auth.loginTitle}</h1>
            <p className="sub">{t.auth.loginSub}</p>
            {/* Decided here, on the server: an instance that cannot send mail
                says so instead of offering a way in that only fails after the
                address is typed. The action still answers a direct call with
                its own refusal. */}
            <LoginForm
              lang={ws?.language ?? "en"}
              codeEnabled={emailConfigured()}
              unavailable={t.auth.errCodeUnavailable}
            />
            <p className="foot">v{APP_VERSION} · {t.auth.foot}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
