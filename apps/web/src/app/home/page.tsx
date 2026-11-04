import { redirect } from "next/navigation";
import { homeDestination } from "../../lib/redirects";

export const dynamic = "force-dynamic";

/**
 * The board moved to /board (navigation plan E3). Links to /home are in
 * bookmarks, histories and messages: each goes where it meant, in one hop.
 * Temporary (307) in this release, permanent (308) in the next.
 */
export default async function OldHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(homeDestination(await searchParams));
}
