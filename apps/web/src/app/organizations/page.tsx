import { redirect } from "next/navigation";
import { ORGANIZATIONS_DESTINATION } from "../../lib/redirects";

/**
 * The read-only Organizations page is gone (E5): the numbers are in Consumo and
 * the editing is in Settings. One hop, 307 in this release.
 */
export default function OrganizationsRedirect() {
  redirect(ORGANIZATIONS_DESTINATION);
}
