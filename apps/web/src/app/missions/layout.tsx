import type { ReactNode } from "react";
import { GlobalBar } from "../../components/global-bar/global-bar";
import "../../styles/nebula.css";
import "../../styles/missions.css";

export default function MissionsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <GlobalBar current="missions" />
      {children}
    </>
  );
}
