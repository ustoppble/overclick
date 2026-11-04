import { permanentRedirect } from "next/navigation";
import { ORGANIZATIONS_DESTINATION } from "../../lib/redirects";

/**
 * The read-only Organizations page is gone (E5): the numbers are in Consumo and
 * the editing is in Settings. One hop, 308 since E4.
 */
export const dynamic = "force-dynamic";

export default function OrganizationsRedirect() {
  permanentRedirect(ORGANIZATIONS_DESTINATION);
}
