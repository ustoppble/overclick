import type { ReactNode } from "react";
import { GlobalBar } from "../../components/global-bar/global-bar";
import "../../styles/nebula.css";
import "./insights.css";

export default function InsightsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <GlobalBar current="usage" />
      {children}
    </>
  );
}
