import { NebulaAtmosphere } from "../../../components/nebula-atmosphere";
import { db } from "../../../lib/db";
import { dict } from "../../../lib/i18n";
import { APP_VERSION } from "../../../lib/updates";
import { EmergencyForm } from "./emergency-form";

export const dynamic = "force-dynamic";

/** Where the link `pnpm emergency-login` writes lands (see deploy/README.md). */
export default async function EmergencyLoginPage() {
  const ws = await db().query.workspace.findFirst();
  const t = dict(ws?.language);

  return (
    <div className="nb nebula-surface nb-center nb-auth">
      <NebulaAtmosphere />
      <div className="stage">
        <div className="auth-shell">
          <div className="panel auth-card nebula-glass">
            <p className="brand">{t.auth.brand}</p>
            <h1>{t.auth.emergencyTitle}</h1>
            <p className="sub">{t.auth.emergencySub}</p>
            <EmergencyForm lang={ws?.language ?? "en"} />
            <p className="foot">v{APP_VERSION} · {t.auth.foot}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
