import type { ReactNode } from "react";
import { GlobalBar } from "../../components/global-bar/global-bar";
import "../../styles/nebula.css";
import "./settings-groups.css";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <GlobalBar current="settings" />
      {children}
    </>
  );
}
