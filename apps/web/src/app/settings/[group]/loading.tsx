import { NebulaAtmosphere } from "../../../components/nebula-atmosphere";
import { SettingsSkeleton } from "../settings-skeleton";

/**
 * Route-level loading fallback for /settings/<group>.
 */
export default function SettingsLoading() {
  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />
      <SettingsSkeleton />
    </div>
  );
}
