import { permanentRedirect } from "next/navigation";
import { insightsDestination } from "../../lib/redirects";

/**
 * Insights is Consumo now (E5). A link from before lands on /usage with the
 * filter it carried: one hop, 308 since E4.
 */
export default async function InsightsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  permanentRedirect(insightsDestination(await searchParams));
}
