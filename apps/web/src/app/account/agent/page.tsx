import { and, asc, desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { mcpToken, project } from "@agent-board/db";
import type { UpdateMode } from "@agent-board/db";
import { getSession } from "../../../lib/cookies";
import { db } from "../../../lib/db";
import { dict } from "../../../lib/i18n";
import { detectRuntime } from "../../../lib/runtime";
import { APP_VERSION, type UpdaterState } from "../../../lib/updates";
import { pagePrincipal } from "../../../lib/web-scope";
import { SettingsClient } from "../../settings/settings-client";

export const dynamic = "force-dynamic";

const EMPTY_UPDATER: UpdaterState = { running: false, lastSeenAt: null, status: null };

/** The request origin, for the commands and links Settings prints. */
async function requestOrigin(): Promise<{ host: string; origin: string }> {
  const h = await headers();
  const host = h.get("host") ?? "<your-host>";
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim()
    ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return { host, origin: `${proto}://${host}` };
}

/**
 * Meu agente (E5): the person's own tokens and the pairing with the Overclock
 * app. Nothing of the workspace configuration is read, so nothing of it can
 * reach the page even hidden. The admin sees here only the connections that
 * are theirs; everyone's are in Settings › Agents.
 */
async function MyAgent({
  ws,
  userId,
  organizationId,
  admin,
}: {
  admin: boolean;
  ws: { id: string; name: string; language: string; updateMode: UpdateMode; claimTimeoutMinutes: number };
  userId: string;
  organizationId: string | null;
}) {
  const tokens = await db()
    .select({
      id: mcpToken.id,
      label: mcpToken.label,
      tokenPrefix: mcpToken.tokenPrefix,
      canManage: mcpToken.canManage,
      revoked: mcpToken.revoked,
      lastUsedAt: mcpToken.lastUsedAt,
      createdAt: mcpToken.createdAt,
    })
    .from(mcpToken)
    .where(and(eq(mcpToken.workspaceId, ws.id), eq(mcpToken.ownerUserId, userId)))
    .orderBy(desc(mcpToken.createdAt));
  const [proj] = organizationId
    ? await db()
        .select({ name: project.name })
        .from(project)
        .where(and(eq(project.workspaceId, ws.id), eq(project.organizationId, organizationId)))
        .orderBy(asc(project.createdAt))
        .limit(1)
    : [];
  const { host, origin } = await requestOrigin();
  const t = dict(ws.language);

  return (
    <div className="nb nebula-surface">
      <SettingsClient
        isAdmin={false}
        team={null}
        host={host}
        origin={origin}
        workspaceName={ws.name}
        projectName={proj?.name ?? ws.name}
        organizations={[]}
        projects={[]}
        lang={ws.language}
        updateMode={ws.updateMode}
        updateLog={null}
        version={APP_VERSION}
        runtime={detectRuntime()}
        updater={EMPTY_UPDATER}
        enableCommand=""
        manualCommand=""
        sourceCommand=""
        prices={[]}
        unpricedModels={[]}
        unpricedRanModels={[]}
        recipes={[]}
        coverage={[]}
        pricingEnabled={false}
        claimTimeoutMinutes={ws.claimTimeoutMinutes}
        view="my-agent"
        tokens={tokens.map((t) => ({
          id: t.id,
          label: t.label,
          masked: `${t.tokenPrefix ?? "ocb_"}••••••••`,
          canManage: t.canManage,
          revoked: t.revoked,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        }))}
        footer={
          <div className="policy-note" style={{ borderTop: 0, paddingTop: 8 }}>
            <a href="/onboarding?step=2">{t.account.openOnboarding}</a>
            {admin ? (
              <>
                {" · "}
                {t.account.allConnections}{" "}
                <a href="/settings/agents/connections">{t.account.allConnectionsLink}</a>
              </>
            ) : null}
          </div>
        }
      />
    </div>
  );
}

export default async function AccountAgentPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const principal = await pagePrincipal(session);
  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  return (
    <MyAgent
      ws={ws}
      userId={principal.userId}
      organizationId={principal.organizationId}
      admin={principal.role === "admin"}
    />
  );
}
