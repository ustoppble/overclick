import { redirect } from "next/navigation";
import { getSession } from "../../lib/cookies";
import { settingsTabDestination } from "../../lib/redirects";
import { pagePrincipal } from "../../lib/web-scope";

export const dynamic = "force-dynamic";

/**
 * `/settings` is no longer a page: it is the old `?tab=` links finding their
 * group (E5, F11). One hop, decided here because the server knows the role:
 * the admin lands on the group that holds the tab, the member on Meu agente.
 * Temporary (307), and it stays so (E4): the destination depends on who asks
 * (admin, member, nobody signed in), and a browser keeps a 308 for every
 * reader of that machine.
 */
export default async function SettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const principal = await pagePrincipal(session);
  const { tab } = await searchParams;
  redirect(settingsTabDestination(tab, principal.role === "admin" ? "admin" : "member"));
}
