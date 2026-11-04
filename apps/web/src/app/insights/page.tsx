import { redirect } from "next/navigation";
import { insightsDestination } from "../../lib/redirects";

/**
 * Insights is Consumo now (E5). A link from before lands on /usage with the
 * filter it carried: one hop, 307 in this release.
 */
export default async function InsightsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(insightsDestination(await searchParams));
}
