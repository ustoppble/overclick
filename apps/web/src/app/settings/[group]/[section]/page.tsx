import { notFound, redirect } from "next/navigation";
import { getSession } from "../../../../lib/cookies";
import { pagePrincipal } from "../../../../lib/web-scope";
import { MEMBER_DESTINATION } from "../../../../lib/redirects";
import { isSettingsGroup, settingsSectionOf } from "../../groups";
import { SettingsPage } from "../../settings-page";

export const dynamic = "force-dynamic";

/**
 * `/settings/<group>/<section>`: one item of the Settings menu, alone on its
 * page. A section answers only under its own group.
 */
export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ group: string; section: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { group, section } = await params;
  const principal = await pagePrincipal(session);
  // A member has no Settings: their one place is their own agent.
  if (principal.role !== "admin") redirect(MEMBER_DESTINATION);
  const place = isSettingsGroup(group) ? settingsSectionOf(group, section) : null;
  if (!place) notFound();

  return <SettingsPage userId={session.userId} place={place} />;
}
