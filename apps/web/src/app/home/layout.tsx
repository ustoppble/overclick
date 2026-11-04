import type { ReactNode } from "react";
import { GlobalBar } from "../../components/global-bar/global-bar";
import "../../styles/nebula.css";

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <GlobalBar current="board" />
      {children}
    </>
  );
}
