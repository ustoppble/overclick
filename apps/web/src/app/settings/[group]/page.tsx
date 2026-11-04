import { notFound, redirect } from "next/navigation";
import { getSession } from "../../../lib/cookies";
import { pagePrincipal } from "../../../lib/web-scope";
import { MEMBER_DESTINATION } from "../../../lib/redirects";
import { isSettingsGroup, settingsGroupDestination, type SettingsPlace } from "../groups";
import { SettingsPage } from "../settings-page";

export const dynamic = "force-dynamic";

/**
 * `/settings/<group>`. A group with no sections (Organizações e projetos,
 * Preços) is a page; a group with sections has no page that stacks them and
 * opens on its first one. Temporary (307), like `/settings?tab=`: it comes
 * after the member check, so where it lands depends on who asks. An old
 * `#anchor` rides the redirect in the browser and the menu forwards it.
 */
export default async function SettingsGroupPage({
  params,
}: {
  params: Promise<{ group: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { group } = await params;
  const principal = await pagePrincipal(session);
  // A member has no Settings: their one place is their own agent.
  if (principal.role !== "admin") redirect(MEMBER_DESTINATION);
  if (!isSettingsGroup(group)) notFound();

  const first = settingsGroupDestination(group);
  if (first) redirect(first);

  // No sections: the group is the page.
  return <SettingsPage userId={session.userId} place={group as SettingsPlace} />;
}
