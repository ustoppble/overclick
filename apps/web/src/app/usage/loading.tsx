import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { InsightsSkeleton } from "./insights-skeleton";

/**
 * Route-level loading fallback for /usage.
 */
export default function InsightsLoading() {
  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />
      <InsightsSkeleton />
      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
