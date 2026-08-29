import type { ReactNode } from "react";
import "../../styles/nebula.css";
/**
 * The Insights sheet, on purpose. This page is the same kind of surface — a
 * read-only report of tiles and panels — and a second sheet declaring the same
 * tiles is where two visual languages start drifting from one design.
 */
import "../insights/insights.css";

export default function OrganizationsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
